// Exercises the real server.js against a fake Anthropic API (so no key or network is needed):
// checks the exact request we send, SSE streaming to the browser, fallback retry and error mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAskRequest, buildSummaryRequest } from '../prompts.js';
import { SentenceStream } from '../public/js/tts.js';
import { pickApi, effortCandidates } from '../openai.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- fake Anthropic API
function sse(events) { return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''); }

function streamBody(text, { stop = 'end_turn', model = 'claude-opus-5-5' } = {}) {
  const chunks = text.match(/[\s\S]{1,5}/g) || [];
  return sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1234, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    ...(text ? [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }] : []),
    ...chunks.map((c) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } })),
    ...(text ? [{ type: 'content_block_stop', index: 0 }] : []),
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: text.length } },
    { type: 'message_stop' },
  ]);
}

function startFakeAnthropic(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const record = { url: req.url, headers: req.headers, body: parsed };
      seen.push(record);
      handler(record, res, seen.length);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

// ---------------------------------------------------------------- server under test
let portCounter = 3400 + Math.floor(Math.random() * 400);
// fetch() refuses "bad ports" outright (3659 is one, in our range), so never hand those out — nor the pair (port, port + 1) around it.
const FETCH_BLOCKED = new Set([3658, 3659]);
function allocPorts(n = 1) {
  while ([...Array(n).keys()].some((i) => FETCH_BLOCKED.has(portCounter + i))) portCounter++;
  const first = portCounter;
  portCounter += n;
  return first;
}
function startApp(env = {}) {
  const port = allocPorts(1);
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ENV_FILE: 'none', PORT: String(port), HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
    const poll = setInterval(() => {
      if (out.includes('running')) { clearInterval(poll); clearTimeout(t); resolve({ base: `http://127.0.0.1:${port}`, child, log: () => out }); }
    }, 50);
  });
}

async function readSse(res) {
  const events = [];
  const text = await res.text();
  for (const block of text.split('\n\n')) if (block.startsWith('data:')) events.push(JSON.parse(block.slice(5)));
  return events;
}

