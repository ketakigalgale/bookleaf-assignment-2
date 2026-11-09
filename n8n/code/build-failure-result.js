// Build Failure Result
// Single sink for every error branch after validation. Works out which step
// failed from the node that fed it, so the admin sees "AI generation failed:
// 429 Too Many Requests" rather than a bare "Failed". Returned with HTTP 200:
// the call to n8n worked, the business outcome is what failed, and Bubble
// reads the same fields from every 200 response.

const request = $('Validate Request').first().json;
const item = $input.first().json;

const STAGES = {
  'Build Royalty Facts': { stage: 'build_facts', label: 'Royalty data could not be prepared' },
  'Build AI Request': { stage: 'build_prompt', label: 'The AI request could not be built' },
  'Generate Email (Gemini)': { stage: 'ai_generation', label: 'AI generation failed' },
  'AI Output OK?': { stage: 'ai_output_validation', label: 'AI output failed validation' },
};

let source = '';
try {
  source = $prevNode.name;
} catch {
  source = '';
}
const known = STAGES[source] ?? { stage: 'unknown', label: `Step "${source || 'unknown'}" failed` };

const errorText = (err) => {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const code = err.httpCode ?? err.status ?? '';
  const message = err.message || err.description || JSON.stringify(err);
  return code && !String(message).includes(String(code)) ? `${code} ${message}` : message;
};

const detail = Array.isArray(item.problems) && item.problems.length
  ? item.problems.join('; ')
  : errorText(item.error) || 'No error detail returned';

return [{
  json: {
    response_code: 200,
    log_id: request.log_id,
    status: 'Failed',
    email_subject: '',
    email_body: '',
    email_delivery: 'Not attempted',
    email_recipient: '',
    email_note: '',
    error_stage: known.stage,
    error_message: `${known.label}: ${detail}`.slice(0, 1000),
    ai_model: '',
    ai_input_tokens: null,
    ai_output_tokens: null,
    completed_at: new Date().toISOString(),
    n8n_execution_id: String($execution.id),
  },
}];
