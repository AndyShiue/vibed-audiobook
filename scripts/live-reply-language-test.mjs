// Live check against the real AI (uses the key in .env; a few cents): which language does it ANSWER in when the question mixes
// languages? The answer is spoken, and the voice follows the answer's language, so it has to be the language the question
// is built in — a Chinese question that quotes an English title is answered in Chinese, not English.
//   node scripts/live-reply-language-test.mjs                      (whatever .env selects: Claude by default)
//   AI_PROVIDER=openai node scripts/live-reply-language-test.mjs   (OpenAI's model)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBookData, Book } from '../public/js/book.js';
import { parseTxt } from '../public/js/parsers/text.js';
import { MemoryTree } from '../public/js/memory.js';
import { RetrievalIndex } from '../public/js/retrieval.js';
import { buildAskContext } from '../public/js/context.js';
import { detectSpokenLang } from '../public/js/lang.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3779;
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, HTTPS: '0', PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function ask(payload) {
  const r = await fetch(`${BASE}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  let text = '', error = null, buf = '';
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!block.startsWith('data:')) continue;
      const m = JSON.parse(block.slice(5));
      if (m.t) text += m.t;
      if (m.error) error = m.error;
    }
  }
  if (error) throw new Error(error);
  return text.trim();
}

/** Share of the letters of `text` that are Chinese, Japanese kana, or Latin. */
function scripts(text) {
  let han = 0, kana = 0, latin = 0;
  for (const ch of text) {
    if (/\p{Script=Han}/u.test(ch)) han++;
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) kana++;
    else if (/\p{Script=Latin}/u.test(ch)) latin++;
  }
  const t = han + kana + latin || 1;
  return { han: han / t, kana: kana / t, latin: latin / t };
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

try {
  const cfg = await waitForServer();
  if (!cfg.ai || cfg.mock) throw new Error('the real AI is not configured — check the API key for your AI_PROVIDER in .env');
  console.log(`AI: ${cfg.providers?.qa} / ${cfg.models?.qa}\n`);
  const book = new Book({ id: 'live', ...buildBookData(await parseTxt(fs.readFileSync(path.join(ROOT, 'fixtures', 'novel-zh.txt')), { name: 'novel-zh.txt' })) });
  const tree = new MemoryTree(book);
  const retr = new RetrievalIndex(book);
  const POS = book.chapters[4].start + 12;
  const player = { rate: 1, sleep: 'off', wasPlaying: true };

  const cases = [
    // [name, question, which script the answer should be mostly in]
    ['Chinese question quoting an English phrase → Chinese', '這句話裡的 "carry on" 是什麼意思？', 'han'],
    ['Chinese question with an English word → Chinese', '請問 deadline 這個字在這裡是什麼意思？', 'han'],
    ['Chinese question naming a book in English → Chinese', '這個故事讓你想到 Pride and Prejudice 嗎？', 'han'],
    ['English question with a Chinese name → English', 'Who is 老周 in this story so far?', 'latin'],
    ['English question quoting a Chinese sentence → English', 'What does the sentence 不積跬步，無以至千里 mean?', 'latin'],
    ['Japanese question with English words → Japanese', 'この物語の「老周」は誰ですか？ Apple Store のことではありません。', 'kana'],
    ['asked for in English, though the question is Chinese → English', '老周是誰？ Please answer in English.', 'latin'],
    // robustness probes (informational): what happens when the detector tags the question with the WRONG language
    ['(info) English question, but tagged zh-TW → English', 'What does the sentence 不積跬步，無以至千里 mean?', 'latin', 'zh-TW'],
    ['(info) Chinese question, but tagged en-US → Chinese', '請問老周為什麼要提著燈走向鐘樓？', 'han', 'en-US'],
  ];
  for (const [name, question, want, forcedTag] of cases) {
    const lang = forcedTag || detectSpokenLang(question, 'zh-TW'); // what the app sends as the question language
    const ctx = buildAskContext({ book, pos: POS, question, tree, retr, lang, player });
    const reply = await ask(ctx.payload);
    const sc = scripts(reply);
    const ok = want === 'han' ? sc.han > 0.5 : want === 'kana' ? sc.kana > 0.15 && sc.latin < 0.5 : sc.latin > 0.6;
    check(name, ok || Boolean(forcedTag), `${ok || !forcedTag ? '' : 'FOLLOWED THE WRONG TAG (informational) '}question lang=${lang}; reply ${Math.round(sc.han * 100)}% Han / ${Math.round(sc.kana * 100)}% kana / ${Math.round(sc.latin * 100)}% Latin — "${reply.slice(0, 60).replace(/\n/g, ' ')}"`);
  }
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
} catch (err) {
  console.error('live test aborted:', err.message);
  console.error(serverLog.split('\n').slice(-12).join('\n'));
  process.exitCode = 1;
} finally {
  child.kill();
}
