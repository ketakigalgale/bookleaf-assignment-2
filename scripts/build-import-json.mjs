// Builds data/bubble-import.json, the file Bubble's temporary import page
// reads through the API Connector. Bubble's free plan blocks both the Data API
// and CSV upload, so the app pulls the dataset itself (outbound calls are
// allowed on every plan) and creates the records from a page workflow.
//
//   node scripts/build-import-json.mjs
//
// Compared with bookleaf_sample_data.json, this file adds the values Bubble
// stores but the dataset does not have: the cached author totals and each
// book's overdue_clock_start. Dates become ISO instants at noon IST, so the
// calendar day is the same in every time zone Bubble renders them in.

import { readFileSync, writeFileSync } from 'node:fs';

const dataset = JSON.parse(readFileSync(new URL('../data/bookleaf_sample_data.json', import.meta.url), 'utf8'));
const PUBLISHED = 'Published & Live';

const instant = (iso) => (iso ? `${iso}T06:30:00.000Z` : null);
const sum = (books, field) => books.reduce((acc, b) => acc + (b[field] ?? 0), 0);
// The overdue clock starts at the last payout, or at publication if never paid.
const clockStart = (b) => (b.royalty_pending > 0 && b.status === PUBLISHED ? b.last_royalty_payout_date ?? b.publication_date : null);

const authors = dataset.authors.map((a) => {
  const payoutDates = a.books.map((b) => b.last_royalty_payout_date).filter(Boolean).sort();
  const clocks = a.books.map(clockStart).filter(Boolean).sort();
  return {
    author_code: a.author_id,
    name: a.name,
    email: a.email,
    phone: a.phone,
    city: a.city,
    joined_date: instant(a.joined_date),
    total_books: a.books.length,
    published_books: a.books.filter((b) => b.status === PUBLISHED).length,
    total_copies_sold: sum(a.books, 'total_copies_sold'),
    total_royalty_earned: sum(a.books, 'total_royalty_earned'),
    total_royalty_paid: sum(a.books, 'royalty_paid'),
    total_royalty_pending: sum(a.books, 'royalty_pending'),
    last_royalty_payout_date: instant(payoutDates.at(-1)),
    overdue_clock_start: instant(clocks[0]),
    books: a.books.map((b) => ({
      book_code: b.book_id,
      title: b.title,
      isbn: b.isbn,
      genre: b.genre,
      publication_date: instant(b.publication_date),
      status: b.status,
      mrp: b.mrp,
      author_royalty_per_copy: b.author_royalty_per_copy,
      total_copies_sold: b.total_copies_sold,
      total_royalty_earned: b.total_royalty_earned,
      royalty_paid: b.royalty_paid,
      royalty_pending: b.royalty_pending,
      last_royalty_payout_date: instant(b.last_royalty_payout_date),
      overdue_clock_start: instant(clockStart(b)),
      print_partner: b.print_partner,
      available_on: b.available_on,
    })),
  };
});

// The import page walks two flat lists with a counter ("import next"), so
// books are also listed on their own, each carrying its author_code for the
// lookup. The nested copy under each author is kept for reference.
const books = authors.flatMap((a) => a.books.map((b) => ({ author_code: a.author_code, ...b })));

const out = new URL('../data/bubble-import.json', import.meta.url);
writeFileSync(out, `${JSON.stringify({ authors, books }, null, 2)}\n`);
const payouts = books.filter((b) => b.royalty_paid > 0).length;
console.log(`Wrote data/bubble-import.json: ${authors.length} authors, ${books.length} books (${payouts} with a payout record)`);
