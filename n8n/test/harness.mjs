// Runs an n8n Code-node file outside n8n with the same globals the node uses
// ($, $input, $execution, $prevNode, $getWorkflowStaticData), so the exact
// source that ships in the workflow JSON is what gets tested.

import { readFileSync } from 'node:fs';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const toItems = (list) => list.map((json) => ({ json }));

export async function runCodeNode(file, { nodes = {}, input = [], prevNode = '', executionId = '101', staticData = {} } = {}) {
  const code = readFileSync(new URL(`../code/${file}`, import.meta.url), 'utf8');

  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Test did not provide output for node "${name}"`);
    const items = toItems(nodes[name]);
    return { first: () => items[0], last: () => items.at(-1), all: () => items };
  };
  const inputItems = toItems(input);
  const $input = { first: () => inputItems[0], last: () => inputItems.at(-1), all: () => inputItems };
  const $getWorkflowStaticData = () => staticData;

  const run = new AsyncFunction('$', '$input', '$execution', '$prevNode', '$getWorkflowStaticData', code);
  const result = await run($, $input, { id: executionId }, { name: prevNode }, $getWorkflowStaticData);
  return result.map((item) => item.json);
}
