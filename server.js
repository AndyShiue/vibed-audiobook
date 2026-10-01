// Tiny dependency-light server:
//   • serves the PWA in /public
//   • keeps the AI provider's API key (Anthropic or OpenAI) on the server and exposes two narrow endpoints
//       POST /api/ask        – answers a listener question (Server-Sent Events stream)
//       POST /api/summarize  – condenses already-heard text for the "memory" layer
// The browser decides WHAT context to send (and never sends text beyond the
// listener's position); this server only formats it into prompts and forwards it.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { buildAskRequest, buildSummaryRequest, LIMITS } from './prompts.js';
import { OpenAIError, effortCandidates, isEffortError, pickApi, request as openaiRequest } from './openai.js';
import { lanAddresses } from './lan-cert.js';
import { buildTranscribePrompt, isPromptEcho } from './stt-prompt.js';
import { setupPage, pickSetupLang } from './setup-page.js';
import { ttsConfig, createTts, publicInfo as ttsPublicInfo, TtsError } from './tts-providers.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
try { process.loadEnvFile(process.env.ENV_FILE || path.join(ROOT, '.env')); } catch { /* .env is optional */ }

const argv = new Set(process.argv.slice(2));
const MOCK = argv.has('--mock') || process.env.MOCK_LLM === '1';
const USE_HTTPS = argv.has('--https') || process.env.HTTPS === '1';
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
// Which company's model does the thinking: 'anthropic' (default) or 'openai'. Questions and background summaries can
// use different ones (QA_PROVIDER / SUMMARY_PROVIDER); AI_PROVIDER sets both.
const PROVIDERS = ['anthropic', 'openai'];
const providerFrom = (v) => { const p = String(v || '').trim().toLowerCase(); return PROVIDERS.includes(p) ? p : ''; };
for (const name of ['AI_PROVIDER', 'QA_PROVIDER', 'SUMMARY_PROVIDER']) {
  if (process.env[name] && !providerFrom(process.env[name])) console.warn(`[config] ${name}="${process.env[name]}" is not one of: ${PROVIDERS.join(', ')} — using the default.`);
}
const QA_PROVIDER = providerFrom(process.env.QA_PROVIDER) || providerFrom(process.env.AI_PROVIDER) || 'anthropic';
const SUMMARY_PROVIDER = providerFrom(process.env.SUMMARY_PROVIDER) || providerFrom(process.env.AI_PROVIDER) || 'anthropic';
const DEFAULT_MODEL = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-6.1-sol' };
const QA_MODEL = process.env.QA_MODEL || DEFAULT_MODEL[QA_PROVIDER];
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || DEFAULT_MODEL[SUMMARY_PROVIDER];
// Thinking depth for either provider. Claude: low | medium | high | xhigh | max (default low). OpenAI: whatever the model accepts —
// unset means "try low first and step down if the model refuses it" (see openai.js); an explicit value is used as given.
const QA_EFFORT = process.env.QA_EFFORT || 'low';
const SUMMARY_EFFORT = process.env.SUMMARY_EFFORT || 'low';
const QA_EFFORT_OPENAI = process.env.QA_EFFORT || 'auto';
const SUMMARY_EFFORT_OPENAI = process.env.SUMMARY_EFFORT || 'auto';
const OPENAI_BASE = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const OPENAI_API = pickApi(process.env.OPENAI_API, OPENAI_BASE); // 'responses' for api.openai.com, 'chat' for other servers
const FALLBACKS = process.env.AI_FALLBACKS !== 'off';               // Anthropic only
const HAS_ANTHROPIC_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const KEY_NAME = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
const HAS_KEY_FOR = { anthropic: HAS_ANTHROPIC_KEY, openai: HAS_OPENAI_KEY };
const MISSING_KEYS = [...new Set([QA_PROVIDER, SUMMARY_PROVIDER])].filter((p) => !HAS_KEY_FOR[p]).map((p) => KEY_NAME[p]);
const AI_READY = MOCK || MISSING_KEYS.length === 0;
const NOT_CONFIGURED = `AI is not configured on the server (set ${MISSING_KEYS.join(' and ') || 'the API key'}).`;

const usesProvider = (p) => QA_PROVIDER === p || SUMMARY_PROVIDER === p;
const client = HAS_ANTHROPIC_KEY && usesProvider('anthropic') && !MOCK ? new Anthropic() : null;

