// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCodeNode } from './harness.mjs';
import { CONFIG, factsNodes, payloadFor } from './fixtures.mjs';

const JAN_10_2026 = '2026-01-10';
const LOG_ID = '1700000000002x1';

const validate = (body, staticData = {}) =>
  runCodeNode('validate-request.js', { nodes: { 'Royalty Summary Webhook': [{ body }] }, staticData }).then((r) => r[0]);

// ---- request validation ---------------------------------------------------

test('validate-request accepts the payload Bubble sends and normalises it', async () => {
  const out = await validate(payloadFor('AUTH007', { triggerType: 'Bulk' }));
  assert.equal(out.valid, true);
  assert.equal(out.trigger_type, 'Bulk');
  const inProduction = out.books.find((b) => b.title === 'Midnight in Mysore');
  assert.equal(inProduction.mrp, null); // "" from Bubble becomes null, not 0
  assert.equal(inProduction.copies_sold, 0);
  assert.deepEqual(out.books[0].available_on, ['Amazon India', 'Flipkart', 'Amazon US', 'BookLeaf Store']);
});

test('validate-request accepts books sent as a JSON string and numbers with commas', async () => {
  const body = payloadFor('AUTH001');
  body.books[0].royalty_earned = '11,970';
  body.books = JSON.stringify(body.books);
  const out = await validate(body);
  assert.equal(out.valid, true);
  assert.equal(out.books[0].royalty_earned, 11970);
});

test('validate-request rejects junk with a 400 and a readable reason', async () => {
  const out = await validate({ log_id: 'abc', trigger_type: 'Weekly', author: {}, books: 'not json' });
  assert.equal(out.valid, false);
  assert.equal(out.response_code, 400);
  assert.equal(out.status, 'Failed');
  for (const word of ['books', 'log_id', 'author.id', 'author.name', 'trigger_type']) {
    assert.match(out.error_message, new RegExp(word.replace('.', '\\.')));
  }
});

test('validate-request refuses to process the same log twice', async () => {
  const store = {};
  const first = await validate(payloadFor('AUTH001'), store);
  const again = await validate(payloadFor('AUTH001'), store);
  assert.equal(first.valid, true);
  assert.equal(again.valid, false);
  assert.equal(again.response_code, 409);
  assert.equal(again.status, 'Skipped');
  const other = await validate(payloadFor('AUTH001', { logId: '1700000000002x2' }), store);
  assert.equal(other.valid, true);
});

// ---- royalty facts --------------------------------------------------------

const facts = async (code, asOf = JAN_10_2026) =>
  (await runCodeNode('build-royalty-facts.js', { nodes: await factsNodes(code, asOf) }))[0];
const statusOf = (f, title) => f.book_statuses.find((b) => b.title === title).status;

test('facts: totals match the dataset and use Indian digit grouping', async () => {
  const f = await facts('AUTH002');
  assert.deepEqual(f.ai_facts.totals, {
    copies_sold: '2,079',
    royalty_earned: '₹84,024',
    royalty_paid: '₹71,000',
    royalty_pending: '₹13,024',
  });
});

test('facts: green / yellow / red per the 90-day rule (as of 10 Jan 2026)', async () => {
  const rohit = await facts('AUTH002');
  assert.equal(statusOf(rohit, 'Code & Karma'), 'overdue'); // last payout 1 Sep 2025, 131 days
  assert.equal(statusOf(rohit, 'Startup Sutra'), 'pending_on_schedule'); // 15 Nov 2025, 56 days
  assert.equal(rohit.scenario, 'overdue');

  const priya = await facts('AUTH001');
  assert.equal(statusOf(priya, 'The Saffron Diaries'), 'paid_up');
  assert.equal(priya.scenario, 'pending_on_schedule');
});

test('facts: never-paid book older than 90 days is overdue', async () => {
  const f = await facts('AUTH003');
  assert.equal(statusOf(f, 'Between Two Temples'), 'overdue');
  assert.equal(f.ai_facts.published_books[0].last_payout, 'No payout yet');
});

test('facts: balance under the Rs 1,000 minimum rolls over instead of going red', async () => {
  const f = await facts('AUTH009');
  assert.equal(statusOf(f, 'The Nagpur Notebooks'), 'below_threshold');
  assert.equal(f.scenario, 'below_threshold');
});