/** The server logs just after it finishes streaming, so poll briefly instead of racing it. */
async function expectLog(app, re, ms = 3000) {
  const t0 = Date.now();
  while (!re.test(app.log()) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
  assert.match(app.log(), re);
}

const askBody = (extra = {}) => ({
  question: '他為什麼要這樣做？', lang: 'zh-TW', chapterTitle: '第三章', progressPct: 12.5,
  summaries: [{ label: '0%–10% · 第一章', text: '主角抵達小鎮。' }],
  passages: [{ label: '5% · 第一章', text: '他把鑰匙放進口袋。' }],
  recent: '他看著窗外，什麼也沒說。', history: [{ q: '他是誰？', a: '他是主角。' }], ...extra,
});

const post = (base, p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

// ---------------------------------------------------------------- tests
test('prompts: system prefix is cacheable, history becomes real turns, everything is delimited', () => {
  const r = buildAskRequest(askBody({ coverageNote: 'x' }));
  assert.equal(r.system.length, 2);
  assert.ok(r.system[0].text.includes('no spoilers'));
  assert.deepEqual(r.system[1].cache_control, { type: 'ephemeral' });
  assert.ok(r.system[1].text.includes('<story_so_far>') && r.system[1].text.includes('主角抵達小鎮'));
  assert.equal(r.messages.length, 3);
  assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  const last = r.messages[2].content;
  assert.ok(last.includes('<earlier_passages>') && last.includes('<just_read>') && last.includes('<question>'));
  assert.ok(last.indexOf('<earlier_passages>') < last.indexOf('<just_read>') && last.indexOf('<just_read>') < last.indexOf('<question>'));
  assert.ok(!JSON.stringify(r).includes('undefined'));
  const noTitle = buildAskRequest(askBody());
  assert.ok(!noTitle.system[1].text.includes('<book>'), 'title is not sent unless the listener opts in');
  assert.ok(buildAskRequest(askBody({ bookInfo: { title: 'T', author: 'A' } })).system[1].text.includes('<book>T — A</book>'));
});

test('prompts: summary requests', () => {
  const seg = buildSummaryRequest({ kind: 'segment', lang: 'zh-TW', text: '一些文字', chapterTitle: '第一章', prevTail: '前情', targetChars: 220 });
  assert.ok(seg.messages[0].content.includes('Traditional Chinese') && seg.messages[0].content.includes('<passage>'));
  const merge = buildSummaryRequest({ kind: 'merge', lang: 'en-US', parts: ['a', 'b'], targetChars: 300 });
  assert.ok(merge.messages[0].content.includes('Note 2:\nb'));
});

test('SentenceStream: speaks sentences as they complete, first clause early', () => {
  const s = new SentenceStream();
  const out = [];
  for (const d of '好的，我來解釋一下這句話的意思。它是說人不要太早放棄！你覺得呢？') out.push(...s.push(d));
  out.push(...s.end());
  assert.equal(out.join(''), '好的，我來解釋一下這句話的意思。它是說人不要太早放棄！你覺得呢？');
  assert.ok(out.length >= 3);
  const e = new SentenceStream();
  const o2 = [...e.push('He said hello. Then he left'), ...e.end()];
  assert.deepEqual(o2, ['He said hello.', 'Then he left']);
  const m = new SentenceStream();
  const o3 = [...m.push('**重點**：\n- 第一\n- 第二。'), ...m.end()].join(' ');
  assert.ok(!/[*]/.test(o3) && !/^-/.test(o3), o3);
});

test('server: /api/ask streams text and sends the exact request shape to the Anthropic API', async () => {
  const fake = await startFakeAnthropic((rec, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(streamBody('這句話的意思是說，他其實很擔心。'));
  });
  const app = await startApp({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: fake.url });
  try {
    const cfg = await (await fetch(app.base + '/api/config')).json();
    assert.equal(cfg.ai, true); assert.equal(cfg.mock, false); assert.equal(cfg.models.qa, 'claude-sonnet-5-5', 'Sonnet 5.5 is the default model'); assert.deepEqual(cfg.providers, { qa: 'anthropic', summary: 'anthropic' });
    const res = await post(app.base, '/api/ask', askBody());
    assert.equal(res.status, 200);
    const events = await readSse(res);
    assert.equal(events.filter((e) => e.t).map((e) => e.t).join(''), '這句話的意思是說，他其實很擔心。');
    assert.ok(events.some((e) => e.done));
    assert.equal(fake.seen.length, 1);
    const { headers, body, url } = fake.seen[0];
    assert.ok(url.startsWith('/v1/messages'));
    assert.equal(headers['x-api-key'], 'sk-test');
    assert.ok(String(headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'));
    assert.equal(body.model, 'claude-sonnet-5-5');
    assert.equal(body.stream, true);
    assert.equal(body.fallbacks, 'default');
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.equal(body.temperature, undefined, 'sampling params are rejected by current models');
    assert.equal(body.thinking, undefined);
    assert.equal(body.system[1].cache_control.type, 'ephemeral');
    assert.equal(body.messages.at(-1).role, 'user');
    assert.ok(body.messages.at(-1).content.includes('他看著窗外'));
  } finally { app.child.kill(); fake.server.close(); }
});

test('server: retries without fallbacks if the API rejects the beta, maps refusals and auth errors', async () => {
  let mode = 'reject-fallbacks';
  const fake = await startFakeAnthropic((rec, res) => {
    if (mode === 'reject-fallbacks' && rec.body.fallbacks) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks not enabled' } }));
    }
    if (mode === 'unauthorized') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(mode === 'refusal' ? streamBody('', { stop: 'refusal' }) : streamBody('好的。'));
  });
  const app = await startApp({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: fake.url });
  try {
    let events = await readSse(await post(app.base, '/api/ask', askBody()));
    assert.equal(events.filter((e) => e.t).map((e) => e.t).join(''), '好的。');
    assert.equal(fake.seen.length, 2, 'one rejected attempt + one retry');
    assert.equal(fake.seen[1].body.fallbacks, undefined);
    assert.ok(!String(fake.seen[1].headers['anthropic-beta'] || '').includes('server-side-fallback'));

    mode = 'refusal';
    events = await readSse(await post(app.base, '/api/ask', askBody()));
    assert.ok(events.some((e) => e.refusal));

    mode = 'unauthorized';
    events = await readSse(await post(app.base, '/api/ask', askBody()));
    const err = events.find((e) => e.error);
    assert.equal(err.status, 401);
    assert.ok(/API key/i.test(err.error));
  } finally { app.child.kill(); fake.server.close(); }
});

test('server: /api/summarize returns the note text; validates input', async () => {
  const fake = await startFakeAnthropic((rec, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(streamBody('主角來到小鎮，遇見了老周。'));
  });
  const app = await startApp({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: fake.url, AI_FALLBACKS: 'off' });
  try {
    const ok = await post(app.base, '/api/summarize', { kind: 'segment', lang: 'zh-TW', text: '很長的一段文字。', chapterTitle: '第一章', targetChars: 220 });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).summary, '主角來到小鎮，遇見了老周。');
    assert.equal(fake.seen[0].body.fallbacks, undefined, 'AI_FALLBACKS=off disables the beta');
    assert.equal((await post(app.base, '/api/summarize', { kind: 'nope' })).status, 400);
    assert.equal((await post(app.base, '/api/summarize', { kind: 'merge', parts: ['only one'] })).status, 400);
    assert.equal((await post(app.base, '/api/ask', { question: '', recent: 'x' })).status, 400);
    assert.equal((await post(app.base, '/api/ask', askBody({ recent: 'x'.repeat(50_000) }))).status, 400);
    assert.equal((await fetch(app.base + '/api/ask')).status, 405);
  } finally { app.child.kill(); fake.server.close(); }
});

test('server: access token gate, static files and path traversal', async () => {
  const app = await startApp({ MOCK_LLM: '1', ACCESS_TOKEN: 'secret-pass' });
  try {
    assert.equal((await post(app.base, '/api/ask', askBody())).status, 401);
    assert.equal((await post(app.base, '/api/ask', askBody(), { 'x-access-token': 'wrong' })).status, 401);
    const events = await readSse(await post(app.base, '/api/ask', askBody(), { 'x-access-token': 'secret-pass' }));
    assert.ok(events.some((e) => e.t) && events.some((e) => e.done));
    const cfg = await (await fetch(app.base + '/api/config')).json();
    assert.equal(cfg.needsToken, true);
    const idx = await fetch(app.base + '/');
    assert.equal(idx.status, 200);
    assert.ok((await idx.text()).includes('askBtn'));
    assert.equal((await fetch(app.base + '/sw.js')).headers.get('service-worker-allowed'), '/');
    assert.equal((await fetch(app.base + '/../server.js')).status === 200, false);
    assert.equal((await fetch(app.base + '/%2e%2e/server.js')).status === 200, false);
    assert.equal((await fetch(app.base + '/nope.txt')).status, 404);
    const last = await (await fetch(app.base + '/api/debug/last-ask')).json();
    assert.ok(last.messages?.length, 'mock mode records the last prompt for inspection');
  } finally { app.child.kill(); }
});

test('server: without an API key /api/ask reports 503 instead of crashing', async () => {
  const env = { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  const port = allocPorts(1);
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...env, ENV_FILE: 'none', PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((r) => setTimeout(r, 1200));
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    assert.equal(cfg.ai, false);
    assert.equal((await post(`http://127.0.0.1:${port}`, '/api/ask', askBody())).status, 503);
  } finally { child.kill(); }
});

test('server: Haiku memory model gets no effort parameter, and a rejected fallbacks beta is remembered', async () => {
  const fake = await startFakeAnthropic((rec, res) => {
    if (rec.body.fallbacks) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks is not supported for this model' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(streamBody('摘要內容。', { model: 'claude-haiku-4-5' }));
  });
  const app = await startApp({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: fake.url, SUMMARY_MODEL: 'claude-haiku-4-5' });
  try {
    const req = { kind: 'segment', lang: 'zh-TW', text: '一段文字。', targetChars: 220 };
    assert.equal((await (await post(app.base, '/api/summarize', req)).json()).summary, '摘要內容。');
    assert.equal(fake.seen.length, 2, 'first call: rejected attempt + retry');
    assert.equal(fake.seen[1].body.model, 'claude-haiku-4-5');
    assert.equal(fake.seen[1].body.output_config, undefined, 'Haiku 4.5 rejects the effort parameter');
    assert.equal((await (await post(app.base, '/api/summarize', req)).json()).summary, '摘要內容。');
    assert.equal(fake.seen.length, 3, 'second call goes straight to the working request shape');
  } finally { app.child.kill(); fake.server.close(); }
});

test('server: HTTPS mode serves the app over a trusted chain and a plain-HTTP setup page for phones', async () => {
  const { default: fsx } = await import('node:fs');
  const { default: osx } = await import('node:os');
  const { default: httpsx } = await import('node:https');
  const certDir = fsx.mkdtempSync(path.join(osx.tmpdir(), 'lan-srv-'));
  const httpsPort = allocPorts(2);
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ENV_FILE: 'none', PORT: String(httpsPort), HOST: '127.0.0.1', HTTPS: '1', MOCK_LLM: '1', CERT_DIR: certDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 100 && !log.includes('running'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(log.includes('running'), log);
    const ca = fsx.readFileSync(path.join(certDir, 'ca.crt'), 'utf8');
    const getHttps = (p) => new Promise((resolve, reject) => httpsx.get({ host: '127.0.0.1', port: httpsPort, path: p, ca }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject));
    const cfg = await getHttps('/api/config');
    assert.equal(cfg.status, 200);
    assert.equal(JSON.parse(cfg.body).mock, true);
    assert.ok((await getHttps('/')).body.includes('askBtn'));

    const { default: httpx } = await import('node:http');
    const raw = (p, host) => new Promise((resolve, reject) => httpx.get({ host: '127.0.0.1', port: httpsPort + 1, path: p, headers: { Host: host } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject));
    const lanHost = `192.168.1.10:${httpsPort + 1}`;
    // From another device (any Host that is not localhost) the HTTP port is a setup page + certificate download.
    const page = await raw('/', lanHost);
    const html = page.body.toString('utf8');
    assert.equal(page.status, 200);
    assert.ok(html.includes('/ca.crt') && html.includes(`https://192.168.1.10:${httpsPort}`), 'setup page links to the certificate and the HTTPS app');
    const crt = await raw('/ca.crt', lanHost);
    assert.equal(crt.headers['content-type'], 'application/x-x509-ca-cert');
    assert.equal(crt.body.toString('utf8').trim(), ca.trim());
    const der = await raw('/ca.cer', lanHost);
    assert.equal(der.body[0], 0x30);
    const redirect = await raw('/library?x=1', lanHost);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, `https://192.168.1.10:${httpsPort}/library?x=1`);
    // On the computer itself the same port just serves the app (localhost is a secure origin even without TLS).
    const local = await raw('/', `localhost:${httpsPort + 1}`);
    assert.ok(local.body.toString('utf8').includes('askBtn'));
    assert.equal(fsx.existsSync(path.join(certDir, 'ca.key.pem')), true);
  } finally { child.kill(); }
});

// ---------------------------------------------------------------- cloud speech recognition
function fakeTranscriber(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] || '' } }).formData().catch(() => null);
    const rec = { url: req.url, headers: req.headers, form };
    seen.push(rec);
    handler(rec, res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}/v1` })));
}
const audioBody = (extra = {}) => ({ audio: Buffer.alloc(3000, 7).toString('base64'), mime: 'audio/webm;codecs=opus', ...extra });
const sttEnv = (fake, extra = {}) => ({ MOCK_LLM: '', TRANSCRIBE_PROVIDER: 'custom', TRANSCRIBE_BASE_URL: fake.base, TRANSCRIBE_API_KEY: 'stt-key', TRANSCRIBE_MODEL: 'my-model', ...extra });

test('cloud recognition: uploads the recording as multipart with model, language and vocabulary hint', async () => {
  const fake = await fakeTranscriber((rec, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: '這個 sentence 是什麼意思？' })); });
  const app = await startApp(sttEnv(fake));
  try {
    const cfg = await (await fetch(app.base + '/api/config')).json();
    assert.deepEqual(cfg.stt, { available: true, provider: 'custom', model: 'my-model' });
    const r = await post(app.base, '/api/transcribe', audioBody({ language: 'zh', uiLang: 'zh-TW', bookLang: 'zh-TW', context: '林曉晴推開老茶館的木門。' }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).text, '這個 sentence 是什麼意思？');
    const { headers, form, url } = fake.seen[0];
    assert.equal(url, '/v1/audio/transcriptions');
    assert.equal(headers.authorization, 'Bearer stt-key');
    assert.equal(form.get('model'), 'my-model');
    assert.equal(form.get('language'), 'zh');
    const prompt = form.get('prompt');
    assert.ok(prompt.includes('林曉晴推開老茶館的木門。'), 'book text is passed as context');
    assert.match(prompt, /繁體/, 'the instruction asks for Traditional characters');
    assert.match(prompt, /不要把英文翻成中文/, 'the instruction forbids translating / dropping the second language');
    assert.ok(prompt.trim().endsWith('不要省略任何一段。'), 'instruction comes last (Whisper-style models keep the prompt tail)');
    assert.equal(form.get('response_format'), 'json');
    const file = form.get('file');
    assert.equal(file.name, 'question.webm');
    assert.equal(file.size, 3000);
  } finally { app.child.kill(); fake.server.close(); }
});

test('cloud recognition: automatic language detection sends no language field; near-silence hallucinations become empty text', async () => {
  let reply = '請問這句話的意思';
  const fake = await fakeTranscriber((rec, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: reply })); });
  const app = await startApp(sttEnv(fake));
  try {
    assert.equal((await (await post(app.base, '/api/transcribe', audioBody())).json()).text, '請問這句話的意思');
    assert.equal(fake.seen[0].form.has('language'), false, 'no language field lets the model detect mixed languages');
    assert.match(fake.seen[0].form.get('prompt'), /Transcribe verbatim/, 'the instruction is sent even without any book text or language');
    for (const ghost of ['Thank you.', 'Thanks for watching!', '字幕由 Amara.org 社群提供', '謝謝觀看', 'you']) {
      reply = ghost;
      assert.equal((await (await post(app.base, '/api/transcribe', audioBody())).json()).text, '', `"${ghost}" is a known silence hallucination`);
    }
    reply = 'Thank you for the explanation, but what does this sentence mean?';
    assert.ok((await (await post(app.base, '/api/transcribe', audioBody())).json()).text.includes('what does this sentence mean'));
  } finally { app.child.kill(); fake.server.close(); }
});

test('cloud recognition: upstream errors never look like a wrong access token; input is validated', async () => {
  let status = 401;
  const fake = await fakeTranscriber((rec, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'nope' } })); });
  const app = await startApp(sttEnv(fake));
  try {
    const bad = await post(app.base, '/api/transcribe', audioBody());
    assert.equal(bad.status, 502, 'an upstream 401 must not be forwarded as 401 (the app would think ACCESS_TOKEN is wrong)');
    assert.match((await bad.json()).error, /key was rejected/);
    status = 429; assert.equal((await post(app.base, '/api/transcribe', audioBody())).status, 429);
    status = 500; assert.equal((await post(app.base, '/api/transcribe', audioBody())).status, 502);
    assert.equal((await post(app.base, '/api/transcribe', audioBody({ mime: 'video/mp4' }))).status, 400);
    assert.equal((await post(app.base, '/api/transcribe', { audio: 'AAAA', mime: 'audio/webm' })).status, 400);
    assert.equal((await post(app.base, '/api/transcribe', { mime: 'audio/webm' })).status, 400);
    fake.server.close();
    assert.equal((await post(app.base, '/api/transcribe', audioBody())).status, 502, 'unreachable service');
  } finally { app.child.kill(); fake.server.close(); }
});

test('cloud recognition: provider auto-detection from keys, and 503 when nothing is configured', async () => {
  const clean = { OPENAI_API_KEY: '', GROQ_API_KEY: '', TRANSCRIBE_API_KEY: '', TRANSCRIBE_BASE_URL: '', TRANSCRIBE_PROVIDER: '', TRANSCRIBE_MODEL: '', MOCK_LLM: '' };
  const probe = async (env) => {
    const app = await startApp({ ...clean, ANTHROPIC_API_KEY: 'x', ...env });
    try {
      const cfg = await (await fetch(app.base + '/api/config')).json();
      return { stt: cfg.stt, status: (await post(app.base, '/api/transcribe', audioBody())).status };
    } finally { app.child.kill(); }
  };
  const none = await probe({});
  assert.equal(none.stt.available, false); assert.equal(none.status, 503);
  assert.deepEqual((await probe({ OPENAI_API_KEY: 'sk-x' })).stt, { available: true, provider: 'openai', model: 'gpt-4o-transcribe' });
  assert.deepEqual((await probe({ GROQ_API_KEY: 'gsk-x' })).stt, { available: true, provider: 'groq', model: 'whisper-large-v3' });
  assert.equal((await probe({ OPENAI_API_KEY: 'sk-x', TRANSCRIBE_MODEL: 'gpt-transcribe' })).stt.model, 'gpt-transcribe');
});

test('running out of credit is reported as 402 (not as "busy"), for both the recognizer and Claude', async () => {
  const stt = await fakeTranscriber((rec, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You have no credits remaining. Add credits to continue using the API.' } }));
  });
  const claude = await startFakeAnthropic((rec, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }));
  });
  const app = await startApp(sttEnv(stt, { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: claude.url, AI_FALLBACKS: 'off' }));
  try {
    const r = await post(app.base, '/api/transcribe', audioBody());
    assert.equal(r.status, 402);
    assert.match((await r.json()).error, /no credit left/);
    const events = await readSse(await post(app.base, '/api/ask', askBody()));
    const err = events.find((e) => e.error);
    assert.equal(err.status, 402);
    assert.match(err.error, /no credit left/);
    const sum = await post(app.base, '/api/summarize', { kind: 'segment', lang: 'zh-TW', text: '文字。', targetChars: 200 });
    assert.equal(sum.status, 402);
  } finally { app.child.kill(); stt.server.close(); claude.server.close(); }
});

test('cloud recognition: a model that answers near-silence with the book text or the instruction yields "nothing heard"', async () => {
  let reply = '林曉晴推開老茶館的木門。';
  const fake = await fakeTranscriber((rec, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: reply })); });
  const app = await startApp(sttEnv(fake));
  try {
    const ask = () => post(app.base, '/api/transcribe', audioBody({ uiLang: 'zh-TW', bookLang: 'zh-TW', context: '林曉晴推開老茶館的木門。' })).then((r) => r.json());
    assert.equal((await ask()).text, '', 'echo of the supplied book text');
    reply = '請照說話者實際說的語言逐字轉寫：說中文的部分寫成台灣繁體字';
    assert.equal((await ask()).text, '', 'echo of the instruction');
    reply = '林曉晴為什麼要去老茶館？';
    assert.equal((await ask()).text, '林曉晴為什麼要去老茶館？', 'a real question that mentions book names is kept');
  } finally { app.child.kill(); fake.server.close(); }
});

// ---------------------------------------------------------------- voice commands (tool calling)
function toolStreamBody(calls, text = '') {
  const events = [{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 900, output_tokens: 1 } } }];
  let index = 0;
  if (text) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    for (const c of text.match(/[\s\S]{1,5}/g)) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: c } });
    events.push({ type: 'content_block_stop', index: index++ });
  }
  for (const [k, c] of calls.entries()) {
    const json = JSON.stringify(c.input);
    events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${k}`, name: c.name, input: {} } });
    for (const part of [json.slice(0, 4), json.slice(4)]) events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } });
    events.push({ type: 'content_block_stop', index: index++ });
  }
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }, { type: 'message_stop' });
  return sse(events);
}

