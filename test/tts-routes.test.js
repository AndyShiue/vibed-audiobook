// The server's voice endpoints (POST /api/tts, POST /api/tts/voices) and what /api/config says about them — the real server.js,
// in mock mode or against a fake OpenAI-compatible speech server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let nextPort = 3900 + Math.floor(Math.random() * 90);
const FETCH_BLOCKED = new Set([3659]);

function startApp(env = {}, args = []) {
  while (FETCH_BLOCKED.has(nextPort)) nextPort++;
  const port = nextPort++;
  const child = spawn(process.execPath, ['server.js', ...args], { cwd: ROOT, env: { ...process.env, ENV_FILE: 'none', PORT: String(port), HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
    const poll = setInterval(() => { if (out.includes('running')) { clearInterval(poll); clearTimeout(t); resolve({ base: `http://127.0.0.1:${port}`, child, log: () => out }); } }, 50);
  });
}

/** A speech server that speaks the OpenAI-compatible protocol and records what it was asked. */
function fakeSpeechServer(handler = () => ({ status: 200, body: Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]) })) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const record = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : {} };
      seen.push(record);
      const r = handler(record, seen.length);
      res.writeHead(r.status, { 'Content-Type': r.type || (r.status === 200 ? 'audio/mpeg' : 'application/json') });
      res.end(r.body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

const post = (base, p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const config = async (base) => (await fetch(`${base}/api/config`)).json();

test('/api/config says whether server voices are available, without any key', async () => {
  const mock = await startApp({}, ['--mock']);
  const off = await startApp({ TTS_PROVIDER: 'off' });
  const azure = await startApp({ TTS_PROVIDER: 'azure' });
  const custom = await startApp({ TTS_PROVIDER: 'custom', TTS_BASE_URL: 'http://127.0.0.1:9/v1', TTS_API_KEY: 'sk-never-shown' });
  try {
    assert.deepEqual((await config(mock.base)).tts, { available: true, provider: 'mock', label: 'mock voices', official: true, reason: '' });
    assert.deepEqual((await config(off.base)).tts, { available: false, provider: '', label: '', official: false, reason: 'off' });
    const az = (await config(azure.base)).tts;
    assert.equal(az.available, false); assert.match(az.reason, /AZURE_SPEECH_KEY/);
    assert.match(azure.log(), /server voices .* not available/);
    const c = await config(custom.base);
    assert.equal(c.tts.provider, 'custom'); assert.equal(c.tts.available, true);
    assert.ok(!JSON.stringify(c).includes('sk-never-shown'));
  } finally { for (const a of [mock, off, azure, custom]) a.child.kill(); }
});

test('mock mode makes real audio, lists voices, and checks its input', async () => {
  const app = await startApp({}, ['--mock']);
  try {
    const r = await post(app.base, '/api/tts', { text: '你好，世界', lang: 'zh-TW' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/wav');
    assert.equal(r.headers.get('x-tts-voice'), 'mock-A');
    const audio = Buffer.from(await r.arrayBuffer());
    assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
    assert.equal(Number(r.headers.get('content-length')), audio.length);

    const v = await (await post(app.base, '/api/tts/voices', { lang: 'en-US' })).json();
    assert.equal(v.provider, 'mock'); assert.equal(v.voices.length, 2); assert.ok(v.defaultVoice);

    assert.equal((await post(app.base, '/api/tts', { lang: 'zh-TW' })).status, 400, 'no text');
    assert.equal((await post(app.base, '/api/tts', { text: '  ', lang: 'zh-TW' })).status, 400);
    assert.equal((await post(app.base, '/api/tts', { text: 'x'.repeat(5000), lang: 'zh-TW' })).status, 413);
    assert.equal((await post(app.base, '/api/tts', { text: 'hi', voice: "a'b" })).status, 400);
    assert.equal((await post(app.base, '/api/tts/voices', { lang: '' })).status, 400);
    assert.equal((await fetch(`${app.base}/api/tts`)).status, 405, 'POST only: text never travels in a URL');
    await post(app.base, '/api/tts', { text: '一段不該出現在記錄裡的文字', lang: 'zh-TW' });
    assert.ok(!app.log().includes('不該出現'), 'the spoken text is not logged');
    assert.match(app.log(), /\[tts\] mock\/mock-A \d+ chars/);
  } finally { app.child.kill(); }
});

test('a text that mixes languages is cut by language, each piece made in its own voice, and returned as ONE clip', async () => {
  const app = await startApp({}, ['--mock']);
  try {
    const text = '我昨天在 Apple Store 買了一支手機。';
    const mixed = await post(app.base, '/api/tts', { text, lang: 'zh-TW', mixed: 'words' });
    assert.equal(mixed.headers.get('x-tts-parts'), '3');
    assert.equal(mixed.headers.get('x-tts-voice'), 'mock-A+mock-B');
    const wav = Buffer.from(await mixed.arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(40), wav.length - 44, 'the joined clip has one consistent header');
    assert.equal(wav.readUInt32LE(4), wav.length - 8);

    const whole = await post(app.base, '/api/tts', { text, lang: 'zh-TW', mixed: 'off' });
    assert.equal(whole.headers.get('x-tts-parts'), '1');
    assert.equal(whole.headers.get('x-tts-voice'), 'mock-A');
    assert.equal((await post(app.base, '/api/tts', { text, lang: 'zh-TW' })).headers.get('x-tts-parts'), '1', 'no setting: one voice');

    const chosen = await post(app.base, '/api/tts', { text, lang: 'zh-TW', mixed: 'words', voices: { 'en-US': 'mock-A' } });
    assert.equal(chosen.headers.get('x-tts-parts'), '1', 'the same voice for both languages: one clip');
    assert.match(app.log(), /\[tts\] mock\/mock-A\+mock-B \d+ chars, 3 parts/);
    assert.ok(!app.log().includes('Apple Store'));
  } finally { app.child.kill(); }
});

test('the voice endpoints are behind the access token like the rest of /api', async () => {
  const app = await startApp({ ACCESS_TOKEN: 'secret-token' }, ['--mock']);
  try {
    assert.equal((await post(app.base, '/api/tts', { text: 'hi', lang: 'en-US' })).status, 401);
    assert.equal((await post(app.base, '/api/tts/voices', { lang: 'en-US' })).status, 401);
    assert.equal((await post(app.base, '/api/tts', { text: 'hi', lang: 'en-US' }, { 'x-access-token': 'secret-token' })).status, 200);
  } finally { app.child.kill(); }
});

test('with server voices off the endpoints answer 503, not a crash', async () => {
  const app = await startApp({ TTS_PROVIDER: 'off' });
  try {
    const r = await post(app.base, '/api/tts', { text: 'hi', lang: 'en-US' });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /not available/);
    assert.equal((await post(app.base, '/api/tts/voices', { lang: 'en-US' })).status, 503);
  } finally { app.child.kill(); }
});

test('an OpenAI-compatible speech server: the request it receives, the cache, and its errors', async () => {
  const fake = await fakeSpeechServer((rec) => (rec.body.input === 'bad key' ? { status: 401, body: JSON.stringify({ error: { message: 'invalid key' } }) } : { status: 200, body: Buffer.from([0xff, 0xfb, 0x90, 0x00, 9, 9, 9, 9]) }));
  const app = await startApp({ TTS_PROVIDER: 'custom', TTS_BASE_URL: fake.url, TTS_API_KEY: 'sk-speech', TTS_MODEL: 'kokoro', TTS_VOICES: 'zf_xiaobei,af_heart', TTS_VOICE: 'zf_xiaobei' });
  try {
    const first = await post(app.base, '/api/tts', { text: '你好 world', lang: 'zh-TW' });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'audio/mpeg');
    assert.equal(first.headers.get('x-tts-voice'), 'zf_xiaobei');
    assert.deepEqual([...Buffer.from(await first.arrayBuffer())].slice(4), [9, 9, 9, 9]);
    assert.equal(fake.seen[0].url, '/v1/audio/speech');
    assert.equal(fake.seen[0].headers.authorization, 'Bearer sk-speech');
    assert.deepEqual(fake.seen[0].body, { model: 'kokoro', input: '你好 world', voice: 'zf_xiaobei', response_format: 'mp3' });

    await post(app.base, '/api/tts', { text: '你好 world', lang: 'zh-TW' });
    assert.equal(fake.seen.length, 1, 'the same clip again comes from the cache');
    await expectLog(app, /\(cached\)/);

    const other = await post(app.base, '/api/tts', { text: '你好 world', lang: 'zh-TW', voice: 'af_heart' });
    assert.equal(other.headers.get('x-tts-voice'), 'af_heart');
    assert.equal(fake.seen.length, 2);

    const v = await (await post(app.base, '/api/tts/voices', { lang: 'zh-TW' })).json();
    assert.deepEqual(v.voices.map((x) => x.id), ['zf_xiaobei', 'af_heart']);
    assert.equal(v.defaultVoice, 'zf_xiaobei');

    const bad = await post(app.base, '/api/tts', { text: 'bad key', lang: 'en-US' });
    assert.equal(bad.status, 502, 'never a 401: the browser would take it for a wrong access token');
    assert.match((await bad.json()).error, /key was rejected/);
    assert.ok(!app.log().includes('sk-speech'));
  } finally { app.child.kill(); fake.server.close(); }
});

async function expectLog(app, re, ms = 3000) {
  const t0 = Date.now();
  while (!re.test(app.log()) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
  assert.match(app.log(), re);
}

test('an unreachable speech server is a 502 with a plain message', async () => {
  const app = await startApp({ TTS_PROVIDER: 'custom', TTS_BASE_URL: 'http://127.0.0.1:9/v1' });
  try {
    const r = await post(app.base, '/api/tts', { text: 'hi', lang: 'en-US' });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error, 'Could not reach the speech service.');
  } finally { app.child.kill(); }
});
