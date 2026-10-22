// SPDX-License-Identifier: GPL-3.0-or-later
// Model client for the agentic suite (tests/agent.mjs). Plain fetch, no vendor SDK, so any model
// behind one of two wire formats can play:
//   openai     /chat/completions: Ollama, llama.cpp server, vLLM, LM Studio, OpenRouter, OpenAI...
//   anthropic  /v1/messages
// Configuration comes from options or the environment:
//   EDEN_AGENT_PROVIDER  openai (default) | anthropic
//   EDEN_AGENT_BASE_URL  default http://127.0.0.1:11434/v1 (Ollama), https://api.anthropic.com for anthropic
//   EDEN_AGENT_MODEL     default qwen2.5vl:3b
//   EDEN_AGENT_API_KEY   falls back to OPENAI_API_KEY / ANTHROPIC_API_KEY; local servers need none
//   EDEN_AGENT_VISION    1 (default) sends screenshots; 0 for text-only models, which get a text
//                        description of the screen instead
// Replies are free text: parseChoice and parseAction pull the action out of whatever the model
// wrote, so small models that cannot do tool calls or strict JSON still work.

export function modelConfig(options = {}) {
  const env = process.env;
  const provider = (options.provider ?? env.EDEN_AGENT_PROVIDER ?? 'openai').toLowerCase();
  if (!['openai', 'anthropic'].includes(provider)) throw new Error(`unknown provider ${provider} (openai or anthropic)`);
  const baseUrl = (options.baseUrl ?? env.EDEN_AGENT_BASE_URL ??
    (provider === 'anthropic' ? 'https://api.anthropic.com' : 'http://127.0.0.1:11434/v1')).replace(/\/+$/, '');
  const apiKey = options.apiKey ?? env.EDEN_AGENT_API_KEY ??
    (provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) ?? '';
  const vision = options.vision ?? !/^(0|false|no|off)$/i.test(env.EDEN_AGENT_VISION ?? '1');
  return {
    provider, baseUrl, apiKey, vision,
    model: options.model ?? env.EDEN_AGENT_MODEL ?? 'qwen2.5vl:3b',
    maxTokens: options.maxTokens ?? 400,
    temperature: options.temperature ?? 0.2,
    timeoutMs: options.timeoutMs ?? 300_000,
  };
}

/// Request body and headers for `messages` ([{ role: 'user'|'assistant', text, image?: Buffer }])
/// in the provider's wire format.
export function buildRequest(config, system, messages) {
  if (config.provider === 'anthropic') {
    return {
      url: `${config.baseUrl}/v1/messages`,
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(config.apiKey && { 'x-api-key': config.apiKey }) },
      body: {
        model: config.model, max_tokens: config.maxTokens, temperature: config.temperature, system,
        messages: messages.map(m => ({
          role: m.role,
          content: [
            ...(m.image && config.vision ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: m.image.toString('base64') } }] : []),
            { type: 'text', text: m.text },
          ],
        })),
      },
    };
  }
  return {
    url: `${config.baseUrl}/chat/completions`,
    headers: { 'content-type': 'application/json', ...(config.apiKey && { authorization: `Bearer ${config.apiKey}` }) },
    body: {
      model: config.model, max_tokens: config.maxTokens, temperature: config.temperature, stream: false,
      messages: [
        { role: 'system', content: system },
        ...messages.map(m => ({
          role: m.role,
          // Plain string content when there is no image: some local servers reject part arrays.
          content: m.image && config.vision
            ? [{ type: 'image_url', image_url: { url: `data:image/png;base64,${m.image.toString('base64')}` } }, { type: 'text', text: m.text }]
            : m.text,
        })),
      ],
    },
  };
}

