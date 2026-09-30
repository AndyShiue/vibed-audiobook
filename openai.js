// OpenAI (or any OpenAI-compatible server) as the main model.
//
// prompts.js builds requests in Anthropic's shape (system blocks, messages, tools with input_schema); this module
// translates that to one of OpenAI's two APIs, streams the reply and hands back the same things the Anthropic path
// does: the text, the tools the model chose, and whether it refused. Plain fetch, no SDK.
//
//   Responses API       (/v1/responses)        the default for api.openai.com. Newer models (gpt-6.1-sol, gpt-5.5 …)
//                                              take function tools together with a reasoning effort only here.
//   Chat Completions    (/v1/chat/completions) the default for any other base URL (self-hosted / compatible servers).

export class OpenAIError extends Error {
  constructor(status, message, { code = '', param = '' } = {}) {
    super(message);
    this.name = 'OpenAIError';
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

export const isOfficialBase = (base) => /^https:\/\/api\.openai\.com(\/|$)/i.test(String(base));

/** 'responses' or 'chat'. `setting` is OPENAI_API: auto (default) | responses | chat. */
export function pickApi(setting, base) {
  const s = String(setting || 'auto').trim().toLowerCase();
  if (s === 'chat' || s === 'responses') return s;
  return isOfficialBase(base) ? 'responses' : 'chat';
}

/** Models that think before answering; they take a reasoning effort and count that thinking against the token limit. */
const REASONING_MODELS = /^(gpt-5|gpt-6|o\d)/;

/**
 * Which reasoning effort values to try, in order (null = don't send one).
 * The accepted values differ by model — gpt-6.1-sol takes low…max but not "none", gpt-5.5 also takes "none", gpt-4.1
 * takes nothing — so by default the first is tried and the server steps down when the API says no, remembering what
 * worked. "low" comes first: a spoken answer wants speed. An explicit setting is used as given (an error is then shown
 * as it is, since the API lists the values that model accepts).
 */
export function effortCandidates(model, setting = 'auto', api = 'responses') {
  const s = String(setting || 'auto').trim().toLowerCase();
  if (s === 'off') return [null];
  if (s !== 'auto') return [s];
  if (!REASONING_MODELS.test(model)) return [null];
  return api === 'responses' ? ['low', 'medium', 'high', null] : ['none', 'minimal', 'low', null];
}

export const isEffortError = (err) => err instanceof OpenAIError && err.status === 400 && /reasoning[._]effort/.test(`${err.param} ${err.message}`);

const systemText = (system) => (Array.isArray(system) ? system.map((b) => b.text).join('\n\n') : String(system || ''));
/** Thinking counts against the output limit, so leave room for the answer itself. */
const outputBudget = (maxTokens, effort) => (effort && effort !== 'none' ? maxTokens * 2 : maxTokens);

/** Anthropic-shaped request pieces (see prompts.js) → a Chat Completions request body. */
export function buildChatBody({ model, built, effort = null, maxTokens = 4096 }) {
  const body = {
    model,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: outputBudget(maxTokens, effort),
    messages: [{ role: 'system', content: systemText(built.system) }, ...built.messages.map((m) => ({ role: m.role, content: m.content }))],
  };
  if (built.tools?.length) {
    body.parallel_tool_calls = true; // "go back and then stop" is two calls in one reply
    body.tools = built.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  }
  if (effort) body.reasoning_effort = effort;
  return body;
}

/** The same request as a Responses API body. Nothing is stored on OpenAI's side (store: false). */
export function buildResponsesBody({ model, built, effort = null, maxTokens = 4096 }) {
  const body = {
    model,
    stream: true,
    store: false,
    max_output_tokens: outputBudget(maxTokens, effort),
    instructions: systemText(built.system),
    input: built.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (built.tools?.length) {
    body.parallel_tool_calls = true;
    // strict: false — the schemas have optional properties, which strict mode (the default here) forbids
    body.tools = built.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false }));
  }
  if (effort) body.reasoning = { effort };
  return body;
}

async function readError(res) {
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  let e = {};
  try { e = JSON.parse(text).error || {}; } catch { /* not JSON */ }
  return new OpenAIError(res.status, e.message || text.slice(0, 300) || `HTTP ${res.status}`, { code: e.code || e.type || '', param: e.param || '' });
}

const streamError = (e = {}) => new OpenAIError(e.status || 500, e.message || 'stream error', { code: e.code || e.type || '', param: e.param || '' });