// Cloud speech recognition. Claude cannot take audio input, so spoken questions are transcribed by an
// OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, or a self-hosted Whisper server) and the
// text is then answered by the AI model (Claude or OpenAI). Unlike the phone's built-in recognizer these handle mixed languages.
function transcribeConfig() {
  const env = process.env;
  let provider = (env.TRANSCRIBE_PROVIDER || '').toLowerCase();
  if (!provider) provider = env.TRANSCRIBE_BASE_URL ? 'custom' : env.OPENAI_API_KEY ? 'openai' : env.GROQ_API_KEY ? 'groq' : '';
  const presets = {
    openai: { base: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', key: env.OPENAI_API_KEY || env.TRANSCRIBE_API_KEY, model: 'gpt-4o-transcribe' },
    groq: { base: 'https://api.groq.com/openai/v1', key: env.GROQ_API_KEY || env.TRANSCRIBE_API_KEY, model: 'whisper-large-v3' },
    custom: { base: env.TRANSCRIBE_BASE_URL, key: env.TRANSCRIBE_API_KEY || '', model: 'whisper-1' },
  };
  const preset = presets[provider];
  if (!preset) return MOCK ? { available: true, provider: 'mock', model: 'mock' } : { available: false, provider: '' };
  const base = String(env.TRANSCRIBE_BASE_URL || preset.base || '').replace(/\/+$/, '');
  const available = MOCK || Boolean(base && (preset.key || provider === 'custom'));
  return { available, provider: MOCK ? 'mock' : provider, base, key: preset.key || '', model: env.TRANSCRIBE_MODEL || preset.model };
}
const STT = transcribeConfig();

// Server voices (the player's second voice engine; the first is the phone's own): TTS_PROVIDER picks who makes the audio.
const TTS_CFG = ttsConfig(process.env, { mock: MOCK });
const TTS = TTS_CFG.available ? createTts(TTS_CFG, { cacheBytes: (Number(process.env.TTS_CACHE_MB) || 64) * 1024 * 1024 }) : null;
if (TTS_CFG.reason && TTS_CFG.reason !== 'off') console.warn(`[config] server voices (TTS_PROVIDER=${TTS_CFG.provider}) are not available: ${TTS_CFG.reason}`);
let lastAsk = null; // mock-mode only: lets tests inspect exactly what would have been sent

// ---------------------------------------------------------------- helpers
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.epub': 'application/epub+zip', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
};

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store', ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readJson(req, limit = 1_500_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const hits = new Map();
function rateLimited(ip, max = 240, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return arr.length > max;
}

