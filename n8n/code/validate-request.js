// Validate Request
// Bubble's free plan cannot expose an API, so n8n has no way to read from
// Bubble. Bubble therefore sends everything the summary needs in the webhook
// body, and this node is the gate that checks it before any AI call is made.
// It also normalises the values: Bubble sends numbers as text (an empty
// number becomes "", which keeps the JSON valid for books in production).

const body = $('Royalty Summary Webhook').first().json.body ?? {};
const BUBBLE_ID = /^\d+x\d+$/; // Bubble unique ids look like 1718123456789x123456789012345678

const errors = [];
const text = (v) => (v === undefined || v === null ? '' : String(v).trim());
const number = (v) => {
  const s = text(v).replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) errors.push(`"${v}" is not a number`);
  return Number.isFinite(n) ? n : null;
};

let books = body.books;
if (typeof books === 'string') {
  try {
    books = JSON.parse(books);
  } catch {
    errors.push('books is not valid JSON');
    books = [];
  }
}
if (!Array.isArray(books)) {
  errors.push('books must be a list');
  books = [];
}

const author = body.author ?? {};
const logId = text(body.log_id);
const triggerType = text(body.trigger_type) || 'Single';

if (!BUBBLE_ID.test(logId)) errors.push('log_id must be a Bubble unique id');
if (!BUBBLE_ID.test(text(author.id))) errors.push('author.id must be a Bubble unique id');
if (!text(author.name)) errors.push('author.name is required');
if (!['Single', 'Bulk'].includes(triggerType)) errors.push('trigger_type must be "Single" or "Bulk"');

const normalisedBooks = books.map((b, i) => {
  if (!text(b?.title)) errors.push(`books[${i}].title is required`);
  if (!text(b?.status)) errors.push(`books[${i}].status is required`);
  const platforms = Array.isArray(b?.available_on)
    ? b.available_on
    : text(b?.available_on).split(',').map((p) => p.trim()).filter(Boolean);
  return {
    title: text(b?.title),
    genre: text(b?.genre),
    status: text(b?.status),
    publication_date: text(b?.publication_date),
    mrp: number(b?.mrp),
    royalty_per_copy: number(b?.royalty_per_copy),
    copies_sold: number(b?.copies_sold) ?? 0,
    royalty_earned: number(b?.royalty_earned) ?? 0,
    royalty_paid: number(b?.royalty_paid) ?? 0,
    royalty_pending: number(b?.royalty_pending) ?? 0,
    last_payout_date: text(b?.last_payout_date),
    available_on: platforms,
  };
});

// Replay protection: the same log id is never processed twice. Workflow
// static data only persists for executions of the active (production)
// workflow, which is the only place this matters.
let replay = false;
if (errors.length === 0) {
  const store = $getWorkflowStaticData('global');
  const now = Date.now();
  store.seenLogs = store.seenLogs ?? {};
  for (const [id, at] of Object.entries(store.seenLogs)) {
    if (now - at > 24 * 60 * 60 * 1000) delete store.seenLogs[id];
  }
  replay = Boolean(store.seenLogs[logId]);
  if (!replay) store.seenLogs[logId] = now;
}

const valid = errors.length === 0 && !replay;

return [{
  json: {
    valid,
    response_code: valid ? 200 : replay ? 409 : 400,
    status: valid ? '' : replay ? 'Skipped' : 'Failed',
    error_stage: valid ? '' : replay ? 'replay' : 'invalid_payload',
    error_message: replay ? `Log ${logId} was already processed` : errors.slice(0, 10).join('; '),
    log_id: logId,
    trigger_type: triggerType,
    requested_by: text(body.requested_by).slice(0, 200),
    as_of_date: text(body.as_of_date),
    author: { id: text(author.id), name: text(author.name), email: text(author.email) },
    books: normalisedBooks,
  },
}];