/** Every `data:` payload of a server-sent-events response, as a string. */
async function* sseData(res) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split('\n')) if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buf.trim().startsWith('data:')) yield buf.trim().slice(5).trim();
}

async function post(base, path, key, body, signal) {
  const res = await fetch(`${String(base).replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await readError(res);
  return res;
}

const parseArgs = (raw) => {
  try { const v = raw ? JSON.parse(raw) : {}; return v && typeof v === 'object' ? v : {}; } catch { return {}; } // a truncated argument string means "no arguments"; the planner refuses that
};

/**
 * Streams one Chat Completions reply. `onText(delta)` is called for each piece of text.
 * Resolves { text, tools:[{name,input}], refusal, finish, model, usage:{in,cached,out} }.
 */
export async function streamChat({ base, key, body, signal, onText }) {
  const res = await post(base, '/chat/completions', key, body, signal);
  let text = '', refusalText = '', finish = null, model = body.model, usage = null;
  const calls = []; // by index: {name, args}
  for await (const data of sseData(res)) {
    if (data === '[DONE]') continue;
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    if (j.error) throw streamError(j.error);
    if (j.model) model = j.model;
    if (j.usage) usage = { in: j.usage.prompt_tokens ?? 0, cached: j.usage.prompt_tokens_details?.cached_tokens ?? 0, out: j.usage.completion_tokens ?? 0 };
    const choice = j.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    if (d.content) { text += d.content; onText?.(d.content); }
    if (d.refusal) refusalText += d.refusal;
    for (const tc of d.tool_calls || []) {
      const c = (calls[tc.index ?? 0] ||= { name: '', args: '' });
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const tools = calls.filter((c) => c?.name).map((c) => ({ name: c.name, input: parseArgs(c.args) }));
  return { text: text.trim(), tools, refusal: Boolean(refusalText) || finish === 'content_filter', finish, model, usage: usage || { in: 0, cached: 0, out: 0 } };
}

/** Same result shape, from the Responses API's event stream. */
export async function streamResponses({ base, key, body, signal, onText }) {
  const res = await post(base, '/responses', key, body, signal);
  let text = '', refusalText = '', finish = null, model = body.model, usage = null;
  const calls = new Map(); // output_index -> {name, args}
  for await (const data of sseData(res)) {
    if (data === '[DONE]') continue;
    let e;
    try { e = JSON.parse(data); } catch { continue; }
    switch (e.type) {
      case 'response.output_text.delta': if (e.delta) { text += e.delta; onText?.(e.delta); } break;
      case 'response.refusal.delta': refusalText += e.delta || ''; break;
      case 'response.output_item.added':
        if (e.item?.type === 'function_call') calls.set(e.output_index, { name: e.item.name || '', args: e.item.arguments || '' });
        break;
      case 'response.function_call_arguments.delta': {
        const c = calls.get(e.output_index);
        if (c) c.args += e.delta || '';
        break;
      }
      case 'response.function_call_arguments.done': {
        const c = calls.get(e.output_index);
        if (c && typeof e.arguments === 'string') c.args = e.arguments; // the complete string is authoritative
        break;
      }
      case 'response.output_item.done':
        if (e.item?.type === 'function_call') calls.set(e.output_index, { name: e.item.name || '', args: e.item.arguments ?? calls.get(e.output_index)?.args ?? '' });
        break;
      case 'response.completed':
      case 'response.incomplete': {
        const r = e.response || {};
        if (r.model) model = r.model;
        finish = e.type === 'response.completed' ? 'stop' : r.incomplete_details?.reason || 'incomplete';
        if (r.usage) usage = { in: r.usage.input_tokens ?? 0, cached: r.usage.input_tokens_details?.cached_tokens ?? 0, out: r.usage.output_tokens ?? 0 };
        break;
      }
      case 'response.failed': throw streamError(e.response?.error);
      case 'error': throw streamError(e);
      default: break;
    }
  }
  const tools = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).filter((c) => c.name).map((c) => ({ name: c.name, input: parseArgs(c.args) }));
  return { text: text.trim(), tools, refusal: Boolean(refusalText) || finish === 'content_filter', finish, model, usage: usage || { in: 0, cached: 0, out: 0 } };
}

/** Build and stream a request with whichever API `api` names. */
export function request(api, { model, built, effort, maxTokens, base, key, signal, onText }) {
  return api === 'responses'
    ? streamResponses({ base, key, body: buildResponsesBody({ model, built, effort, maxTokens }), signal, onText })
    : streamChat({ base, key, body: buildChatBody({ model, built, effort, maxTokens }), signal, onText });
}