test('server: the AI is offered the player tools and its tool calls reach the browser as one "tools" event', async () => {
  const fake = await startFakeAnthropic((rec, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(toolStreamBody([{ name: 'rewind_sentences', input: { count: 3 } }, { name: 'set_reading_speed', input: { rate: 1.25 } }]));
  });
  const app = await startApp({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: fake.url });
  try {
    const player = { chapterNumber: 3, chapterCount: 10, chapterTitle: '第三章', percent: 21.5, rate: 1, sleep: 'off', wasPlaying: true, chapterTitles: [{ n: 1, title: '第一章' }, { n: 2, title: '第二章' }, { n: 3, title: '第三章' }] };
    const events = await readSse(await post(app.base, '/api/ask', askBody({ question: '倒回三句，然後快一點', player })));
    assert.deepEqual(events.find((e) => e.tools).tools, [{ name: 'rewind_sentences', input: { count: 3 } }, { name: 'set_reading_speed', input: { rate: 1.25 } }]);
    assert.equal(events.filter((e) => e.t).length, 0, 'a command produces no text');
    assert.ok(events.some((e) => e.done));
    assert.ok(!events.some((e) => e.error || e.refusal));
    const body = fake.seen[0].body;
    assert.deepEqual(body.tools.map((t) => t.name), ['rewind_sentences', 'skip_forward_sentences', 'go_to_chapter', 'jump_to_earlier_passage', 'seek_to_percent', 'stop_reading', 'resume_reading', 'set_reading_speed', 'ask_listener', 'set_sleep_timer']);
    assert.ok(body.tools.every((t) => t.input_schema?.type === 'object' && t.description));
    assert.equal(body.tool_choice, undefined, 'the AI stays free to answer in text instead');
    const last = body.messages.at(-1).content;
    assert.ok(last.includes('<player_state>') && last.includes('Current chapter: 3 of 10'));
    await expectLog(app, /tools=rewind_sentences,set_reading_speed/);
  } finally { app.child.kill(); fake.server.close(); }
});