test('facts: in-production books are reported with their stage, not as earning books', async () => {
  const f = await facts('AUTH007');
  assert.deepEqual(f.ai_facts.books_in_production, [{
    title: 'Midnight in Mysore',
    genre: 'Thriller',
    current_stage: 'Cover Design',
    stage_position: 'stage 3 of 9',
    next_stage: 'Typesetting',
  }]);
  assert.equal(f.ai_facts.published_books.length, 2);
});

test('facts: fully paid author', async () => {
  const f = await facts('AUTH008');
  assert.equal(f.scenario, 'all_paid');
});

test('facts: next payout is the first quarter-end + 45 days on or after today', async () => {
  const jan = await facts('AUTH001');
  assert.equal(jan.ai_facts.payout.next_payout_deadline, '14 February 2026');
  assert.equal(jan.ai_facts.payout.quarter_covered_by_next_payout, 'October to December 2025');

  const nov = await facts('AUTH001', '2026-11-02');
  assert.equal(nov.ai_facts.payout.next_payout_deadline, '14 November 2026');

  const after = await facts('AUTH001', '2026-11-15');
  assert.equal(after.ai_facts.payout.next_payout_deadline, '14 February 2027');
});

test('facts: dates in other unambiguous formats are read as the same IST day', async () => {
  const nodes = await factsNodes('AUTH003', JAN_10_2026);
  nodes['Validate Request'][0].books[0].publication_date = 'Jul 5, 2024';
  const [f] = await runCodeNode('build-royalty-facts.js', { nodes });
  assert.equal(f.ai_facts.published_books[0].published_on, '5 July 2024');
});

test('facts: no PII beyond the name is sent to the model', async () => {
  const f = await facts('AUTH001');
  const sent = JSON.stringify(f.ai_facts);
  assert.ok(!sent.includes('@'));
  assert.ok(!sent.includes('+91'));
  assert.ok(!sent.includes('1700000000000x'));
});

// ---- prompt ---------------------------------------------------------------

async function prompt(code, asOf) {
  const f = await facts(code, asOf);
  const [req] = await runCodeNode('build-ai-request.js', { nodes: { Config: [CONFIG], 'Build Royalty Facts': [f] } });
  return { f, req, user: req.gemini_request.contents[0].parts[0].text };
}