function tokenOk(req) {
  if (!ACCESS_TOKEN) return true;
  const given = String(req.headers['x-access-token'] || '');
  const a = Buffer.from(given), b = Buffer.from(ACCESS_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const isStr = (v, max) => typeof v === 'string' && v.length <= max;

function validateAsk(b) {
  if (!isStr(b.question, LIMITS.question) || !b.question.trim()) return 'question missing';
  if (!isStr(b.recent, LIMITS.recent)) return 'recent text missing or too long';
  for (const key of ['summaries', 'passages', 'history']) if (b[key] !== undefined && !Array.isArray(b[key])) return `${key} must be an array`;
  if ((b.summaries || []).length > LIMITS.summaries) return 'too many summaries';
  if ((b.passages || []).length > LIMITS.passages) return 'too many passages';
  for (const s of b.summaries || []) if (!isStr(s?.text, LIMITS.summaryText) || !isStr(s?.label ?? '', LIMITS.label)) return 'bad summary entry';
  for (const p of b.passages || []) if (!isStr(p?.text, LIMITS.passageText) || !isStr(p?.label ?? '', LIMITS.label)) return 'bad passage entry';
  for (const h of b.history || []) if (!isStr(h?.q, LIMITS.question) || !isStr(h?.a, LIMITS.historyText)) return 'bad history entry';
  if (b.player !== undefined) {
    const p = b.player;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'player must be an object';
    for (const k of ['chapterNumber', 'chapterCount', 'percent', 'rate']) if (p[k] !== undefined && !Number.isFinite(p[k])) return `player.${k} must be a number`;
    if (p.chapterTitle !== undefined && !isStr(p.chapterTitle, LIMITS.label)) return 'bad player.chapterTitle';
    if (p.sleep !== undefined && !isStr(p.sleep, 40)) return 'bad player.sleep';
    if (p.chapterTitles !== undefined) {
      if (!Array.isArray(p.chapterTitles) || p.chapterTitles.length > LIMITS.chapterTitles) return 'too many chapter titles';
      for (const c of p.chapterTitles) if (!Number.isInteger(c?.n) || !isStr(c?.title ?? '', LIMITS.label)) return 'bad chapter title entry';
    }
  }
  return null;
}

function validateSummary(b) {
  if (b.kind === 'merge') {
    if (!Array.isArray(b.parts) || b.parts.length < 2 || b.parts.length > LIMITS.mergeParts) return 'parts must be 2..16 notes';
    if (!b.parts.every((p) => isStr(p, LIMITS.summaryText))) return 'bad part';
    return null;
  }
  if (b.kind === 'segment') return isStr(b.text, LIMITS.segmentText) && b.text.trim() ? null : 'text missing or too long';
  return 'unknown kind';
}

// `effort` is accepted by the current Opus/Sonnet/Fable models but rejected by Haiku 4.5 and older models.
const supportsEffort = (model) => !/haiku|claude-3|sonnet-4-5|opus-4-1|opus-4-0|opus-4-5/.test(model);
// Models that turned out to reject the server-side fallbacks beta: remember it instead of failing every call once.
const noFallbacks = new Set();

function modelParams(model, effort, built, { fallbacks }) {
  const params = {
    model,
    max_tokens: built.maxTokens || 4096,
    system: built.system,
    messages: built.messages,
  };
  if (effort && supportsEffort(model)) params.output_config = { effort };
  if (built.tools?.length) params.tools = built.tools;
  if (fallbacks) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
  return params;
}

const textOf = (message) => message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
const toolCallsOf = (message) => message.content.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name, input: b.input && typeof b.input === 'object' ? b.input : {} }));

/**
 * Mock mode has no model, so tests can script one: a question such as `[tool:rewind_sentences]{"count":3}` makes the
 * "model" call that tool (several `[tool:…]` in a row are several calls), and `[tool:…]{…}|then say this` also answers.
 */
function mockToolCalls(question) {
  if (!question.startsWith('[tool:')) return null;
  const [calls, ...say] = question.split('|');
  const tools = calls.split('[tool:').slice(1).map((piece) => {
    const end = piece.indexOf(']');
    let input = {};
    try { input = JSON.parse(piece.slice(end + 1).trim() || '{}'); } catch { /* keep {} */ }
    return { name: piece.slice(0, end), input };
  });
  return { tools, text: say.join('|').trim() };
}

function describeError(err) {
  if (err instanceof OpenAIError) {
    if (err.status === 401) return { status: 401, message: 'OpenAI API key was rejected (check OPENAI_API_KEY).' };
    if (err.status === 403) return { status: 403, message: 'This OpenAI key is not allowed to use the configured model.' };
    if (err.status === 404) return { status: 404, message: `Model not found (${err.message}).` };
    if (/insufficient_quota|no credits|billing/i.test(`${err.code} ${err.message}`)) return { status: 402, message: 'The OpenAI account has no credit left — add credit at platform.openai.com (Billing).' };
    if (err.status === 429) return { status: 429, message: 'Rate limited by the OpenAI API; try again shortly.' };
    if (err.status === 400) return { status: 400, message: `Bad request: ${err.message}` };
    return { status: err.status || 500, message: `OpenAI API error ${err.status}: ${err.message}` };
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return { status: 502, message: 'Could not reach the AI provider.' };
  if (err instanceof Anthropic.AuthenticationError) return { status: 401, message: 'Anthropic API key was rejected (check ANTHROPIC_API_KEY).' };
  if (err instanceof Anthropic.PermissionDeniedError) return { status: 403, message: 'This API key is not allowed to use the configured model.' };
  if (err instanceof Anthropic.NotFoundError) return { status: 404, message: `Model not found (${err.message}).` };
  if (err instanceof Anthropic.RateLimitError) return { status: 429, message: 'Rate limited by the Anthropic API; try again shortly.' };
  if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) return { status: 402, message: 'The Anthropic account has no credit left — add credit in the Anthropic console (Plans & Billing).' };
  if (err instanceof Anthropic.BadRequestError) return { status: 400, message: `Bad request: ${err.message}` };
  if (err instanceof Anthropic.APIConnectionError) return { status: 502, message: 'Could not reach the Anthropic API.' };
  if (err instanceof Anthropic.APIError) return { status: err.status || 500, message: `Anthropic API error ${err.status}: ${err.message}` };
  return { status: 500, message: err?.message || 'unexpected error' };
}

