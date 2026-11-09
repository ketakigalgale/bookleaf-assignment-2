// Builds the webhook body exactly as Bubble's API Connector sends it for one
// author: ids, numbers as text (an empty number is ""), dates formatted
// yyyy-mm-dd in IST, and platforms as one comma-separated string.

import { readFileSync } from 'node:fs';
import { runCodeNode } from './harness.mjs';

const dataset = JSON.parse(readFileSync(new URL('../../data/bookleaf_sample_data.json', import.meta.url), 'utf8'));

export const authorId = (index) => `1700000000000x${100 + index}`;
const asText = (v) => (v === null || v === undefined ? '' : String(v));

export const authors = dataset.authors.map((a, i) => ({
  code: a.author_id,
  name: a.name,
  id: authorId(i),
  raw: a,
}));

export const byCode = (code) => authors.find((a) => a.code === code);

export function payloadFor(code, { asOf = '', logId = '1700000000002x1', triggerType = 'Single' } = {}) {
  const a = byCode(code);
  return {
    log_id: logId,
    trigger_type: triggerType,
    requested_by: 'ops@bookleaf.test',
    as_of_date: asOf,
    author: { id: a.id, name: a.raw.name, email: a.raw.email },
    books: a.raw.books.map((b) => ({
      title: b.title,
      genre: b.genre,
      status: b.status,
      publication_date: asText(b.publication_date),
      mrp: asText(b.mrp),
      royalty_per_copy: asText(b.author_royalty_per_copy),
      copies_sold: asText(b.total_copies_sold),
      royalty_earned: asText(b.total_royalty_earned),
      royalty_paid: asText(b.royalty_paid),
      royalty_pending: asText(b.royalty_pending),
      last_payout_date: asText(b.last_royalty_payout_date),
      available_on: b.available_on.join(', '),
    })),
  };
}

export const CONFIG = {
  gemini_model: 'gemini-3.5-flash-lite',
  gemini_thinking_level: 'MINIMAL',
  overdue_after_days: 90,
  min_payout_threshold: 1000,
  payout_window_days: 45,
  email_mode: 'override',
  email_override_recipient: 'qa@bookleaf.test',
  email_from: 'BookLeaf Royalties <royalties@bookleaf.test>',
};

// Node outputs that build-royalty-facts.js reads, produced by running the
// real Validate Request node on the payload.
export async function factsNodes(code, asOf = '') {
  const [validated] = await runCodeNode('validate-request.js', {
    nodes: { 'Royalty Summary Webhook': [{ body: payloadFor(code, { asOf }) }] },
  });
  if (!validated.valid) throw new Error(`Fixture payload rejected: ${validated.error_message}`);
  return { 'Validate Request': [validated], Config: [CONFIG] };
}
