// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the agentic suite's model client without a model or browser: action parsing of messy
// replies, both wire formats against a local mock server, and retry on server errors.

import assert from 'node:assert/strict';
import http from 'node:http';
import { actionKey, buildRequest, choiceMenu, createModel, modelConfig, parseAction, parseChoice, parseObject } from './lib/llm.mjs';

// Replies as small models really write them.
const cases = [
  ['{"action":"press","button":"A"}', { action: 'press', button: 'A', frames: 4 }],
  ['```json\n{"action": "press", "button": "plus", "frames": 20}\n```', { action: 'press', button: 'Plus', frames: 20 }],
  ["Sure! {'action': 'press', 'button': 'b',}", { action: 'press', button: 'B', frames: 4 }],
  ['{action: "stick", x: 1, y: 0, frames: 90}', { action: 'stick', stick: 'left', x: 1, y: 0, frames: 90 }],
  ['{"action":"move","direction":"left"}', { action: 'stick', stick: 'left', x: -1, y: 0, frames: 30 }],
  ['{"action":"wait","frames":5000}', { action: 'wait', frames: 600 }],
  ['<think>maybe {"action":"press","button":"B"}</think>{"action":"done","reason":"in level"}', { action: 'done', reason: 'in level' }],
  ['{"action":"fault","kind":"graphics","reason":"textures are black"}', { action: 'fault', kind: 'graphics', reason: 'textures are black' }],
  ['{"action":"give up","reason":"menu locked"}', { action: 'giveup', reason: 'menu locked' }],
  ['{"action":"A"}', { action: 'press', button: 'A', frames: 4 }],
  ['I will press A to confirm.', { action: 'press', button: 'A', frames: 4 }],
  ['Move right for 60 frames', { action: 'stick', stick: 'left', x: 1, y: 0, frames: 60 }],
  ['Wait 120 frames for the load.', { action: 'wait', frames: 120 }],
  ['DONE', { action: 'done', reason: 'DONE' }],
];
for (const [reply, expected] of cases) {
  const { reason = '', ...rest } = parseAction(reply) ?? {};
  const { reason: expectedReason = '', ...expectedRest } = expected;
  assert.deepEqual(rest, expectedRest, reply);
  assert.equal(reason, expectedReason, reply);
}
assert.equal(parseAction('I am not sure what to do.'), null);
assert.equal(parseAction('{"action":"press","button":"Q"}'), null);

assert.deepEqual(parseObject('Here:\n```json\n{"matches": true, "shows": "a cave", "emulator_faults": ["black {walls}"]}\n```'),
  { matches: true, shows: 'a cave', emulator_faults: ['black {walls}'] });
assert.equal(parseObject('no json here'), null);

// Numbered choices, as small models answer them.
const menu = choiceMenu();
const plus = menu.find(e => e.label === 'press Plus').number;
assert.deepEqual(parseChoice(`{"screen":"in a level","choice":${plus},"reason":"open menu"}`, menu), { action: 'press', button: 'Plus', frames: 4, reason: 'open menu' });
assert.equal(parseChoice(`${plus}. press Plus`, menu).button, 'Plus');
assert.equal(parseChoice('{"choice":"1"}', menu).button, 'A');
assert.equal(parseChoice(`{"choice":${plus},"frames":500}`, menu).frames, 120, 'press holds at most 120 frames');
const waitNumber = menu.find(e => e.action.action === 'wait').number;
assert.equal(parseChoice(`{"choice":${waitNumber},"frames":900}`, menu).frames, 900);
const faultNumber = menu.find(e => e.action.action === 'fault').number;
assert.equal(parseChoice(`{"choice":${faultNumber},"kind":"input","reason":"A does nothing"}`, menu).kind, 'input');
assert.ok(menu.some(e => e.action.action === 'giveup'));
assert.equal(parseChoice('{"action":"stick","x":-1,"y":0}', menu).x, -1, 'falls back to a full action');
assert.equal(parseChoice('{"choice":99}', menu), null);
assert.equal(parseChoice('{"choice":1560,"reason":"the goal is reached"}', menu), null);
const wait = menu.find(e => e.action.action === 'wait');
const trimmed = choiceMenu(actionKey(wait.action));
assert.equal(trimmed.length, menu.length - 1);
assert.ok(!trimmed.some(e => e.action.action === 'wait'));
assert.deepEqual(trimmed.map(e => e.number), trimmed.map((_, i) => i + 1));

// Text-only models get no image parts, and OpenAI-compatible servers get string content then.
const png = Buffer.from('png');
const textOnly = buildRequest(modelConfig({ vision: false }), 'sys', [{ role: 'user', text: 'hi', image: png }]);
assert.equal(textOnly.body.messages[1].content, 'hi');
assert.equal(textOnly.headers.authorization, undefined);
const anthropic = buildRequest(modelConfig({ provider: 'anthropic', apiKey: 'k' }), 'sys', [{ role: 'user', text: 'hi', image: png }]);
assert.equal(anthropic.body.system, 'sys');
assert.equal(anthropic.body.messages[0].content[0].source.data, png.toString('base64'));
assert.equal(anthropic.headers['x-api-key'], 'k');

const requests = [];
let failures = 1;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/chat/completions' && failures-- > 0) {
      res.statusCode = 503;
      res.end('{}');
    } else if (req.url === '/v1/chat/completions') {
      res.end(JSON.stringify({ choices: [{ message: { content: '{"action":"press","button":"A"}' } }], usage: { prompt_tokens: 50, completion_tokens: 9 } }));
    } else if (req.url === '/v1/messages') {
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'press B' }], usage: { input_tokens: 40, output_tokens: 2 } }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const openai = await createModel({ baseUrl: `${base}/v1`, model: 'qwen2.5vl:3b', apiKey: 'secret' }).chat('sys', [{ role: 'user', text: 'go', image: png }]);
  assert.equal(parseAction(openai.text).button, 'A');
  assert.equal(openai.inputTokens, 50);
  assert.equal(requests.length, 2, 'retries a 503');
  assert.equal(requests[1].headers.authorization, 'Bearer secret');
  assert.equal(requests[1].body.model, 'qwen2.5vl:3b');
  assert.match(requests[1].body.messages[1].content[0].image_url.url, /^data:image\/png;base64,/);

  const claude = await createModel({ provider: 'anthropic', baseUrl: base, model: 'any' }).chat('sys', [{ role: 'user', text: 'go' }]);
  assert.equal(parseAction(claude.text).button, 'B');
  assert.equal(claude.outputTokens, 2);
  assert.equal(requests[2].headers['anthropic-version'], '2023-06-01');

  await assert.rejects(createModel({ baseUrl: `${base}/missing` }).chat('sys', [{ role: 'user', text: 'go' }]), /404/);
} finally {
  server.close();
}
console.log('agent protocol checks passed');