// ---------------------------------------------------------------- talking to the model
// Both providers resolve to { text, tools:[{name,input}], refusal, stop, model, usage:{in,cacheRead,cacheWrite,out} }.

/** Anthropic: streams, and asks for the server-side refusal fallbacks when the account allows them. */
async function callAnthropic({ model, effort, built, signal, onText }) {
  let retriedAfterReject = false;
  let attempt = FALLBACKS && !noFallbacks.has(model) ? 0 : 1; // attempt 0 = with refusal fallbacks, 1 = without
  for (;;) {
    let sent = false;
    try {
      const params = modelParams(model, effort, { ...built, maxTokens: 4096 }, { fallbacks: attempt === 0 });
      const stream = client.beta.messages.stream(params, { signal });
      if (onText) stream.on('text', (delta) => { sent = true; onText(delta); });
      const final = await stream.finalMessage();
      if (attempt === 1 && FALLBACKS && retriedAfterReject) noFallbacks.add(model);
      const u = final.usage || {};
      return {
        text: textOf(final), tools: toolCallsOf(final), refusal: final.stop_reason === 'refusal', stop: final.stop_reason, model: final.model,
        usage: { in: u.input_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, out: u.output_tokens },
      };
    } catch (err) {
      // The fallbacks beta is an optimisation; if the account/platform rejects it, retry once without it.
      if (attempt === 0 && !sent && !signal.aborted && err instanceof Anthropic.BadRequestError) { attempt = 1; retriedAfterReject = true; console.warn('[ai] retrying without fallbacks:', err.message); continue; }
      throw err;
    }
  }
}

/** OpenAI (Responses API, or Chat Completions for other servers). The reasoning effort a model accepts is negotiated once per model. */
const effortChoice = new Map(); // model -> index into its candidate list that the API accepted
async function callOpenAI({ model, effort, built, signal, onText }) {
  const candidates = effortCandidates(model, effort, OPENAI_API);
  let i = Math.min(effortChoice.get(model) ?? 0, candidates.length - 1);
  for (;;) {
    let sent = false;
    try {
      const r = await openaiRequest(OPENAI_API, {
        model, built, effort: candidates[i], maxTokens: 4096, base: OPENAI_BASE, key: process.env.OPENAI_API_KEY, signal,
        onText: onText && ((d) => { sent = true; onText(d); }),
      });
      effortChoice.set(model, i);
      return { text: r.text, tools: r.tools, refusal: r.refusal, stop: r.finish, model: r.model, effort: candidates[i], usage: { in: r.usage.in, cacheRead: r.usage.cached, cacheWrite: 0, out: r.usage.out } };
    } catch (err) {
      if (isEffortError(err) && !sent && !signal.aborted && i < candidates.length - 1) {
        console.warn(`[ai] ${model} rejected reasoning effort ${candidates[i]} (${err.message.slice(0, 140)}); trying ${candidates[i + 1] ?? 'none set'}`);
        i++;
        continue;
      }
      throw err;
    }
  }
}

const callModel = (provider, args) => (provider === 'openai' ? callOpenAI(args) : callAnthropic(args));
const usageLine = (u) => `in=${u.in} cache_read=${u.cacheRead} cache_write=${u.cacheWrite} out=${u.out}`;