/// Text and token usage out of a provider response body.
export function readResponse(config, json) {
  if (config.provider === 'anthropic') {
    return {
      text: (json.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n'),
      inputTokens: json.usage?.input_tokens ?? null,
      outputTokens: json.usage?.output_tokens ?? null,
    };
  }
  const message = json.choices?.[0]?.message ?? {};
  const text = typeof message.content === 'string' ? message.content
    : (message.content ?? []).map(c => c.text ?? '').join('\n');
  return {
    // Reasoning models may leave the answer only in their reasoning field.
    text: text || message.reasoning_content || message.reasoning || '',
    inputTokens: json.usage?.prompt_tokens ?? null,
    outputTokens: json.usage?.completion_tokens ?? null,
  };
}

export function createModel(options) {
  const config = modelConfig(options);
  return {
    config,
    async chat(system, messages) {
      const { url, headers, body } = buildRequest(config, system, messages);
      const started = Date.now();
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs) });
          const raw = await response.text();
          if (!response.ok) {
            lastError = new Error(`${config.provider} ${response.status}: ${raw.slice(0, 300)}`);
            // Retry only overload and server errors.
            if (response.status !== 429 && response.status < 500) break;
          } else {
            return { ...readResponse(config, JSON.parse(raw)), ms: Date.now() - started };
          }
        } catch (err) {
          lastError = err;
        }
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
      throw lastError;
    },
  };
}

