// Live check of the server voices against the real service the server is configured for (no key needed for the default, Edge):
//   node scripts/live-tts-test.mjs                                      (TTS_PROVIDER from .env, default: edge)
//   TTS_PROVIDER=openai node scripts/live-tts-test.mjs                  (uses OPENAI_API_KEY; a few hundredths of a cent)
//   TTS_PROVIDER=azure node scripts/live-tts-test.mjs                   (AZURE_SPEECH_KEY / AZURE_SPEECH_REGION)
// It starts the server on its own port, asks for the voice list and for a few clips in different languages (including text
// that mixes languages), checks that real MP3 audio comes back, that a repeat request is served from the cache, and that the
// access token is enforced. With OUT=folder it also keeps the clips so you can listen to them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3781;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'live-test-token';
const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, HTTPS: '0', PORT: String(PORT), HOST: '127.0.0.1', ACCESS_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });
process.on('exit', () => { try { child.kill(); } catch { /* gone */ } });

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return r.json(); } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start:\n' + serverLog);
}

const post = (url, body, token = TOKEN) => fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-access-token': token } : {}) }, body: JSON.stringify(body) });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const isMp3 = (b) => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0); // "ID3" tag or an MPEG frame sync
const isWav = (b) => b.toString('ascii', 0, 4) === 'RIFF';

try {
  const cfg = await waitForServer();
  const tts = cfg.tts;
  if (!tts?.available) throw new Error(`server voices are not available: ${tts?.reason || 'unknown'}\n${serverLog}`);
  console.log(`Provider: ${tts.label}${tts.official ? '' : '  (unofficial)'}\n`);
  check('the access token is enforced', (await post('/api/tts', { text: 'hi', lang: 'en-US' }, '')).status === 401);

  const outDir = process.env.OUT ? path.resolve(process.env.OUT) : '';
  if (outDir) fs.mkdirSync(outDir, { recursive: true });

  for (const lang of ['zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU']) {
    const r = await post('/api/tts/voices', { lang });
    const j = await r.json();
    check(`voices for ${lang}`, r.ok && (j.voices.length > 0 || j.defaultVoice), r.ok ? `${j.voices.length} voices, default ${j.defaultVoice}${j.listError ? ' (built-in pick: ' + j.listError + ')' : ''}` : j.error);
  }

  // [language of the book or question, text, how many pieces it should be read in at least (0 = no expectation)]
  // Providers whose voices read every language (openai, custom) make one clip of anything; the others cut by language.
  const perLanguage = ['edge', 'azure', 'google', 'mock'].includes(tts.provider);
  const clips = [
    ['zh-TW', '我昨天在 Apple Store 買了一支手機，店員說這是最新的款式。', 3],
    ['zh-TW', '她讀了《Pride and Prejudice》之後哭了很久。', 3],
    ['zh-TW', '老周最近在學 Python，還買了一台 iPhone。這個詞是 deadline，意思是截止日期。', 5],
    ['en-US', 'He said 不積跬步，無以至千里 before he left the village.', 3],
    ['ja-JP', '彼は Apple Store で iPhone を買った。', 3],
    ['fr-FR', 'Il est parti hier soir sans dire un mot.', 1],
  ];
  for (const [i, [lang, text, pieces]] of clips.entries()) {
    const t0 = Date.now();
    const r = await post('/api/tts', { text, lang, mixed: 'words' });
    const audio = Buffer.from(await r.arrayBuffer());
    const voice = r.headers.get('x-tts-voice');
    const parts = Number(r.headers.get('x-tts-parts'));
    const type = r.headers.get('content-type');
    const ok = r.ok && audio.length > 2000 && (isMp3(audio) || isWav(audio)) && (!perLanguage || parts >= pieces);
    check(`clip ${i + 1} (${lang}): ${text.slice(0, 22)}…`, ok, r.ok ? `${voice}, ${parts} part${parts > 1 ? 's' : ''}, ${type}, ${Math.round(audio.length / 1024)} KB in ${Date.now() - t0} ms` : `HTTP ${r.status} ${audio.toString('utf8').slice(0, 160)}`);
    if (outDir && r.ok) fs.writeFileSync(path.join(outDir, `${i + 1}_${lang}_${voice}.${isWav(audio) ? 'wav' : 'mp3'}`), audio);
  }

  const t0 = Date.now();
  const again = await post('/api/tts', { text: clips[0][1], lang: clips[0][0], mixed: 'words' });
  await again.arrayBuffer();
  check('a repeated clip comes from the cache', again.ok && /\(cached\)/.test(serverLog), `${Date.now() - t0} ms`);
  check('a text that is too long is refused', (await post('/api/tts', { text: 'x'.repeat(2000), lang: 'en-US' })).status === 413);
  check('the log never contains the text that was spoken', !serverLog.includes('Apple Store'));

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${outDir ? `   (clips kept in ${outDir})` : ''}`);
  if (failed.length) process.exitCode = 1;
} catch (err) {
  console.error('live test aborted:', err.message);
  console.error(serverLog.split('\n').slice(-12).join('\n'));
  process.exitCode = 1;
} finally {
  child.kill();
}