// ---------------------------------------------------------------- /api/ask
async function handleAsk(req, res) {
  const body = await readJson(req);
  const problem = validateAsk(body);
  if (problem) return send(res, 400, { error: problem });
  if (!AI_READY) return send(res, 503, { error: NOT_CONFIGURED });

  const built = buildAskRequest(body);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  try {
    if (MOCK) {
      lastAsk = { at: Date.now(), system: built.system, messages: built.messages, tools: built.tools.map((t) => t.name) };
      const scripted = mockToolCalls(body.question.trim());
      if (scripted) {
        for (let i = 0; i < scripted.text.length && !ac.signal.aborted; i += 4) emit({ t: scripted.text.slice(i, i + 4) });
        emit({ tools: scripted.tools });
        emit({ done: true });
        return res.end();
      }
      const tail = body.recent.replace(/\s+/g, ' ').slice(-24);
      const reply = `（模擬回答）你問的是「${body.question.slice(0, 40)}」。我現在只讀到「${tail}」。目前有 ${(body.summaries || []).length} 則摘要、${(body.passages || []).length} 段前文可參考。`;
      for (let i = 0; i < reply.length && !ac.signal.aborted; i += 4) {
        emit({ t: reply.slice(i, i + 4) });
        await new Promise((r) => setTimeout(r, 25));
      }
      emit({ done: true });
      return res.end();
    }

    const r = await callModel(QA_PROVIDER, { model: QA_MODEL, effort: QA_PROVIDER === 'openai' ? QA_EFFORT_OPENAI : QA_EFFORT, built, signal: ac.signal, onText: (delta) => emit({ t: delta }) });
    if (r.tools.length) emit({ tools: r.tools });
    if (r.refusal) emit({ refusal: true });
    console.log(`[ask] ${r.model}${r.effort ? ` effort=${r.effort}` : ''} ${usageLine(r.usage)} stop=${r.stop}${r.tools.length ? ` tools=${r.tools.map((t) => t.name).join(',')}` : ''}`);
    emit({ done: true });
    return res.end();
  } catch (err) {
    if (ac.signal.aborted) return res.end();
    const info = describeError(err);
    console.error('[ask] error:', info.message);
    emit({ error: info.message, status: info.status });
    return res.end();
  }
}

// ---------------------------------------------------------------- /api/summarize
async function handleSummarize(req, res) {
  const body = await readJson(req);
  const problem = validateSummary(body);
  if (problem) return send(res, 400, { error: problem });
  if (!AI_READY) return send(res, 503, { error: NOT_CONFIGURED });

  if (MOCK) {
    const src = body.kind === 'merge' ? body.parts.join(' ') : body.text;
    return send(res, 200, { summary: `【模擬摘要】${src.replace(/\s+/g, ' ').slice(0, 50)}…` });
  }
  const built = buildSummaryRequest(body);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const r = await callModel(SUMMARY_PROVIDER, { model: SUMMARY_MODEL, effort: SUMMARY_PROVIDER === 'openai' ? SUMMARY_EFFORT_OPENAI : SUMMARY_EFFORT, built, signal: ac.signal });
    if (r.refusal) return send(res, 200, { summary: null, refusal: true });
    console.log(`[summarize:${body.kind}] ${r.model} in=${r.usage.in} out=${r.usage.out} stop=${r.stop}`);
    return send(res, 200, { summary: r.text || null });
  } catch (err) {
    if (ac.signal.aborted) return res.end();
    const info = describeError(err);
    console.error('[summarize] error:', info.message);
    return send(res, info.status, { error: info.message });
  }
}

// ---------------------------------------------------------------- /api/transcribe
const AUDIO_TYPES = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3' };
// Whisper-family models sometimes "hear" these when given near-silence; never treat them as a question.
const HALLUCINATIONS = /^(?:[\s\p{P}]*)(?:thanks? for watching|thank you(?: so much)?(?: for watching)?|please subscribe|subtitles? by.*|字幕由.*(?:提供|製作).*|請不吝點贊.*|感謝(?:您的)?(?:觀看|收看|收聽).*|謝謝(?:大家)?(?:觀看|收看|收聽)?|ご視聴ありがとうございました.*|시청해 주셔서 감사합니다.*|amara\.org.*|you)[\s\p{P}]*$/iu;

