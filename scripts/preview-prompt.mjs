// Prints the exact system prompt and user message n8n would send to Gemini
// for one author, without calling any API.
//
//   node scripts/preview-prompt.mjs AUTH007
//   node scripts/preview-prompt.mjs AUTH002 2026-01-10

import { runCodeNode } from '../n8n/test/harness.mjs';
import { CONFIG, byCode, factsNodes } from '../n8n/test/fixtures.mjs';

const [code = 'AUTH007', asOf] = process.argv.slice(2);
if (!byCode(code)) {
  console.error(`Unknown author code ${code}. Use AUTH001 to AUTH010.`);
  process.exit(1);
}

const [facts] = await runCodeNode('build-royalty-facts.js', { nodes: await factsNodes(code, asOf ?? '') });
const [request] = await runCodeNode('build-ai-request.js', {
  nodes: { Config: [CONFIG], 'Build Royalty Facts': [facts] },
});

const { systemInstruction, contents, generationConfig } = request.gemini_request;
console.log('===== SYSTEM =====\n');
console.log(systemInstruction.parts[0].text);
console.log('\n===== USER =====\n');
console.log(contents[0].parts[0].text);
console.log('\n===== GENERATION CONFIG =====\n');
console.log(JSON.stringify(generationConfig, null, 2));
const chars = systemInstruction.parts[0].text.length + contents[0].parts[0].text.length;
console.log(`\n~${Math.round(chars / 4)} input tokens (rough estimate: characters / 4)`);
