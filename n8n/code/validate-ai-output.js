// Validate AI Output
// Guardrails between the model and the author's inbox. The email is only
// accepted if it parses, is complete, greets the right person, mentions every
// book, and contains no rupee amount that is not in the source data.
// This node never throws: it reports problems so the IF node after it can
// route a bad generation to the "Failed" callback with a readable reason.

const cfg = $('Config').first().json;
const facts = $('Build Royalty Facts').first().json;
const model = $('Build AI Request').first().json.model;
const response = $input.first().json;

const problems = [];
let subject = '';
let body = '';

const candidate = response.candidates?.[0];
if (response.promptFeedback?.blockReason) problems.push(`Prompt blocked by the model: ${response.promptFeedback.blockReason}`);
if (!candidate) problems.push('The model returned no candidate');
if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
  problems.push(`Generation did not finish normally (finishReason: ${candidate.finishReason})`);
}

const text = (candidate?.content?.parts ?? [])
  .filter((part) => !part.thought && typeof part.text === 'string')
  .map((part) => part.text)
  .join('')
  .trim();

let parsed = null;
if (text) {
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    problems.push('The model output was not valid JSON');
  }
}

if (parsed) {
  subject = String(parsed.subject ?? '').trim();
  body = String(parsed.body ?? '').replace(/\r\n/g, '\n').trim();

  if (subject.length < 5 || subject.length > 150) problems.push('Subject is missing or an odd length');
  if (body.length < 300) problems.push('Body is missing or too short');
  if (body.length > 6000) problems.push('Body is unexpectedly long');

  const normalise = (s) => s.toLowerCase().replace(/[‘’`]/g, "'");
  const bodyNorm = normalise(body);

  if (!bodyNorm.includes(normalise(facts.guardrails.first_name))) problems.push('Greeting does not use the author\'s name');

  const missing = facts.guardrails.required_titles.filter((t) => !bodyNorm.includes(normalise(t)));
  if (missing.length) problems.push(`Books not mentioned: ${missing.join(', ')}`);

  // Any amount written as ₹, Rs or INR must be one of the source figures.
  const allowed = new Set(facts.guardrails.allowed_amounts.map(Number));
  const amountPattern = /(?:₹|\brs\.?|\binr)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/gi;
  const invented = [...body.matchAll(amountPattern)]
    .map((m) => m[1])
    .filter((raw) => !allowed.has(Number(raw.replace(/,/g, ''))));
  if (invented.length) problems.push(`Amounts not in the source data: ${[...new Set(invented)].join(', ')}`);

  if (/\[[^\]]*\]|\{\{|<[a-z _]+>/i.test(body)) problems.push('Body contains an unfilled placeholder');
}

// Delivery decision. The dataset uses real-looking addresses on a real mail
// provider's domain, so "live" sending is opt-in and the default sends every
// summary to a test inbox instead.
const mode = String(cfg.email_mode ?? 'off').toLowerCase();
let recipient = '';
let skipReason = '';
if (mode === 'live') {
  recipient = facts.delivery.email;
  if (!recipient) skipReason = 'Author has no email address';
} else if (mode === 'override') {
  recipient = String(cfg.email_override_recipient ?? '').trim();
  if (!recipient) skipReason = 'email_mode is "override" but no override recipient is configured';
} else {
  skipReason = 'Email sending is turned off (email_mode = off)';
}

return [{
  json: {
    ok: problems.length === 0,
    problems,
    subject,
    body,
    ai_model: model,
    ai_input_tokens: response.usageMetadata?.promptTokenCount ?? null,
    ai_output_tokens: response.usageMetadata?.candidatesTokenCount ?? null,
    email: {
      should_send: problems.length === 0 && Boolean(recipient),
      recipient,
      mode,
      skip_reason: skipReason,
    },
  },
}];