async function handleTranscribe(req, res) {
  const body = await readJson(req, 12_000_000);
  if (!STT.available) return send(res, 503, { error: 'Cloud speech recognition is not configured on the server (set OPENAI_API_KEY or GROQ_API_KEY).' });
  const mime = String(body.mime || '').split(';')[0].trim().toLowerCase();
  const ext = AUDIO_TYPES[mime];
  if (!ext) return send(res, 400, { error: `unsupported audio type "${mime}"` });
  if (typeof body.audio !== 'string' || !body.audio.length) return send(res, 400, { error: 'audio missing' });
  const bytes = Buffer.from(body.audio, 'base64');
  if (bytes.length < 200) return send(res, 400, { error: 'audio too short' });
  if (bytes.length > 9_000_000) return send(res, 413, { error: 'audio too long' });
  const language = /^[a-z]{2,3}$/.test(String(body.language || '')) ? String(body.language) : '';
  const { prompt, instruction, context } = buildTranscribePrompt({
    uiLang: String(body.uiLang || '').slice(0, 12), bookLang: String(body.bookLang || '').slice(0, 12),
    context: typeof body.context === 'string' ? body.context.slice(-400) : '',
  });

  if (MOCK) return send(res, 200, { text: `（模擬語音）這是模擬的辨識結果 ${bytes.length}B ${language} ${body.context ? '有提示' : ''}`.trim(), model: 'mock' });

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), `question.${ext}`);
  form.append('model', STT.model);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (language) form.append('language', language);
  form.append('prompt', prompt);

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const t0 = Date.now();
  let upstream;
  try {
    upstream = await fetch(`${STT.base}/audio/transcriptions`, {
      method: 'POST', body: form, headers: STT.key ? { Authorization: `Bearer ${STT.key}` } : {},
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(45_000)]),
    });
  } catch (err) {
    if (ac.signal.aborted) return res.end();
    console.error('[transcribe] network error:', err.message);
    return send(res, 502, { error: 'Could not reach the speech recognition service.' });
  }
  if (!upstream.ok) {
    let detail = '', code = '';
    try { const e = (await upstream.json())?.error; detail = e?.message || ''; code = e?.code || e?.type || ''; } catch { /* not JSON */ }
    console.error(`[transcribe] upstream ${upstream.status}: ${detail}`);
    // Never pass an upstream 401 through: the browser would mistake it for a wrong ACCESS_TOKEN.
    // A 429 can mean "slow down" or "your account has no credit left"; those need different reactions.
    const outOfCredit = upstream.status === 402 || /insufficient_quota|billing|no credits|credit balance/i.test(`${code} ${detail}`);
    const status = outOfCredit ? 402 : upstream.status === 429 ? 429 : upstream.status === 400 || upstream.status === 413 ? 400 : 502;
    const msg = outOfCredit ? `The speech recognition account (${STT.provider}) has no credit left — add credit in its billing settings. (${detail})`
      : upstream.status === 401 || upstream.status === 403 ? 'The speech recognition key was rejected (check the key in .env).'
      : `Speech recognition failed (${upstream.status})${detail ? ': ' + detail : ''}`;
    return send(res, status, { error: msg });
  }
  const data = await upstream.json().catch(() => ({}));
  let text = String(data.text || '').trim();
  if (HALLUCINATIONS.test(text) || isPromptEcho(text, instruction, context)) text = '';
  console.log(`[transcribe] ${STT.provider}/${STT.model} ${bytes.length}B ${language || 'auto'} → ${text.length} chars in ${Date.now() - t0} ms`);
  return send(res, 200, { text, model: STT.model, languages: data.languages });
}

// ---------------------------------------------------------------- /api/tts (server voices)
function ttsUnavailable(res) {
  return send(res, 503, { error: `Server voices are not available on this server${TTS_CFG.reason ? ` (${TTS_CFG.reason})` : ''}.` });
}

function ttsFailed(res, err, what) {
  if (err instanceof TtsError) {
    if (err.status >= 500) console.error(`[tts] ${what}: ${err.message}`);
    return send(res, err.status, { error: err.message });
  }
  console.error(`[tts] ${what}:`, err);
  return send(res, 500, { error: 'server voices failed unexpectedly' });
}

async function handleTtsVoices(req, res) {
  const body = await readJson(req, 4_000);
  if (!TTS) return ttsUnavailable(res);
  try {
    const found = await TTS.voices(typeof body.lang === 'string' ? body.lang : '');
    return send(res, 200, { provider: TTS.provider, label: TTS.label, ...found });
  } catch (err) { return ttsFailed(res, err, 'voices'); }
}