test('prompt only carries the instructions that apply to this author', async () => {
  const farhan = await prompt('AUTH008');
  assert.match(farhan.user, /has been paid/);
  assert.doesNotMatch(farhan.user, /past BookLeaf's normal quarterly payout schedule/);
  assert.doesNotMatch(farhan.user, /production stages/);

  const rohit = await prompt('AUTH002');
  assert.match(rohit.user, /"Code & Karma" are past/);
  assert.match(rohit.user, /"Startup Sutra" are within the normal cycle/);

  const sneha = await prompt('AUTH007', '2026-11-02');
  assert.match(sneha.user, /production stages, in order/);
  assert.match(sneha.user, /"The Algorithm of Love" and "Ctrl\+Alt\+Delete My Ex" are past/);
});

test('prompt requests structured JSON output', async () => {
  const { req } = await prompt('AUTH001');
  assert.equal(req.gemini_request.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(req.gemini_request.generationConfig.thinkingConfig, { thinkingLevel: 'MINIMAL' });
});

// ---- output guardrails ----------------------------------------------------

const GOOD_BODY = `Dear Priya,

Here is your royalty summary as of 10 January 2026.

- Whispers of the Ganges: 342 copies sold, ₹11,970 earned, ₹8,400 paid, ₹3,570 pending. Last payout 15 October 2025.
- The Saffron Diaries: 189 copies sold, ₹7,938 earned, ₹7,938 paid, nothing pending. Last payout 1 December 2025.

Across both books you have earned ₹19,908, been paid ₹16,338, and ₹3,570 is pending. The pending amount is on track for the payout due by 14 February 2026, covering October to December 2025.

You can see the per-platform breakdown in your dashboard any time.

Warm regards,
Team BookLeaf`;

const geminiResponse = (payload, finishReason = 'STOP') => ({
  candidates: [{ content: { parts: [{ text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] }, finishReason }],
  usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 380 },
});

async function checkOutput(response, config = CONFIG) {
  const f = await facts('AUTH001');
  const [out] = await runCodeNode('validate-ai-output.js', {
    nodes: { Config: [config], 'Build Royalty Facts': [f], 'Build AI Request': [{ model: config.gemini_model }] },
    input: [response],
  });
  return out;
}

test('guardrails accept a faithful email and route it to the test inbox', async () => {
  const out = await checkOutput(geminiResponse({ subject: 'Your BookLeaf royalty summary', body: GOOD_BODY }));
  assert.deepEqual(out.problems, []);
  assert.equal(out.email.should_send, true);
  assert.equal(out.email.recipient, 'qa@bookleaf.test');
  assert.equal(out.ai_input_tokens, 1200);
});

test('guardrails catch an invented amount', async () => {
  const body = GOOD_BODY.replace('₹3,570 is pending', '₹3,750 is pending');
  const out = await checkOutput(geminiResponse({ subject: 'Your BookLeaf royalty summary', body }));
  assert.equal(out.ok, false);
  assert.match(out.problems.join(), /3,750/);
});

test('guardrails catch a missing book, truncation and broken JSON', async () => {
  const missing = await checkOutput(geminiResponse({ subject: 'Your BookLeaf royalty summary', body: GOOD_BODY.replaceAll('The Saffron Diaries', 'your memoir') }));
  assert.match(missing.problems.join(), /Saffron/);

  const truncated = await checkOutput(geminiResponse({ subject: 'Your BookLeaf royalty summary', body: GOOD_BODY }, 'MAX_TOKENS'));
  assert.match(truncated.problems.join(), /MAX_TOKENS/);

  const broken = await checkOutput(geminiResponse('{"subject": "Your royalty'));
  assert.match(broken.problems.join(), /valid JSON/);
});

test('email is skipped, not sent to dataset addresses, unless live mode is chosen', async () => {
  const off = await checkOutput(geminiResponse({ subject: 'Your BookLeaf royalty summary', body: GOOD_BODY }), { ...CONFIG, email_mode: 'off' });
  assert.equal(off.email.should_send, false);

  const noOverride = await checkOutput(geminiResponse({ subject: 'Your BookLeaf royalty summary', body: GOOD_BODY }), { ...CONFIG, email_override_recipient: '' });
  assert.equal(noOverride.email.should_send, false);
  assert.match(noOverride.email.skip_reason, /override/);
});

// ---- results returned to Bubble -----------------------------------------

const AI_OK = {
  ok: true, subject: 'S', body: 'B', ai_model: 'm', ai_input_tokens: 1, ai_output_tokens: 2,
  email: { should_send: true, recipient: 'qa@bookleaf.test', mode: 'override', skip_reason: '' },
};
const resultNodes = { 'Validate Request': [{ log_id: LOG_ID }], 'Validate AI Output': [AI_OK] };

test('success result reports email delivery separately from generation', async () => {
  const [sent] = await runCodeNode('build-success-result.js', { nodes: resultNodes, prevNode: 'Send Email (SMTP)', input: [{ accepted: ['qa@bookleaf.test'] }] });
  assert.equal(sent.status, 'Success');
  assert.equal(sent.email_delivery, 'Sent');
  assert.equal(sent.response_code, 200);

  const [failed] = await runCodeNode('build-success-result.js', { nodes: resultNodes, prevNode: 'Send Email (SMTP)', input: [{ error: { message: 'Invalid login' } }] });
  assert.equal(failed.status, 'Success');
  assert.equal(failed.email_delivery, 'Failed');
  assert.match(failed.error_message, /Invalid login/);

  const [skipped] = await runCodeNode('build-success-result.js', { nodes: resultNodes, prevNode: 'Send Email?', input: [AI_OK] });
  assert.equal(skipped.email_delivery, 'Skipped');
});

test('failure result names the failing step and still returns HTTP 200', async () => {
  const [ai] = await runCodeNode('build-failure-result.js', {
    nodes: { 'Validate Request': [{ log_id: LOG_ID }] },
    prevNode: 'Generate Email (Gemini)',
    input: [{ error: { message: 'Too Many Requests', httpCode: '429' } }],
  });
  assert.equal(ai.status, 'Failed');
  assert.equal(ai.response_code, 200);
  assert.equal(ai.error_stage, 'ai_generation');
  assert.match(ai.error_message, /^AI generation failed: 429 Too Many Requests/);

  const [guard] = await runCodeNode('build-failure-result.js', {
    nodes: { 'Validate Request': [{ log_id: LOG_ID }] },
    prevNode: 'AI Output OK?',
    input: [{ ok: false, problems: ['Amounts not in the source data: 3,750'] }],
  });
  assert.equal(guard.error_stage, 'ai_output_validation');
  assert.match(guard.error_message, /3,750/);
});