test('server: text and a tool call in the same reply are both delivered, in that order', async () => {
  const fake = await startFakeAnthropic((rec, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(toolStreamBody([{ name: 'go_to_chapter', input: { chapter_number: 2 } }], '他是鎮上的醫生。'));
  });
  const app = await startApp({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: fake.url });
  try {
    const events = await readSse(await post(app.base, '/api/ask', askBody()));
    assert.equal(events.filter((e) => e.t).map((e) => e.t).join(''), '他是鎮上的醫生。');
    assert.deepEqual(events.find((e) => e.tools).tools, [{ name: 'go_to_chapter', input: { chapter_number: 2 } }]);
    assert.ok(events.findIndex((e) => e.tools) > events.findLastIndex((e) => e.t), 'the action comes after the spoken answer');
  } finally { app.child.kill(); fake.server.close(); }
});

test('server: a malformed player object is rejected before anything is sent to the AI', async () => {
  const fake = await startFakeAnthropic((rec, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(streamBody('ok')); });
  const app = await startApp({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: fake.url });
  try {
    const good = { chapterNumber: 1, chapterCount: 2, rate: 1, sleep: 'off', chapterTitles: [{ n: 1, title: 'A' }] };
    assert.equal((await post(app.base, '/api/ask', askBody({ player: good }))).status, 200);
    const bad = [
      'x', [], { rate: 'fast' }, { chapterNumber: '3' }, { sleep: 'x'.repeat(100) }, { chapterTitle: 'x'.repeat(500) },
      { chapterTitles: 'nope' }, { chapterTitles: Array.from({ length: 500 }, (_, i) => ({ n: i, title: 't' })) },
      { chapterTitles: [{ n: 'a', title: 't' }] }, { chapterTitles: [{ n: 1, title: 't'.repeat(500) }] },
    ];
    for (const player of bad) assert.equal((await post(app.base, '/api/ask', askBody({ player }))).status, 400, JSON.stringify(player).slice(0, 60));
    assert.equal(fake.seen.length, 1, 'only the valid request reached the AI');
  } finally { app.child.kill(); fake.server.close(); }
});

test('server (mock mode): a scripted question can call tools, so the app can be tested without a model', async () => {
  const app = await startApp({ MOCK_LLM: '1' });
  try {
    let events = await readSse(await post(app.base, '/api/ask', askBody({ question: '[tool:rewind_sentences]{"count":3}' })));
    assert.deepEqual(events.find((e) => e.tools).tools, [{ name: 'rewind_sentences', input: { count: 3 } }]);
    assert.equal(events.filter((e) => e.t).length, 0);
    events = await readSse(await post(app.base, '/api/ask', askBody({ question: '[tool:stop_reading][tool:set_reading_speed]{"rate":2}|好的' })));
    assert.deepEqual(events.find((e) => e.tools).tools, [{ name: 'stop_reading', input: {} }, { name: 'set_reading_speed', input: { rate: 2 } }]);
    assert.equal(events.filter((e) => e.t).map((e) => e.t).join(''), '好的');
    events = await readSse(await post(app.base, '/api/ask', askBody({ question: '一般的問題' })));
    assert.ok(!events.some((e) => e.tools), 'ordinary questions are answered as before');
    const dbg = await (await fetch(app.base + '/api/debug/last-ask')).json();
    assert.ok(dbg.tools.includes('go_to_chapter'));
  } finally { app.child.kill(); }
});