async function handleTts(req, res) {
  const body = await readJson(req, 20_000);
  if (!TTS) return ttsUnavailable(res);
  if (typeof body.text !== 'string') return send(res, 400, { error: 'text missing' });
  const t0 = Date.now();
  try {
    const out = await TTS.synthesize({
      text: body.text, lang: typeof body.lang === 'string' ? body.lang : '', voice: typeof body.voice === 'string' ? body.voice : '',
      voices: body.voices, mixed: typeof body.mixed === 'string' ? body.mixed : '',
    });
    console.log(`[tts] ${TTS.provider}/${out.voice} ${[...body.text].length} chars${out.parts > 1 ? `, ${out.parts} parts` : ''} → ${Math.round(out.audio.length / 1024)} KB in ${Date.now() - t0} ms${out.cached ? ' (cached)' : ''}`); // never the text itself
    res.writeHead(200, { 'Content-Type': out.type, 'Content-Length': out.audio.length, 'Cache-Control': 'no-store', 'X-TTS-Voice': out.voice, 'X-TTS-Parts': out.parts });
    return res.end(out.audio);
  } catch (err) { return ttsFailed(res, err, 'synthesize'); }
}

// ---------------------------------------------------------------- static files
function serveStatic(req, res, urlPath, base = PUBLIC) {
  let rel = decodeURIComponent(urlPath);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(base, rel));
  if (file !== base && !file.startsWith(base + path.sep)) return send(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    const isVendor = rel.startsWith('/vendor/');
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': isVendor ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'microphone=(self), wake-lock=(self)',
      ...(rel === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      const ip = req.socket.remoteAddress || '?';
      if (p === '/api/config' && req.method === 'GET') {
        return send(res, 200, { ai: AI_READY, mock: MOCK, needsToken: Boolean(ACCESS_TOKEN), models: { qa: QA_MODEL, summary: SUMMARY_MODEL }, providers: { qa: QA_PROVIDER, summary: SUMMARY_PROVIDER }, stt: { available: STT.available, provider: STT.provider, model: STT.model || '' }, tts: ttsPublicInfo(TTS_CFG) });
      }
      if (p === '/api/debug/last-ask' && MOCK) return send(res, 200, lastAsk || {});
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      if (!tokenOk(req)) return send(res, 401, { error: 'access token required or wrong' });
      if (rateLimited(ip)) return send(res, 429, { error: 'too many requests' });
      if (p === '/api/ask') return await handleAsk(req, res);
      if (p === '/api/summarize') return await handleSummarize(req, res);
      if (p === '/api/transcribe') return await handleTranscribe(req, res);
      if (p === '/api/tts') return await handleTts(req, res);
      if (p === '/api/tts/voices') return await handleTtsVoices(req, res);
      return send(res, 404, { error: 'unknown endpoint' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    if (MOCK && p.startsWith('/__fixtures/')) return serveStatic(req, res, p.replace('/__fixtures', ''), path.join(ROOT, 'fixtures'));
    return serveStatic(req, res, p);
  } catch (err) {
    if (res.headersSent) return res.end();
    send(res, err.status || 500, { error: err.message || 'server error' });
  }
}

// ---------------------------------------------------------------- startup
const SETUP_PORT = PORT + 1;

/** A port that cannot be opened is by far the most common startup problem (the server is already running somewhere), so say so plainly. */
function portProblem(err, port) {
  if (err.code === 'EACCES') return `
  Port ${port} needs administrator rights on this computer. Pick a port above 1023, e.g.  PORT=3100 npm start
`;
  const appPort = USE_HTTPS ? SETUP_PORT : PORT;
  return `
  Port ${port} is already in use. Most likely the audiobook server is already running (in another window, or in the background).
    • Just use it:                http://localhost:${appPort}
    • Or stop it and start again:
        Windows:      netstat -ano | findstr :${port}      then   taskkill /PID <number> /F
        macOS/Linux:  lsof -i :${port}                     then   kill <PID>
    • Or run this copy on other ports:   PORT=3100 npm start      (Windows cmd: set PORT=3100 && npm start)
`;
}

function listen(server, port) {
  return new Promise((resolve) => {
    const onError = (err) => {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      console.error(portProblem(err, port));
      process.exit(1);
    };
    server.once('error', onError);
    server.listen(port, HOST, () => { server.off('error', onError); resolve(); });
  });
}

async function startServers() {
  if (!USE_HTTPS) {
    await listen(http.createServer(route), PORT);
    return { scheme: 'http', certs: null };
  }
  const { ensureLanCerts } = await import('./lan-cert.js');
  const certs = ensureLanCerts(process.env.CERT_DIR || path.join(ROOT, '.certs'));
  if (certs.createdCa) console.log('Created a personal certificate authority in .certs/ (keep that folder private).');
  else if (certs.renewed) console.log('Refreshed the server certificate for the current addresses (phones keep trusting it).');

  await listen(https.createServer({ key: certs.key, cert: certs.cert }, route), PORT);

  // Plain-HTTP side door: hands out the CA certificate and sends everything else to the HTTPS site.
  // On this computer itself (localhost) it just serves the app, since localhost counts as a secure origin.
  const setup = http.createServer((req, res) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return route(req, res);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/ca.crt' || p === '/ca.pem') {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="audiobook-ca.crt"', 'Cache-Control': 'no-store' });
      return res.end(certs.caPem);
    }
    if (p === '/ca.cer') {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="audiobook-ca.cer"', 'Cache-Control': 'no-store' });
      return res.end(certs.caDer);
    }
    if (p === '/' || p === '/setup') {
      const lang = pickSetupLang(req.headers['accept-language'], url.searchParams.get('lang') || '');
      return send(res, 200, setupPage({ httpsUrl: `https://${host}:${PORT}`, lang }), { 'Content-Type': 'text/html; charset=utf-8', Vary: 'Accept-Language' });
    }
    res.writeHead(302, { Location: `https://${host}:${PORT}${req.url}` });
    res.end();
  });
  await listen(setup, SETUP_PORT);
  return { scheme: 'https', certs };
}

