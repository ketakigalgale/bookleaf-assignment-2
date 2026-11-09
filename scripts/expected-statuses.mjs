// Prints the royalty badge every book should show, and the email scenario for
// every author, as of a given date. Uses the same Code-node logic n8n runs, so
// it doubles as the answer key when checking the Bubble badges by hand.
//
//   node scripts/expected-statuses.mjs              (as of today, IST)
//   node scripts/expected-statuses.mjs 2026-01-10   (as of a fixed date)

import { runCodeNode } from '../n8n/test/harness.mjs';
import { authors, factsNodes } from '../n8n/test/fixtures.mjs';

const asOf = process.argv[2];
if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error('Date must be YYYY-MM-DD');
  process.exit(1);
}

const BADGE = {
  paid_up: 'Green: paid up',
  no_earnings_yet: 'Green: nothing owed',
  pending_on_schedule: 'Yellow: pending, within cycle',
  below_threshold: 'Yellow: below Rs 1,000, rolls over',
  overdue: 'Red: overdue',
};

const rows = [];
let printedDate = '';
for (const a of authors) {
  const [facts] = await runCodeNode('build-royalty-facts.js', { nodes: await factsNodes(a.code, asOf ?? '') });
  printedDate = facts.as_of;
  for (const b of facts.book_statuses) {
    rows.push([a.code, a.name, b.title, BADGE[b.status], b.days_waiting ?? '', facts.scenario]);
  }
  for (const p of facts.ai_facts.books_in_production) {
    rows.push([a.code, a.name, p.title, `Grey: in production (${p.current_stage})`, '', facts.scenario]);
  }
  if (facts.data_warnings.length) console.warn(`${a.code} data warnings:`, facts.data_warnings);
}

console.log(`As of ${printedDate} (IST)\n`);
console.log('| Author | Name | Book | Badge | Days since last payout / publication | Email scenario |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.join(' | ')} |`);