/// The first JSON object in a reply (fenced or not, with <think> blocks removed), or null.
export function parseObject(reply) {
  const text = String(reply ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = text.indexOf('{');
  for (let end = text.lastIndexOf('}'); start >= 0 && end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

const BUTTON_NAMES = {
  a: 'A', b: 'B', x: 'X', y: 'Y', l: 'L', r: 'R', zl: 'ZL', zr: 'ZR',
  plus: 'Plus', '+': 'Plus', start: 'Plus', minus: 'Minus', '-': 'Minus', select: 'Minus',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', dup: 'Up', ddown: 'Down', dleft: 'Left', dright: 'Right',
  lstick: 'LStick', rstick: 'RStick', l3: 'LStick', r3: 'RStick', home: 'Home',
};
const DIRECTIONS = { left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1] };
const clampFrames = (value, fallback) => Math.max(1, Math.min(600, Math.round(Number(value) || fallback)));
const MAX_FRAMES = { press: 120, stick: 600, wait: 1800 };
export const ISSUE_KINDS = ['graphics', 'hang', 'input', 'performance', 'other'];
const issueKind = kind => (ISSUE_KINDS.includes(String(kind).toLowerCase()) ? String(kind).toLowerCase() : 'other');

/// The action a model reply asks for:
///   { action: 'press', button, frames } | { action: 'stick', stick, x, y, frames }
///   | { action: 'wait', frames } | { action: 'done', reason } | { action: 'giveup', reason }
///   | { action: 'fault', kind, reason }
/// Accepts a JSON object anywhere in the reply (fenced or not, single quotes, trailing commas),
/// then falls back to plain words such as "press A", "move right 60", "wait 120" or "DONE".
/// Returns null when nothing usable is found.
export function parseAction(reply) {
  const text = String(reply ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  for (const candidate of text.match(/\{[^{}]*\}/g) ?? []) {
    let object;
    try {
      object = JSON.parse(candidate);
    } catch {
      try {
        object = JSON.parse(candidate.replace(/'/g, '"').replace(/,\s*}/g, '}').replace(/([{,]\s*)([A-Za-z_]+)\s*:/g, '$1"$2":'));
      } catch {
        continue;
      }
    }
    const action = normalize(object);
    if (action) return action;
  }
  return fromWords(text);
}

function normalize(object) {
  if (!object || typeof object !== 'object') return null;
  const kind = String(object.action ?? object.type ?? object.cmd ?? '').toLowerCase();
  const reason = String(object.reason ?? object.why ?? object.note ?? '').slice(0, 300);
  if (['done', 'finish', 'finished', 'complete', 'success'].includes(kind)) return { action: 'done', reason };
  if (['giveup', 'give_up', 'give up', 'abandon', 'impossible'].includes(kind)) return { action: 'giveup', reason };
  if (['fault', 'bug', 'glitch', 'error', 'issue', 'report_issue'].includes(kind)) return { action: 'fault', kind: issueKind(object.kind), reason };
  if (['wait', 'noop', 'none'].includes(kind)) return { action: 'wait', frames: clampFrames(object.frames, 60), reason };
  if (['stick', 'move', 'walk', 'run'].includes(kind) || (object.x !== undefined && kind !== 'press')) {
    const direction = DIRECTIONS[String(object.direction ?? object.dir ?? '').toLowerCase()];
    const x = Math.max(-1, Math.min(1, Number(object.x ?? direction?.[0] ?? 0) || 0));
    const y = Math.max(-1, Math.min(1, Number(object.y ?? direction?.[1] ?? 0) || 0));
    if (!x && !y) return null;
    const stick = String(object.stick ?? 'left').toLowerCase().startsWith('r') ? 'right' : 'left';
    return { action: 'stick', stick, x, y, frames: clampFrames(object.frames, 30), reason };
  }
  const button = BUTTON_NAMES[String(object.button ?? object.key ?? (kind !== 'press' && kind !== 'hold' ? kind : '')).toLowerCase().replace(/[\s_]/g, '')];
  if (button) return { action: 'press', button, frames: clampFrames(object.frames, 4), reason };
  return null;
}

function fromWords(text) {
  const lower = text.toLowerCase();
  const number = lower.match(/(\d+)\s*(?:frames?)?/)?.[1];
  if (/\b(goal (?:is )?(?:reached|complete)|^\s*done\b|\bdone\s*[.!]?\s*$)/m.test(lower)) return { action: 'done', reason: text.trim().slice(0, 300) };
  if (/^\s*fault\b/m.test(lower)) return { action: 'fault', kind: 'other', reason: text.trim().slice(0, 300) };
  const move = lower.match(/\b(?:move|walk|run|stick|go)\s+(left|right|up|down)\b/);
  if (move) return { action: 'stick', stick: 'left', x: DIRECTIONS[move[1]][0], y: DIRECTIONS[move[1]][1], frames: clampFrames(number, 30), reason: '' };
  const press = lower.match(/\b(?:press|tap|hold|push)\s+(?:the\s+)?([a-z+\-]+\d?)/);
  if (press && BUTTON_NAMES[press[1]]) return { action: 'press', button: BUTTON_NAMES[press[1]], frames: clampFrames(number, 4), reason: '' };
  if (/\bwait\b/.test(lower)) return { action: 'wait', frames: clampFrames(number, 60), reason: '' };
  return null;
}

/// The numbered actions offered to the model each turn: small models pick from a list far more
/// reliably than they compose actions. `exclude` drops one (by `key`), e.g. one repeated too often.
export function choiceMenu(exclude) {
  const menu = [
    ...['A', 'B', 'X', 'Y', 'Plus', 'Minus', 'L', 'R', 'ZL', 'ZR', 'Up', 'Down', 'Left', 'Right']
      .map(button => ({ label: `press ${button}`, action: { action: 'press', button, frames: 4 } })),
    ...Object.entries(DIRECTIONS).map(([name, [x, y]]) => ({ label: `move ${name} (left stick, 1 s)`, action: { action: 'stick', stick: 'left', x, y, frames: 60 } })),
    { label: 'wait 2 s (loading, cutscene)', action: { action: 'wait', frames: 120 } },
    { label: 'done: the goal is reached on this screen', action: { action: 'done' } },
    { label: 'give up: the goal cannot be reached', action: { action: 'giveup' } },
    { label: 'fault: the emulator looks broken (garbled, missing or frozen graphics)', action: { action: 'fault', kind: 'graphics' } },
  ].map(entry => ({ ...entry, key: actionKey(entry.action) }));
  return menu.filter(entry => entry.key !== exclude).map((entry, i) => ({ ...entry, number: i + 1 }));
}

/// Identity of an action for spotting repeats, ignoring its stated reason.
export const actionKey = action => JSON.stringify({ ...action, reason: undefined });

/// The menu entry a reply picks: {"choice": 3}, "choice 3", or a reply that starts with the number.
/// Falls back to parseAction, so a full action object also works. Returns null when nothing fits.
export function parseChoice(reply, menu) {
  const text = String(reply ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const reason = String(text.match(/"reason"\s*:\s*"([^"]{0,300})/)?.[1] ?? '');
  const number = Number(text.match(/"?choice"?\s*[:=]?\s*"?(\d+)/i)?.[1] ?? text.match(/^\s*(\d+)\b/)?.[1]);
  const entry = menu.find(e => e.number === number);
  if (entry) {
    const action = { ...entry.action, reason };
    // Models that can judge timing may give their own duration.
    const frames = Number(text.match(/"frames"\s*:\s*(\d+)/)?.[1]);
    if (frames && action.frames) action.frames = Math.min(MAX_FRAMES[action.action], frames);
    const kind = text.match(/"kind"\s*:\s*"(\w+)"/)?.[1];
    if (kind && action.kind) action.kind = issueKind(kind);
    return action;
  }
  // A choice outside the list is a bad reply, not one to read words out of.
  return /"choice"/i.test(text) ? null : parseAction(text);
}
