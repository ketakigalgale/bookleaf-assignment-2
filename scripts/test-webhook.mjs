// Sends one author's data to the live n8n webhook exactly as Bubble will,
// and prints the response. Checks the workflow, the webhook key and the
// Gemini key before wiring up Bubble.
//
//   set N8N_WEBHOOK_URL=https://<you>.app.n8n.cloud/webhook/bookleaf/royalty-summary
//   set N8N_WEBHOOK_KEY=<the X-BookLeaf-Key secret>
//   node scripts/test-webhook.mjs AUTH007

import { byCode, payloadFor } from '../n8n/test/fixtures.mjs';

const { N8N_WEBHOOK_URL, N8N_WEBHOOK_KEY } = process.env;
const code = process.argv[2] ?? 'AUTH007';

if (!N8N_WEBHOOK_URL || !N8N_WEBHOOK_KEY) {
  console.error('Set N8N_WEBHOOK_URL and N8N_WEBHOOK_KEY first.');
  process.exit(1);
}
if (!byCode(code)) {
  console.error(`Unknown author code ${code}. Use AUTH001 to AUTH010.`);
  process.exit(1);
}

// A fresh Bubble-style log id every run, so n8n's replay check never blocks a test.
const logId = `${Date.now()}x${Math.floor(Math.random() * 1e15)}`;
const body = payloadFor(code, { logId });

const started = Date.now();
const res = await fetch(N8N_WEBHOOK_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-BookLeaf-Key': N8N_WEBHOOK_KEY },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(`HTTP ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

try {
  const json = JSON.parse(text);
  const { email_body: emailBody, ...rest } = json;
  console.log(JSON.stringify(rest, null, 2));
  if (emailBody) console.log(`\n----- email_body -----\n${emailBody}`);
} catch {
  console.log(text.slice(0, 2000));
}
