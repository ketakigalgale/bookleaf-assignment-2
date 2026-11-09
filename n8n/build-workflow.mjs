// Assembles the importable n8n workflow from the Code-node sources in ./code,
// so the JavaScript that is unit-tested is byte-for-byte what n8n runs.
//
//   node n8n/build-workflow.mjs   ->   n8n/bookleaf-royalty-summary.workflow.json

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const code = (file) => readFileSync(new URL(`./code/${file}`, import.meta.url), 'utf8');

// Stable ids keep the exported JSON diff-friendly between builds.
const uuid = (seed) => {
  const h = createHash('md5').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const CREDENTIALS = {
  webhookKey: { httpHeaderAuth: { id: 'REPLACE_ME_webhook', name: 'BookLeaf Webhook Key' } },
  gemini: { httpHeaderAuth: { id: 'REPLACE_ME_gemini', name: 'Gemini API Key' } },
  smtp: { smtp: { id: 'REPLACE_ME_smtp', name: 'BookLeaf SMTP' } },
};

const ERROR_BRANCH = { onError: 'continueErrorOutput' };
const RETRY = (tries, waitMs) => ({ retryOnFail: true, maxTries: tries, waitBetweenTries: waitMs });

const nodes = [];
const node = (name, type, typeVersion, position, parameters, extra = {}) => {
  nodes.push({ parameters, id: uuid(name), name, type, typeVersion, position, ...extra });
};

const cfg = (key) => `$('Config').first().json.${key}`;

const ifNode = (name, position, leftValue) => node(name, 'n8n-nodes-base.if', 2, position, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [{
      id: uuid(`${name}-condition`),
      leftValue,
      rightValue: '',
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }],
    combinator: 'and',
  },
  options: {},
});

const codeNode = (name, position, file, extra = {}) =>
  node(name, 'n8n-nodes-base.code', 2, position, { jsCode: code(file) }, extra);

// ---- 1. Intake & validation ---------------------------------------------

node('Royalty Summary Webhook', 'n8n-nodes-base.webhook', 2, [0, 300], {
  httpMethod: 'POST',
  path: 'bookleaf/royalty-summary',
  authentication: 'headerAuth',
  responseMode: 'responseNode',
  options: {},
}, { webhookId: uuid('bookleaf-royalty-summary-webhook'), credentials: CREDENTIALS.webhookKey });

node('Config', 'n8n-nodes-base.set', 3.4, [220, 300], {
  assignments: {
    assignments: [
      ['gemini_model', 'gemini-3.5-flash-lite', 'string'],
      ['gemini_thinking_level', 'MINIMAL', 'string'],
      ['overdue_after_days', 90, 'number'],
      ['min_payout_threshold', 1000, 'number'],
      ['payout_window_days', 45, 'number'],
      ['email_mode', 'override', 'string'],
      ['email_override_recipient', '', 'string'],
      ['email_from', 'BookLeaf Royalties <royalties@your-domain.com>', 'string'],
    ].map(([name, value, type]) => ({ id: uuid(`config-${name}`), name, value, type })),
  },
  options: {},
}, { notesInFlow: true, notes: 'Edit after import. Policy values mirror Bubble AppSettings. No secrets here: keys live in n8n credentials.' });

codeNode('Validate Request', [440, 300], 'validate-request.js');
ifNode('Payload Valid?', [660, 300], '={{ $json.valid }}');

// ---- 2. Facts & AI generation ---------------------------------------------

codeNode('Build Royalty Facts', [880, 200], 'build-royalty-facts.js', ERROR_BRANCH);
codeNode('Build AI Request', [1100, 200], 'build-ai-request.js', ERROR_BRANCH);

node('Generate Email (Gemini)', 'n8n-nodes-base.httpRequest', 4.2, [1320, 200], {
  method: 'POST',
  url: '=https://generativelanguage.googleapis.com/v1beta/models/{{ $json.model }}:generateContent',
  authentication: 'genericCredentialType',
  genericAuthType: 'httpHeaderAuth',
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json.gemini_request) }}',
  options: { timeout: 20000 },
}, { credentials: CREDENTIALS.gemini, ...RETRY(2, 3000), ...ERROR_BRANCH });

codeNode('Validate AI Output', [1540, 200], 'validate-ai-output.js');
ifNode('AI Output OK?', [1760, 200], '={{ $json.ok }}');

// ---- 3. Delivery & response ------------------------------------------------

ifNode('Send Email?', [1980, 180], '={{ $json.email.should_send }}');

node('Send Email (SMTP)', 'n8n-nodes-base.emailSend', 2.1, [2200, 80], {
  fromEmail: `={{ ${cfg('email_from')} }}`,
  toEmail: '={{ $json.email.recipient }}',
  subject: '={{ $json.subject }}',
  emailFormat: 'text',
  text: '={{ $json.body }}',
  options: { appendAttribution: false },
}, { credentials: CREDENTIALS.smtp, ...RETRY(2, 2000), ...ERROR_BRANCH });