// ---------------------------------------------------------------- OpenAI as the main model
const oaiChunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'gpt-5.5-2026-04-23', choices: [{ index: 0, delta, finish_reason: null, ...extra }] })}\n\n`;
/** A Chat Completions stream: optional text, optional tool calls (arguments arrive in pieces), finish reason, usage. */
function oaiStream({ text = '', calls = [], finish = calls.length ? 'tool_calls' : 'stop', refusal = '', usage = { prompt_tokens: 2100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1024 } } } = {}) {
  let out = oaiChunk({ role: 'assistant', content: '' });
  for (const c of text.match(/[\s\S]{1,4}/g) || []) out += oaiChunk({ content: c });
  if (refusal) out += oaiChunk({ refusal });
  calls.forEach((c, index) => {
    const args = JSON.stringify(c.input);
    out += oaiChunk({ tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: c.name, arguments: '' } }] });
    for (const piece of [args.slice(0, 3), args.slice(3)]) out += oaiChunk({ tool_calls: [{ index, function: { arguments: piece } }] });
  });
  out += `data: ${JSON.stringify({ id: 'chatcmpl-1', model: 'gpt-5.5-2026-04-23', choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`;
  out += `data: ${JSON.stringify({ id: 'chatcmpl-1', model: 'gpt-5.5-2026-04-23', choices: [], usage })}\n\n`;
  return out + 'data: [DONE]\n\n';
}
const oaiOk = (res, body) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(body); };
const oaiErr = (res, status, error) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error })); };
const openaiEnv = (fake, extra = {}) => ({ MOCK_LLM: '', AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-oai-test', OPENAI_BASE_URL: `${fake.url}/v1`, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ...extra });

test('OpenAI as the main model: the request is translated to Chat Completions and the answer streams back', async () => {
  const fake = await startFakeAnthropic((rec, res) => oaiOk(res, oaiStream({ text: '這句話的意思是說，他其實很擔心。' })));
  const app = await startApp(openaiEnv(fake));
  try {
    const cfg = await (await fetch(app.base + '/api/config')).json();
    assert.equal(cfg.ai, true);
    assert.deepEqual(cfg.models, { qa: 'gpt-6.1-sol', summary: 'gpt-6.1-sol' });
    assert.deepEqual(cfg.providers, { qa: 'openai', summary: 'openai' });
    const events = await readSse(await post(app.base, '/api/ask', askBody({ player: { chapterNumber: 2, chapterCount: 9, rate: 1, sleep: 'off' } })));
    assert.equal(events.filter((e) => e.t).map((e) => e.t).join(''), '這句話的意思是說，他其實很擔心。');
    assert.ok(events.some((e) => e.done) && !events.some((e) => e.error || e.refusal || e.tools));
    assert.equal(fake.seen.length, 1);
    const { url, headers, body } = fake.seen[0];
    assert.equal(url, '/v1/chat/completions');
    assert.equal(headers.authorization, 'Bearer sk-oai-test');
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.max_completion_tokens, 4096);
    assert.equal(body.reasoning_effort, 'none', 'on Chat Completions the first value tried is "none" (fast); the Responses API path is tested below');
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.temperature, undefined);
    assert.equal(body.messages[0].role, 'system');
    assert.ok(body.messages[0].content.includes('no spoilers') && body.messages[0].content.includes('<story_so_far>') && body.messages[0].content.includes('主角抵達小鎮'), 'both system blocks are sent, rules first and the story after');
    assert.ok(!JSON.stringify(body).includes('cache_control'));
    assert.deepEqual(body.messages.slice(1, 3).map((m) => m.role), ['user', 'assistant'], 'earlier Q&A stays real turns');
    const last = body.messages.at(-1);
    assert.equal(last.role, 'user');
    assert.ok(last.content.includes('<question>') && last.content.includes('Current chapter: 2 of 9'));
    assert.equal(body.tools.length, 10);
    assert.equal(body.parallel_tool_calls, true, 'two commands in one breath must come back in one reply');
    assert.deepEqual(Object.keys(body.tools[0]), ['type', 'function']);
    assert.equal(body.tools[0].type, 'function');
    assert.deepEqual(body.tools[0].function.parameters.required, ['count'], 'the schema is passed through as `parameters`');
    await expectLog(app, /\[ask\] gpt-5\.5-2026-04-23 effort=none in=2100 cache_read=1024 cache_write=0 out=30 stop=stop/);
  } finally { app.child.kill(); fake.server.close(); }
});

test('OpenAI: tool calls (arguments streamed in pieces) reach the browser, with or without spoken text', async () => {
  let reply;
  const fake = await startFakeAnthropic((rec, res) => oaiOk(res, reply));
  const app = await startApp(openaiEnv(fake));
  try {
    reply = oaiStream({ calls: [{ name: 'rewind_sentences', input: { count: 3 } }, { name: 'set_reading_speed', input: { rate: 1.25 } }] });
    let events = await readSse(await post(app.base, '/api/ask', askBody({ question: '倒回三句然後快一點' })));
    assert.deepEqual(events.find((e) => e.tools).tools, [{ name: 'rewind_sentences', input: { count: 3 } }, { name: 'set_reading_speed', input: { rate: 1.25 } }]);
    assert.equal(events.filter((e) => e.t).length, 0);
    await expectLog(app, /tools=rewind_sentences,set_reading_speed/);
    reply = oaiStream({ calls: [{ name: 'ask_listener', input: { question: '請問要跳到第幾章？' } }] });
    events = await readSse(await post(app.base, '/api/ask', askBody({ question: '跳到那一章' })));
    assert.equal(events.filter((e) => e.t).length, 0, 'the question travels in the tool call, not in the text');
    assert.deepEqual(events.find((e) => e.tools).tools, [{ name: 'ask_listener', input: { question: '請問要跳到第幾章？' } }]);
    reply = oaiStream({ calls: [{ name: 'go_to_chapter', input: { chapter_number: 4 } }] }).replace('4}', '');
    events = await readSse(await post(app.base, '/api/ask', askBody()));
    assert.deepEqual(events.find((e) => e.tools).tools, [{ name: 'go_to_chapter', input: {} }], 'broken argument JSON becomes "no arguments", which the planner refuses');
  } finally { app.child.kill(); fake.server.close(); }
});

test('OpenAI: reasoning_effort is negotiated once per model and remembered', async () => {
  const fake = await startFakeAnthropic((rec, res) => {
    const e = rec.body.reasoning_effort;
    if (e === 'none' || e === 'minimal') return oaiErr(res, 400, { message: `Unsupported value: 'reasoning_effort' does not support '${e}' with this model.`, type: 'invalid_request_error', param: 'reasoning_effort', code: 'unsupported_value' });
    oaiOk(res, oaiStream({ text: '好。' }));
  });
  const app = await startApp(openaiEnv(fake, { QA_MODEL: 'gpt-5-mini' }));
  try {
    const events = await readSse(await post(app.base, '/api/ask', askBody()));
    assert.equal(events.filter((e) => e.t).map((e) => e.t).join(''), '好。');
    assert.deepEqual(fake.seen.map((r) => r.body.reasoning_effort), ['none', 'minimal', 'low']);
    assert.equal(fake.seen[2].body.max_completion_tokens, 8192, 'thinking counts against the limit, so the budget is doubled');
    await readSse(await post(app.base, '/api/ask', askBody()));
    assert.deepEqual(fake.seen.map((r) => r.body.reasoning_effort).slice(3), ['low'], 'the accepted value is used straight away next time');
  } finally { app.child.kill(); fake.server.close(); }
  // non-reasoning models get no reasoning_effort at all; an explicit setting is used as given; "off" sends nothing
  for (const [model, env, expected] of [['gpt-4.1', {}, undefined], ['gpt-5.5', { QA_EFFORT: 'off' }, undefined], ['gpt-5.5', { QA_EFFORT: 'high' }, 'high']]) {
    const f = await startFakeAnthropic((rec, res) => oaiOk(res, oaiStream({ text: 'ok' })));
    const a = await startApp(openaiEnv(f, { QA_MODEL: model, ...env }));
    try {
      await readSse(await post(a.base, '/api/ask', askBody()));
      assert.equal(f.seen[0].body.reasoning_effort, expected, `${model} ${JSON.stringify(env)}`);
    } finally { a.child.kill(); f.server.close(); }
  }
});

test('OpenAI: refusals, auth, quota and bad-request errors are reported like Claude\'s', async () => {
  let mode = 'refusal';
  const fake = await startFakeAnthropic((rec, res) => {
    if (mode === 'refusal') return oaiOk(res, oaiStream({ refusal: '抱歉，我無法協助。', finish: 'stop' }));
    if (mode === 'filter') return oaiOk(res, oaiStream({ finish: 'content_filter' }));
    if (mode === '401') return oaiErr(res, 401, { message: 'Incorrect API key provided: sk-oai-****.', type: 'invalid_request_error', code: 'invalid_api_key' });
    if (mode === 'quota') return oaiErr(res, 429, { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' });
    if (mode === '429') return oaiErr(res, 429, { message: 'Rate limit reached for gpt-5.5', type: 'requests', code: 'rate_limit_exceeded' });
    if (mode === '404') return oaiErr(res, 404, { message: 'The model `gpt-5.5` does not exist', type: 'invalid_request_error', code: 'model_not_found' });
    oaiErr(res, 400, { message: 'bad thing', type: 'invalid_request_error', param: 'messages' });
  });
  const app = await startApp(openaiEnv(fake));
  try {
    const ask = async () => readSse(await post(app.base, '/api/ask', askBody()));
    assert.ok((await ask()).some((e) => e.refusal), 'a structured refusal');
    mode = 'filter';
    assert.ok((await ask()).some((e) => e.refusal), 'content_filter');
    for (const [m, status, re] of [['401', 401, /OPENAI_API_KEY/], ['quota', 402, /no credit left/], ['429', 429, /Rate limited/], ['404', 404, /Model not found/], ['400', 400, /bad thing/]]) {
      mode = m;
      const err = (await ask()).find((e) => e.error);
      assert.equal(err?.status, status, m);
      assert.match(err.error, re, m);
      assert.ok(!err.error.includes('sk-oai-test'), 'the key never appears in an error');
    }
    assert.equal(fake.seen.length, 7, 'errors unrelated to reasoning_effort are not retried');
  } finally { app.child.kill(); fake.server.close(); }
});

test('OpenAI: the background summaries use it too', async () => {
  const fake = await startFakeAnthropic((rec, res) => oaiOk(res, oaiStream({ text: '主角抵達小鎮，遇見了老周。' })));
  const app = await startApp(openaiEnv(fake, { SUMMARY_MODEL: 'gpt-5.4-mini' }));
  try {
    const r = await post(app.base, '/api/summarize', { kind: 'segment', lang: 'zh-TW', text: '一些文字。', chapterTitle: '第一章', targetChars: 200 });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { summary: '主角抵達小鎮，遇見了老周。' });
    const { body } = fake.seen[0];
    assert.equal(body.model, 'gpt-5.4-mini');
    assert.equal(body.tools, undefined, 'summaries use no tools');
    assert.ok(body.messages[0].content.includes('faithful condensed note') && body.messages[1].content.includes('<passage>'));
    await expectLog(app, /\[summarize:segment\] gpt-5\.5-2026-04-23 in=2100 out=30 stop=stop/);
  } finally { app.child.kill(); fake.server.close(); }
});

test('providers can be mixed, and the server says exactly which key is missing', async () => {
  const claude = await startFakeAnthropic((rec, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(streamBody('claude 的答案。')); });
  const gpt = await startFakeAnthropic((rec, res) => oaiOk(res, oaiStream({ text: 'gpt 的摘要。' })));
  const app = await startApp({ MOCK_LLM: '', QA_PROVIDER: 'anthropic', SUMMARY_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: claude.url, OPENAI_API_KEY: 'sk-oai', OPENAI_BASE_URL: `${gpt.url}/v1`, AI_PROVIDER: '' });
  try {
    const cfg = await (await fetch(app.base + '/api/config')).json();
    assert.deepEqual(cfg.providers, { qa: 'anthropic', summary: 'openai' });
    assert.deepEqual(cfg.models, { qa: 'claude-sonnet-5-5', summary: 'gpt-6.1-sol' }, 'each provider has its own default model');
    assert.equal((await readSse(await post(app.base, '/api/ask', askBody()))).filter((e) => e.t).map((e) => e.t).join(''), 'claude 的答案。');
    assert.equal((await (await post(app.base, '/api/summarize', { kind: 'segment', lang: 'zh-TW', text: '文字。', targetChars: 200 })).json()).summary, 'gpt 的摘要。');
    assert.equal(claude.seen.length, 1); assert.equal(gpt.seen.length, 1);
  } finally { app.child.kill(); claude.server.close(); gpt.server.close(); }

  const probe = async (env) => {
    const a = await startApp({ MOCK_LLM: '', AI_PROVIDER: '', QA_PROVIDER: '', SUMMARY_PROVIDER: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '', ...env });
    try {
      const cfg = await (await fetch(a.base + '/api/config')).json();
      const ask = await post(a.base, '/api/ask', askBody());
      return { ai: cfg.ai, status: ask.status, error: ask.status === 503 ? (await ask.json()).error : '', log: a.log() };
    } finally { a.child.kill(); }
  };
  let r = await probe({ AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'sk-ant' });
  assert.equal(r.ai, false); assert.equal(r.status, 503);
  assert.match(r.error, /set OPENAI_API_KEY/); assert.ok(!/ANTHROPIC/.test(r.error), 'the Anthropic key is irrelevant when OpenAI is chosen');
  assert.match(r.log, /NOT CONFIGURED \(set OPENAI_API_KEY in \.env\)/);
  r = await probe({ QA_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-oai' });
  assert.equal(r.ai, false); assert.match(r.error, /set ANTHROPIC_API_KEY/, 'a mixed setup needs both keys');
  r = await probe({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-oai' });
  assert.equal(r.ai, true, 'an OpenAI-only setup does not need an Anthropic key');
  assert.match(r.log, /AI: OpenAI — answers: gpt-6\.1-sol, memory: gpt-6\.1-sol/);
  r = await probe({ AI_PROVIDER: 'gemini', ANTHROPIC_API_KEY: 'sk-ant' });
  assert.equal(r.ai, true); assert.match(r.log, /AI_PROVIDER="gemini" is not one of/, 'a typo is reported, then the default (Claude) is used');
});

// ---------------------------------------------------------------- OpenAI Responses API (gpt-6.1-sol, gpt-5.5 …)
const rEvent = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
/** A Responses API event stream: optional text, function calls (arguments arrive in pieces), status, usage. */
function respStream({ text = '', calls = [], refusal = '', status = 'completed', incomplete = '', usage = { input_tokens: 2100, output_tokens: 30, input_tokens_details: { cached_tokens: 1024 } }, withReasoning = false } = {}) {
  let out = rEvent({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } });
  let idx = 0;
  if (withReasoning) { out += rEvent({ type: 'response.output_item.added', output_index: idx, item: { type: 'reasoning', id: 'rs_1' } }) + rEvent({ type: 'response.output_item.done', output_index: idx++, item: { type: 'reasoning', id: 'rs_1' } }); }
  if (text) {
    out += rEvent({ type: 'response.output_item.added', output_index: idx, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } });
    for (const c of text.match(/[\s\S]{1,4}/g)) out += rEvent({ type: 'response.output_text.delta', output_index: idx, item_id: 'msg_1', delta: c });
    out += rEvent({ type: 'response.output_item.done', output_index: idx++, item: { type: 'message', id: 'msg_1' } });
  }
  if (refusal) out += rEvent({ type: 'response.refusal.delta', output_index: idx, delta: refusal });
  for (const c of calls) {
    const args = JSON.stringify(c.input);
    out += rEvent({ type: 'response.output_item.added', output_index: idx, item: { type: 'function_call', id: `fc_${idx}`, call_id: `call_${idx}`, name: c.name, arguments: '' } });
    for (const piece of [args.slice(0, 3), args.slice(3)]) out += rEvent({ type: 'response.function_call_arguments.delta', output_index: idx, item_id: `fc_${idx}`, delta: piece });
    out += rEvent({ type: 'response.function_call_arguments.done', output_index: idx, item_id: `fc_${idx}`, arguments: args });
    out += rEvent({ type: 'response.output_item.done', output_index: idx++, item: { type: 'function_call', id: `fc_${idx}`, call_id: `call_${idx}`, name: c.name, arguments: args } });
  }
  const response = { id: 'resp_1', model: 'gpt-6.1-sol-2026-06-01', status: incomplete ? 'incomplete' : status, usage, ...(incomplete ? { incomplete_details: { reason: incomplete } } : {}) };
  return out + rEvent({ type: incomplete ? 'response.incomplete' : 'response.completed', response });
}
const respEnv = (fake, extra = {}) => openaiEnv(fake, { OPENAI_API: 'responses', ...extra });

test('OpenAI Responses API (gpt-6.1-sol, the default OpenAI model): request shape, streaming text, effort', async () => {
  const fake = await startFakeAnthropic((rec, res) => oaiOk(res, respStream({ text: '這句話的意思是說，他其實很擔心。', withReasoning: true })));
  const app = await startApp(respEnv(fake));
  try {
    const cfg = await (await fetch(app.base + '/api/config')).json();
    assert.deepEqual(cfg.models, { qa: 'gpt-6.1-sol', summary: 'gpt-6.1-sol' }, 'GPT-6.1 Sol is the default OpenAI model');
    const events = await readSse(await post(app.base, '/api/ask', askBody({ player: { chapterNumber: 2, chapterCount: 9, rate: 1, sleep: 'off' } })));
    assert.equal(events.filter((e) => e.t).map((e) => e.t).join(''), '這句話的意思是說，他其實很擔心。');
    assert.ok(events.some((e) => e.done) && !events.some((e) => e.error || e.refusal || e.tools));
    assert.equal(fake.seen.length, 1);
    const { url, headers, body } = fake.seen[0];
    assert.equal(url, '/v1/responses');
    assert.equal(headers.authorization, 'Bearer sk-oai-test');
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.stream, true);
    assert.equal(body.store, false, 'nothing is kept on OpenAI\'s side');
    assert.deepEqual(body.reasoning, { effort: 'low' }, 'low first: a spoken answer wants speed');
    assert.equal(body.max_output_tokens, 8192, 'thinking counts against the limit, so the budget is doubled');
    assert.ok(body.instructions.includes('no spoilers') && body.instructions.includes('<story_so_far>') && body.instructions.includes('主角抵達小鎮'), 'both system blocks become the instructions');
    assert.ok(!JSON.stringify(body).includes('cache_control'));
    assert.equal(body.messages, undefined);
    assert.deepEqual(body.input.slice(0, 2).map((m) => m.role), ['user', 'assistant'], 'earlier Q&A stays real turns');
    const last = body.input.at(-1);
    assert.equal(last.role, 'user');
    assert.ok(last.content.includes('<question>') && last.content.includes('Current chapter: 2 of 9'));
    assert.equal(body.tools.length, 10);
    assert.equal(body.parallel_tool_calls, true);
    assert.deepEqual(Object.keys(body.tools[0]).sort(), ['description', 'name', 'parameters', 'strict', 'type'], 'Responses tools are flat (no nested "function")');
    assert.equal(body.tools[0].strict, false, 'our schemas have optional properties, which strict mode would reject');
    assert.deepEqual(body.tools[0].parameters.required, ['count']);
    await expectLog(app, /\[ask\] gpt-6\.1-sol-2026-06-01 effort=low in=2100 cache_read=1024 cache_write=0 out=30 stop=stop/);
    await expectLog(app, /OpenAI API: Responses .*reasoning effort: auto → low/);
  } finally { app.child.kill(); fake.server.close(); }
});

test('OpenAI Responses API: tool calls, refusals and failures', async () => {
  let reply;
  const fake = await startFakeAnthropic((rec, res) => (typeof reply === 'function' ? reply(res) : oaiOk(res, reply)));
  const app = await startApp(respEnv(fake));
  try {
    const ask = async (q = '倒回三句然後快一點') => readSse(await post(app.base, '/api/ask', askBody({ question: q })));
    reply = respStream({ withReasoning: true, calls: [{ name: 'rewind_sentences', input: { count: 3 } }, { name: 'set_reading_speed', input: { rate: 1.25 } }] });
    let events = await ask();
    assert.deepEqual(events.find((e) => e.tools).tools, [{ name: 'rewind_sentences', input: { count: 3 } }, { name: 'set_reading_speed', input: { rate: 1.25 } }], 'in order, ignoring the reasoning item');
    assert.equal(events.filter((e) => e.t).length, 0);
    await expectLog(app, /tools=rewind_sentences,set_reading_speed/);
    reply = respStream({ calls: [{ name: 'ask_listener', input: { question: '請問要跳到第幾章？' } }] });
    events = await ask('跳到那一章');
    assert.deepEqual(events.find((e) => e.tools).tools, [{ name: 'ask_listener', input: { question: '請問要跳到第幾章？' } }]);
    reply = respStream({ text: '好的。', calls: [{ name: 'stop_reading', input: {} }] });
    events = await ask();
    assert.equal(events.filter((e) => e.t).map((e) => e.t).join(''), '好的。');
    assert.deepEqual(events.find((e) => e.tools).tools, [{ name: 'stop_reading', input: {} }]);
    reply = respStream({ refusal: '抱歉，我無法協助。' });
    assert.ok((await ask()).some((e) => e.refusal), 'a refusal');
    reply = respStream({ incomplete: 'content_filter' });
    assert.ok((await ask()).some((e) => e.refusal), 'incomplete because of the content filter');
    reply = (res) => oaiOk(res, rEvent({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'The model had an internal problem.' } } }));
    const failed = (await ask()).find((e) => e.error);
    assert.match(failed.error, /internal problem/);
    reply = (res) => oaiErr(res, 429, { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' });
    assert.equal((await ask()).find((e) => e.error).status, 402);
  } finally { app.child.kill(); fake.server.close(); }
});

test('OpenAI Responses API: the effort is negotiated per model, can be set with QA_EFFORT, and is left out for non-reasoning models', async () => {
  // gpt-6.1-sol style: rejects "none"-like values; here the fake only accepts high
  const fake = await startFakeAnthropic((rec, res) => {
    const e = rec.body.reasoning?.effort;
    if (e === 'low' || e === 'medium') return oaiErr(res, 400, { message: `Unsupported value: '${e}' is not supported with the 'gpt-6.1-sol' model. Supported values are: 'high' and 'xhigh'.`, type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_value' });
    oaiOk(res, respStream({ text: '好。' }));
  });
  const app = await startApp(respEnv(fake));
  try {
    assert.equal((await readSse(await post(app.base, '/api/ask', askBody()))).filter((e) => e.t).map((e) => e.t).join(''), '好。');
    assert.deepEqual(fake.seen.map((r) => r.body.reasoning?.effort), ['low', 'medium', 'high']);
    await readSse(await post(app.base, '/api/ask', askBody()));
    assert.deepEqual(fake.seen.map((r) => r.body.reasoning?.effort).slice(3), ['high'], 'the accepted value is used straight away next time');
  } finally { app.child.kill(); fake.server.close(); }
  for (const [model, env, expected] of [['gpt-4.1', {}, undefined], ['gpt-6.1-sol', { QA_EFFORT: 'xhigh' }, 'xhigh'], ['gpt-5.5', { QA_EFFORT: 'none' }, 'none'], ['gpt-5.5', { QA_EFFORT: 'off' }, undefined]]) {
    const f = await startFakeAnthropic((rec, res) => oaiOk(res, respStream({ text: 'ok' })));
    const a = await startApp(respEnv(f, { QA_MODEL: model, ...env }));
    try {
      await readSse(await post(a.base, '/api/ask', askBody()));
      assert.equal(f.seen[0].body.reasoning?.effort, expected, `${model} ${JSON.stringify(env)}`);
      if (expected === 'none' || expected === undefined) assert.equal(f.seen[0].body.max_output_tokens, 4096, 'no thinking, no extra budget');
    } finally { a.child.kill(); f.server.close(); }
  }
  // an explicit value the model refuses is reported as it is (the API names the accepted ones), never silently changed
  const strict = await startFakeAnthropic((rec, res) => oaiErr(res, 400, { message: "Unsupported value: 'max' is not supported with the 'gpt-5.5' model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.", type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_value' }));
  const app2 = await startApp(respEnv(strict, { QA_MODEL: 'gpt-5.5', QA_EFFORT: 'max' }));
  try {
    const err = (await readSse(await post(app2.base, '/api/ask', askBody()))).find((e) => e.error);
    assert.equal(err.status, 400);
    assert.match(err.error, /Supported values are/);
    assert.equal(strict.seen.length, 1, 'no retry with another value');
  } finally { app2.child.kill(); strict.server.close(); }
});

test('OpenAI API selection: the Responses API for api.openai.com, Chat Completions for other servers, overridable', () => {
  assert.equal(pickApi('', 'https://api.openai.com/v1'), 'responses');
  assert.equal(pickApi('auto', 'https://api.openai.com/v1/'), 'responses');
  assert.equal(pickApi(undefined, 'http://localhost:8000/v1'), 'chat');
  assert.equal(pickApi('', 'https://my-proxy.example.com/v1'), 'chat');
  assert.equal(pickApi('chat', 'https://api.openai.com/v1'), 'chat');
  assert.equal(pickApi('RESPONSES', 'http://localhost:8000/v1'), 'responses');
  assert.equal(pickApi('nonsense', 'https://api.openai.com/v1'), 'responses', 'an unknown value means auto');
  assert.deepEqual(effortCandidates('gpt-6.1-sol', 'auto', 'responses'), ['low', 'medium', 'high', null]);
  assert.deepEqual(effortCandidates('gpt-5.5', 'auto', 'chat'), ['none', 'minimal', 'low', null]);
  assert.deepEqual(effortCandidates('gpt-4.1', 'auto', 'responses'), [null]);
  assert.deepEqual(effortCandidates('gpt-6.1-sol', 'xhigh', 'responses'), ['xhigh']);
  assert.deepEqual(effortCandidates('gpt-6.1-sol', 'off', 'responses'), [null]);
  assert.deepEqual(effortCandidates('o3', '', 'responses'), ['low', 'medium', 'high', null]);
});

// ---------------------------------------------------------------- startup problems
test('a port that is already taken gives a plain explanation and a non-zero exit, not a stack trace', async () => {
  const fsx = await import('node:fs');
  const osx = await import('node:os');
  const block = (port) => new Promise((resolve) => { const s = http.createServer(); s.listen(port, '127.0.0.1', () => resolve(s)); });
  const run = (env) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ENV_FILE: 'none', HOST: '127.0.0.1', MOCK_LLM: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => c.kill(), 15_000);
    c.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
  const noTrace = (out) => assert.doesNotMatch(out, /setupListenHandle|listenInCluster|at Server\.|EADDRINUSE/, 'no Node stack trace');

  // plain HTTP: the one port is taken
  const port = allocPorts(2);
  const a = await block(port);
  try {
    const r = await run({ PORT: String(port) });
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`Port ${port} is already in use`));
    assert.match(r.out, new RegExp(`http://localhost:${port}`), 'says where the running copy is');
    assert.match(r.out, /taskkill/); assert.match(r.out, /lsof -i/); assert.match(r.out, /PORT=3100/);
    noTrace(r.out);
  } finally { a.close(); }

  // HTTPS mode: the app port is free but the certificate/setup port (PORT + 1) is taken
  const httpsPort = allocPorts(2);
  const b = await block(httpsPort + 1);
  try {
    const r = await run({ PORT: String(httpsPort), HTTPS: '1', CERT_DIR: fsx.mkdtempSync(path.join(osx.tmpdir(), 'ab-cert-')) });
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`Port ${httpsPort + 1} is already in use`));
    assert.match(r.out, new RegExp(`http://localhost:${httpsPort + 1}`), 'in HTTPS mode the copy on this computer answers on the setup port');
    noTrace(r.out);
  } finally { b.close(); }
});