const { scheme, certs } = await startServers();
const isCgnat = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip); // 100.64.0.0/10 — Tailscale and similar VPNs
const lan = lanAddresses().sort((a, b) => Number(isCgnat(a)) - Number(isCgnat(b)));
const tag = (ip) => (isCgnat(ip) ? '  (Tailscale / VPN)' : '');
console.log(`
  Audiobook companion running${certs ? '  (HTTPS, ready for your phone)' : ''}`);
if (certs) {
  console.log(`  • This computer:   http://localhost:${SETUP_PORT}`);
  for (const ip of lan) console.log(`  • Phone, app:      https://${ip}:${PORT}${tag(ip)}`);
  const first = lan.find((ip) => !isCgnat(ip)) || lan[0];
  if (first) console.log(`  • Phone, 1st time: http://${first}:${SETUP_PORT}   ← open this once to install the certificate`);
} else {
  console.log(`  • This computer:  http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  • On your network: http://${ip}:${PORT}${tag(ip)}   (reading works; the microphone needs HTTPS — set HTTPS=1)`);
}
console.log(`  • Voice: ${STT.available ? `cloud speech recognition via ${STT.provider} (${STT.model || 'mock'})` : 'phone built-in recognition only (set OPENAI_API_KEY or GROQ_API_KEY for cloud recognition that handles mixed languages)'}`);
console.log(`  • Server voices (optional engine in Settings): ${TTS ? `${TTS.label}${TTS.official ? '' : ' — unofficial, can stop working any time'}` : `off${TTS_CFG.reason && TTS_CFG.reason !== 'off' ? ` (${TTS_CFG.reason})` : ''}`}`);
const AI_NAME = { anthropic: 'Claude', openai: 'OpenAI' };
console.log(`  • AI: ${MOCK ? 'MOCK mode (no API calls)' : AI_READY ? `${QA_PROVIDER === SUMMARY_PROVIDER ? AI_NAME[QA_PROVIDER] : `${AI_NAME[QA_PROVIDER]} / ${AI_NAME[SUMMARY_PROVIDER]}`} — answers: ${QA_MODEL}, memory: ${SUMMARY_MODEL}` : `NOT CONFIGURED (set ${MISSING_KEYS.join(' and ')} in .env)`}`);
if (!MOCK && AI_READY && usesProvider('openai')) console.log(`    OpenAI API: ${OPENAI_API === 'responses' ? 'Responses' : 'Chat Completions'} (${OPENAI_BASE}), reasoning effort: ${process.env.QA_EFFORT || 'auto → low'}`);
if (ACCESS_TOKEN) console.log('  • Access token required for /api/* (set it in the app settings)');
console.log('');
