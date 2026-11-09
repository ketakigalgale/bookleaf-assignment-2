// Build Royalty Facts
// Turns the author and book data Bubble sent into one pre-computed fact sheet.
// Every amount, date and status the email mentions is worked out here,
// deterministically, so the model only writes prose around values it is
// given and never does arithmetic or date maths of its own.

const request = $('Validate Request').first().json;
const cfg = $('Config').first().json;
const author = request.author;
const books = request.books;

// Policy values mirror Bubble's AppSettings row (90 / 1,000 / 45) so the
// badges in Bubble and this email agree. as_of_date comes from AppSettings via
// the payload, so a demo date set in Bubble applies here too.
const OVERDUE_AFTER_DAYS = Number(cfg.overdue_after_days ?? 90);
const MIN_PAYOUT = Number(cfg.min_payout_threshold ?? 1000);
const PAYOUT_WINDOW_DAYS = Number(cfg.payout_window_days ?? 45);
const ESCALATION_HOURS = 48;

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const PUBLISHED = 'Published & Live';
const PRODUCTION_STAGES = ['Manuscript Received', 'Editing', 'Cover Design', 'Typesetting',
  'Proofreading', 'ISBN Assignment', 'Printing', 'Distribution Setup', PUBLISHED];

// Every date is reduced to an IST calendar day (as a UTC-midnight timestamp)
// before comparing. Bubble sends dates already formatted in IST as
// yyyy-mm-dd, which is taken as that calendar day directly; anything else
// (an instant, or another unambiguous format) is parsed and shifted to IST.
function istDay(value) {
  if (value === undefined || value === null || value === '') return null;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (ymd) return Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  const t = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + IST_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const formatDate = (day) => {
  const d = new Date(day);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const isoDate = (day) => new Date(day).toISOString().slice(0, 10);
const toNumber = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Indian digit grouping (1,23,456) without relying on the runtime's ICU data.
function groupIndian(n) {
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${n < 0 ? '-' : ''}${grouped}${dec === '00' ? '' : `.${dec}`}`;
}
const inr = (n) => `₹${groupIndian(n)}`;

// Royalties are calculated per calendar quarter and paid within
// PAYOUT_WINDOW_DAYS of the quarter ending. Returns the first payout deadline
// on or after `fromDay`, plus the quarter it covers.
function nextPayoutCycle(fromDay) {
  const year = new Date(fromDay).getUTCFullYear();
  for (let y = year - 1; y <= year + 1; y++) {
    for (const lastMonth of [2, 5, 8, 11]) {
      const quarterEnd = Date.UTC(y, lastMonth + 1, 0);
      const deadline = quarterEnd + PAYOUT_WINDOW_DAYS * DAY_MS;
      if (deadline >= fromDay) {
        const quarterStart = Date.UTC(y, lastMonth - 2, 1);
        return {
          deadline,
          quarterLabel: `${MONTHS[new Date(quarterStart).getUTCMonth()]} to ${MONTHS[lastMonth]} ${y}`,
          quarterEnd,
        };
      }
    }
  }
  throw new Error('Could not determine the next payout cycle');
}

const asOfDay = istDay(request.as_of_date) ?? istDay(Date.now());
const cycle = nextPayoutCycle(asOfDay);

const totalPending = books.reduce((sum, b) => sum + toNumber(b.royalty_pending), 0);
const belowThreshold = totalPending > 0 && totalPending < MIN_PAYOUT;

const published = [];
const inProduction = [];
const warnings = [];

const sorted = [...books].sort((a, b) =>
  (istDay(a.publication_date) ?? Infinity) - (istDay(b.publication_date) ?? Infinity)
  || String(a.title).localeCompare(String(b.title)));

for (const book of sorted) {
  const status = String(book.status ?? '');

  if (status !== PUBLISHED) {
    const stage = status.replace(/^In Production\s*-\s*/i, '').trim();
    const index = PRODUCTION_STAGES.indexOf(stage);
    inProduction.push({
      title: book.title,
      genre: book.genre ?? '',
      current_stage: stage || status || 'In production',
      stage_position: index >= 0 ? `stage ${index + 1} of ${PRODUCTION_STAGES.length}` : '',
      next_stage: index >= 0 && index < PRODUCTION_STAGES.length - 1 ? PRODUCTION_STAGES[index + 1] : '',
    });
    continue;
  }

  const earned = toNumber(book.royalty_earned);
  const paid = toNumber(book.royalty_paid);
  const pending = toNumber(book.royalty_pending);
  if (Math.abs(earned - paid - pending) > 0.01) {
    warnings.push(`${book.title}: earned (${earned}) is not paid (${paid}) + pending (${pending})`);
  }

  // The overdue clock starts at the last payout, or at publication if the
  // book has never been paid out.
  const lastPayoutDay = istDay(book.last_payout_date);
  const clockStart = lastPayoutDay ?? istDay(book.publication_date);
  const daysWaiting = clockStart === null ? null : Math.floor((asOfDay - clockStart) / DAY_MS);

  let payoutStatus;
  if (pending <= 0) payoutStatus = earned > 0 ? 'paid_up' : 'no_earnings_yet';
  else if (belowThreshold) payoutStatus = 'below_threshold';
  else if (daysWaiting !== null && daysWaiting > OVERDUE_AFTER_DAYS) payoutStatus = 'overdue';
  else payoutStatus = 'pending_on_schedule';

  published.push({
    title: book.title,
    genre: book.genre ?? '',
    published_on: istDay(book.publication_date) === null ? '' : formatDate(istDay(book.publication_date)),
    available_on: Array.isArray(book.available_on) ? book.available_on : [],
    copies_sold: groupIndian(toNumber(book.copies_sold)),
    royalty_per_copy: inr(toNumber(book.royalty_per_copy)),
    royalty_earned: inr(earned),
    royalty_paid: inr(paid),
    royalty_pending: inr(pending),
    last_payout: lastPayoutDay === null ? 'No payout yet' : formatDate(lastPayoutDay),
    payout_status: payoutStatus,
    _days_waiting: daysWaiting,
    _amounts: [earned, paid, pending, toNumber(book.royalty_per_copy), toNumber(book.mrp)],
  });
}

const sum = (field) => books.reduce((acc, b) => acc + toNumber(b[field]), 0);
const totals = {
  earned: sum('royalty_earned'),
  paid: sum('royalty_paid'),
  pending: totalPending,
  copies: sum('copies_sold'),
};

const titlesWith = (status) => published.filter((b) => b.payout_status === status).map((b) => b.title);
const overdueTitles = titlesWith('overdue');
const onScheduleTitles = titlesWith('pending_on_schedule');

let scenario;
if (published.length === 0) scenario = 'no_published_books';
else if (totals.pending <= 0) scenario = 'all_paid';
else if (belowThreshold) scenario = 'below_threshold';
else if (overdueTitles.length) scenario = 'overdue';
else scenario = 'pending_on_schedule';

const firstName = String(author.name ?? '').trim().split(/\s+/)[0] || 'there';

// Only what the email needs goes to the model: no email address, phone, ISBN
// or internal ids (data minimisation, and fewer tokens).
const aiFacts = {
  todays_date: formatDate(asOfDay),
  author_first_name: firstName,
  author_full_name: author.name ?? '',
  published_books: published.map(({ _days_waiting, _amounts, ...b }) => b),
  books_in_production: inProduction,
  totals: {
    copies_sold: groupIndian(totals.copies),
    royalty_earned: inr(totals.earned),
    royalty_paid: inr(totals.paid),
    royalty_pending: inr(totals.pending),
  },
  payout: {
    scenario,
    overdue_books: overdueTitles,
    on_schedule_books: onScheduleTitles,
    next_payout_deadline: formatDate(cycle.deadline),
    quarter_covered_by_next_payout: cycle.quarterLabel,
    minimum_payout: inr(MIN_PAYOUT),
    escalation_window: `${ESCALATION_HOURS} hours`,
  },
};

// Every rupee amount the email is allowed to contain. validate-ai-output.js
// rejects the email if the model writes any other amount.
const allowedAmounts = [...new Set([
  totals.earned, totals.paid, totals.pending, MIN_PAYOUT,
  ...published.flatMap((b) => b._amounts),
])];

return [{
  json: {
    log_id: request.log_id,
    author_id: author.id,
    as_of: isoDate(asOfDay),
    scenario,
    ai_facts: aiFacts,
    policy: { overdue_after_days: OVERDUE_AFTER_DAYS, min_payout: MIN_PAYOUT, payout_window_days: PAYOUT_WINDOW_DAYS },
    guardrails: {
      allowed_amounts: allowedAmounts,
      required_titles: [...published, ...inProduction].map((b) => b.title),
      first_name: firstName,
    },
    delivery: { name: author.name ?? '', email: author.email ?? '' },
    book_statuses: published.map((b) => ({ title: b.title, status: b.payout_status, days_waiting: b._days_waiting })),
    data_warnings: warnings,
  },
}];