codeNode('Build Success Result', [2420, 200], 'build-success-result.js');
codeNode('Build Failure Result', [2420, 480], 'build-failure-result.js');

const RESPONSE_FIELDS = ['log_id', 'status', 'email_subject', 'email_body', 'email_delivery', 'email_recipient',
  'email_note', 'error_stage', 'error_message', 'ai_model', 'ai_input_tokens', 'ai_output_tokens', 'completed_at',
  'n8n_execution_id'];

node('Respond to Bubble', 'n8n-nodes-base.respondToWebhook', 1.1, [2660, 340], {
  respondWith: 'json',
  responseBody: `={{ JSON.stringify({ ${RESPONSE_FIELDS.map((f) => `${f}: $json.${f} ?? ${f.endsWith('tokens') ? 'null' : "''"}`).join(', ')} }) }}`,
  options: { responseCode: '={{ $json.response_code ?? 200 }}' },
});

// ---- Sticky notes ----------------------------------------------------------

const sticky = (name, position, width, height, color, content) =>
  node(name, 'n8n-nodes-base.stickyNote', 1, position, { content, height, width, color });

sticky('Note: Intake', [-60, -60], 900, 680, 7, `## 1. Intake, auth & validation
- **Webhook** only accepts requests carrying the shared \`X-BookLeaf-Key\` header (Header Auth credential). Anything else gets 403 before a node runs.
- Bubble's free plan cannot expose an API, so Bubble sends the author and their books **in the webhook body**. n8n never reads from Bubble.
- **Validate Request** checks and normalises that payload, and refuses a log id it has already processed (replay protection).
- Bad payload: **400**. Replay: **409**. Both carry a JSON body Bubble writes into the log.`);

sticky('Note: AI', [860, -60], 1100, 680, 6, `## 2. AI generation with guardrails
- **Build Royalty Facts** does all money and date maths (totals, 90-day overdue rule, Rs 1,000 roll-over, next quarter-end + 45-day payout date). The model never calculates.
- **Build AI Request** sends only the instructions relevant to this author's situation, and no email/phone/ids.
- **Generate Email** has a 20s timeout and one retry, so the whole run stays inside Bubble's API Connector timeout.
- **Validate AI Output** rejects the email if any rupee amount isn't in the source data, a book is missing, or output is truncated or malformed.`);

sticky('Note: Delivery', [1960, -60], 920, 760, 5, `## 3. Delivery & response
- Email is optional: \`email_mode\` = off | override (test inbox, default) | live.
- An SMTP failure does **not** fail the summary: status Success with email_delivery = Failed.
- Every path ends at **Respond to Bubble** with the same JSON shape. Bubble's backend workflow writes it into the NotificationLog.
- HTTP 200 means n8n ran; the \`status\` field (Success / Failed) is the outcome. Non-200 or no answer means the call itself failed, and Bubble marks the log Failed.`);

// ---- Connections ------------------------------------------------------------

const to = (...names) => names.map((name) => ({ node: name, type: 'main', index: 0 }));

const connections = {
  'Royalty Summary Webhook': { main: [to('Config')] },
  Config: { main: [to('Validate Request')] },
  'Validate Request': { main: [to('Payload Valid?')] },
  'Payload Valid?': { main: [to('Build Royalty Facts'), to('Respond to Bubble')] },
  'Build Royalty Facts': { main: [to('Build AI Request'), to('Build Failure Result')] },
  'Build AI Request': { main: [to('Generate Email (Gemini)'), to('Build Failure Result')] },
  'Generate Email (Gemini)': { main: [to('Validate AI Output'), to('Build Failure Result')] },
  'Validate AI Output': { main: [to('AI Output OK?')] },
  'AI Output OK?': { main: [to('Send Email?'), to('Build Failure Result')] },
  'Send Email?': { main: [to('Send Email (SMTP)'), to('Build Success Result')] },
  'Send Email (SMTP)': { main: [to('Build Success Result'), to('Build Success Result')] },
  'Build Success Result': { main: [to('Respond to Bubble')] },
  'Build Failure Result': { main: [to('Respond to Bubble')] },
};

// Sanity check: every connection points at a real node.
const names = new Set(nodes.map((n) => n.name));
for (const [from, { main }] of Object.entries(connections)) {
  if (!names.has(from)) throw new Error(`Unknown source node: ${from}`);
  for (const target of main.flat()) if (!names.has(target.node)) throw new Error(`Unknown target node: ${target.node}`);
}

const workflow = {
  name: 'BookLeaf: AI Royalty Summary',
  nodes,
  connections,
  active: false,
  settings: {
    executionOrder: 'v1',
    saveManualExecutions: true,
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
    executionTimeout: 60,
  },
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};

const out = new URL('./bookleaf-royalty-summary.workflow.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`Wrote ${nodes.length} nodes to ${out.pathname}`);
