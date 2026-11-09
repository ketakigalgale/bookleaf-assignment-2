// Build AI Request
// Assembles the Gemini generateContent request.
//
// Prompt strategy:
//  - The system prompt holds only stable content: role, the royalty policy
//    slice of the Knowledge Base, tone rules and hard output rules.
//  - The user message holds a numbered "must cover" checklist built from this
//    author's situation, plus the FACTS JSON. Only instructions that apply are
//    included (an all-paid author never sees the overdue rules), which keeps
//    the prompt short and stops the model from hedging across scenarios.
//  - The production-stage part of the Knowledge Base is only sent when the
//    author actually has a book in production.

const cfg = $('Config').first().json;
const { ai_facts: facts, policy } = $('Build Royalty Facts').first().json;
const payout = facts.payout;

const TONE = `
- Empathetic and professional. Authors are partners, not customers to be managed.
- Acknowledge the author's situation before moving to details.
- Be specific: real numbers, dates and statuses instead of vague reassurance.
- If something is BookLeaf's fault (for example a delayed royalty), own it directly. No deflection.
- If something needs escalation, give a concrete timeline, never an open-ended promise.
- End with a clear next step for the author and/or the BookLeaf team.
`.trim();

const SYSTEM_PROMPT = `
You write royalty summary emails from BookLeaf Publishing to its authors.
BookLeaf is a self-publishing company in India and the US. It handles cover design, typesetting, ISBN assignment, printing, distribution and royalty management for its authors.

Royalty policy (state it accurately and never contradict it):
- Royalties are calculated every calendar quarter and paid within ${policy.payout_window_days} days of the quarter ending.
- The minimum payout is ${payout.minimum_payout}. A smaller balance rolls over to the next quarter.
- Payouts are made by bank transfer to the bank account linked in the author's BookLeaf dashboard.
- The dashboard shows a per-platform breakdown of sales and royalties.

Tone:
${TONE}

Hard rules:
1. Use only the names, titles, amounts, dates and statuses in FACTS. Copy every amount and date exactly as written there. Never calculate, round, convert or invent a number or a date.
2. Never ask the author to email bank details or other personal information. Point them to the dashboard instead.
3. Plain text only: no markdown, bold, headings or tables. Short paragraphs, and "- " bullets for the list of books.
4. The body is 170 to 320 words.
5. Start the body with "Dear ${facts.author_first_name}," and end it with exactly these two lines:
Warm regards,
Team BookLeaf
6. Return JSON with "subject" (under 80 characters, says it is a royalty summary) and "body".
`.trim();

// Quoted and joined with "and" so titles that contain punctuation stay readable.
const titleList = (titles) => {
  const quoted = titles.map((t) => `"${t}"`);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}` : quoted[0];
};

const tasks = [];
if (facts.published_books.length) {
  tasks.push('For every book in published_books, one bullet with the title, copies sold, royalty earned, royalty paid, royalty pending and the last payout date (or that no payout has been made yet).');
  tasks.push('A clear totals line across all books: total earned, total paid and total pending, exactly as in totals.');
}

switch (payout.scenario) {
  case 'all_paid':
    tasks.push('Every royalty earned so far has been paid. Acknowledge this warmly and thank the author; there is no pending amount to explain.');
    break;
  case 'below_threshold':
    tasks.push(`The total pending balance (${facts.totals.royalty_pending}) is below the ${payout.minimum_payout} minimum payout, so it rolls over to the next quarter and is paid once the balance reaches ${payout.minimum_payout}. Explain this reassuringly: nothing is wrong and nothing is lost.`);
    break;
  case 'no_published_books':
    tasks.push('No book is published yet, so there are no royalties to report. Say that royalties start once a book is live.');
    break;
  default:
    if (payout.overdue_books.length) {
      tasks.push(`Pending royalties for ${titleList(payout.overdue_books)} are past BookLeaf's normal quarterly payout schedule. Say this plainly, apologise once and take ownership without blaming banks, platforms or the author. Say the BookLeaf finance team is reviewing it now and will update the author within ${payout.escalation_window}, and ask them to check that the bank account linked in their dashboard is current so nothing holds the payment up.`);
    }
    if (payout.on_schedule_books.length) {
      tasks.push(`Pending royalties for ${titleList(payout.on_schedule_books)} are within the normal cycle. Tell the author to expect them in the payout due by ${payout.next_payout_deadline}, which covers ${payout.quarter_covered_by_next_payout}.`);
    }
}

if (facts.books_in_production.length) {
  tasks.push('For each book in books_in_production, a short, encouraging status update: name its current stage and stage_position, mention the next stage, and say the author will get an email as it moves through each stage. Do not give or guess a publication date. If a book is at Cover Design, you may say the team will reach out if they need the author\'s input on the cover, framed as working together.');
}

tasks.push('Close with one clear next step for the author (for example, the per-platform breakdown in their dashboard, or simply replying to this email with questions) before the sign-off.');

const productionContext = facts.books_in_production.length
  ? '\nBookLeaf production stages, in order: Manuscript Received, Editing (if opted), Cover Design, Typesetting, Proofreading, ISBN Assignment, Printing, Distribution Setup, Published & Live.\n'
  : '';

const userMessage = `
Write the royalty summary email for this author. Today's date is ${facts.todays_date}.
${productionContext}
The email must cover, in this order:
${tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}

FACTS:
${JSON.stringify(facts, null, 2)}
`.trim();

const generationConfig = {
  temperature: 0.4,
  maxOutputTokens: 2048,
  responseMimeType: 'application/json',
  responseSchema: {
    type: 'OBJECT',
    properties: {
      subject: { type: 'STRING' },
      body: { type: 'STRING' },
    },
    required: ['subject', 'body'],
  },
};
// Thinking adds cost and latency without helping a templated email. Leave the
// Config value empty if a model does not accept this setting.
if (cfg.gemini_thinking_level) {
  generationConfig.thinkingConfig = { thinkingLevel: cfg.gemini_thinking_level };
}

return [{
  json: {
    model: cfg.gemini_model,
    gemini_request: {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig,
    },
  },
}];
