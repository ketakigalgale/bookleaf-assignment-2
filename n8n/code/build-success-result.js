// Build Success Result
// Reached from three places: "Send Email (SMTP)" success output, its error
// output, or "Send Email?" when sending is skipped. The summary itself was
// generated and validated either way, so the result is Success; email
// delivery is reported separately because email is the optional (bonus) leg.
// Bubble writes this object straight into the NotificationLog.

const request = $('Validate Request').first().json;
const ai = $('Validate AI Output').first().json;
const item = $input.first().json;

const errorText = (err) => {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err.message || err.description || JSON.stringify(err);
};

let emailDelivery = 'Skipped';
let emailNote = ai.email.skip_reason;
let errorStage = '';
let errorMessage = '';

if ($prevNode.name === 'Send Email (SMTP)') {
  if (item.error) {
    emailDelivery = 'Failed';
    emailNote = '';
    errorStage = 'email_delivery';
    errorMessage = `Summary generated, but email delivery failed: ${errorText(item.error)}`.slice(0, 1000);
  } else {
    emailDelivery = 'Sent';
    emailNote = ai.email.mode === 'override' ? 'Sent to the test inbox (email_mode = override) instead of the author\'s address' : '';
  }
}

return [{
  json: {
    response_code: 200,
    log_id: request.log_id,
    status: 'Success',
    email_subject: ai.subject,
    email_body: ai.body,
    email_delivery: emailDelivery,
    email_recipient: emailDelivery === 'Skipped' ? '' : ai.email.recipient,
    email_note: emailNote,
    error_stage: errorStage,
    error_message: errorMessage,
    ai_model: ai.ai_model,
    ai_input_tokens: ai.ai_input_tokens,
    ai_output_tokens: ai.ai_output_tokens,
    completed_at: new Date().toISOString(),
    n8n_execution_id: String($execution.id),
  },
}];
