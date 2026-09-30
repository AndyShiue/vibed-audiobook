// Live end-to-end check against the real Claude API (uses the key in .env; costs a few cents).
//   node scripts/live-test.mjs
// Starts the real server, builds the sample book, lets the memory builder summarise it through the
// real /api/summarize, then asks questions at different reading positions and checks for spoilers.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBookData, Book } from '../public/js/book.js';
import { parseTxt } from '../public/js/parsers/text.js';
import { MemoryTree, MemoryBuilder } from '../public/js/memory.js';
import { RetrievalIndex } from '../public/js/retrieval.js';
import { buildAskContext } from '../public/js/context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3777;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = '管家老周'; // only appears in the very last line of the fixture book

const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, HTTPS: '0', PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });
const stop = () => { try { child.kill(); } catch { /* already gone */ } };
process.on('exit', stop);

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return r.json(); } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start:\n' + serverLog);
}

async function summarize(req) {
  const r = await fetch(`${BASE}/api/summarize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
}

async function ask(payload) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  let text = '', first = null, refusal = false, error = null, buf = '';
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!block.startsWith('data:')) continue;
      const m = JSON.parse(block.slice(5));
      if (m.t) { if (first === null) first = performance.now() - t0; text += m.t; }
      if (m.refusal) refusal = true;
      if (m.error) error = m.error;
    }
  }
  return { text, firstMs: Math.round(first ?? -1), totalMs: Math.round(performance.now() - t0), refusal, error };
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

try {
  const cfg = await waitForServer();
  console.log('server config:', JSON.stringify(cfg));
  if (!cfg.ai) throw new Error('server reports AI is not configured — check ANTHROPIC_API_KEY in .env');

  // --- build the sample book exactly like the browser does
  const buf = fs.readFileSync(path.join(ROOT, 'fixtures', 'novel-zh.txt'));
  const book = new Book({ id: 'live', ...buildBookData(await parseTxt(buf, { name: 'novel-zh.txt' })) });
  const tree = new MemoryTree(book);
  const retr = new RetrievalIndex(book);
  console.log(`book: ${book.length} units, ${book.chapters.length} chapters, ${tree.segs.length} memory segments`);

  // --- 1. real summarisation of the whole book (this is what runs in the background while listening)
  const t0 = performance.now();
  const builder = new MemoryBuilder({ book, tree, summarize: summarize, concurrency: 3 });
  builder.setKnown(book.length);
  await builder.idle(240_000);
  const st = builder.status();
  console.log(`memory: ${st.done}/${st.total} notes, ${tree.nodes.size} nodes total in ${Math.round(performance.now() - t0)} ms, failures=${st.failures}, disabled=${st.disabled}`);
  check('every segment got a note', st.done === st.total && st.total > 0);
  const sample = tree.get(0, 0);
  console.log('  sample note (segment 0):', sample.replace(/\s+/g, ' ').slice(0, 220));
  check('notes are real prose, not the local fallback', !sample.startsWith('（自動摘要不可用）') && sample.length > 40);
  const merged = [...tree.nodes].find(([k]) => k.startsWith('1:'));
  if (merged) console.log('  sample merged note:', merged[1].replace(/\s+/g, ' ').slice(0, 220));
  const last0 = tree.segs.length - 1;
  check('level-0 notes of earlier segments never mention the ending', ![...tree.nodes].filter(([k]) => k.startsWith('0:') && k !== `0:${last0}`).some(([, v]) => v.includes(SECRET)));

  // --- 2. questions at several positions
  const idxOfSecret = book.sents.findIndex((s) => s.includes(SECRET));
  console.log(`spoiler sentence is unit ${idxOfSecret} of ${book.length}`);
  const ask1 = async (pos, question, history = []) => {
    const { payload, meta } = buildAskContext({ book, pos, question, tree, retr, history, lang: 'zh-TW' });
    const res = await ask(payload);
    console.log(`\n[pos ${pos}/${book.length - 1} · ctx ${meta.windowTokens}+${meta.summaryTokens} tok · ${meta.summaryNodes} notes · ${meta.passages.length} passages] Q: ${question}`);
    console.log(`  A (${res.firstMs} ms to first text, ${res.totalMs} ms total): ${res.text.replace(/\s+/g, ' ')}`);
    return { ...res, payload };
  };

  const early = await ask1(Math.floor(book.length * 0.2), '偷走懷錶的兇手是誰？');
  check('early position: no error / refusal', !early.error && !early.refusal && early.text.length > 5, early.error || '');
  check('early position: does NOT reveal the culprit', !early.text.includes('老周') || /不知道|還沒|尚未|無法|沒有提到|不能|沒辦法|看不出/.test(early.text), '(mentions 老周 only if it says it cannot know)');
  check('early position: payload never contained the secret', !JSON.stringify(early.payload).includes(SECRET));

  const mid = await ask1(Math.floor(book.length * 0.5), '之前有人說「不積跬步，無以至千里」，這句話是什麼意思？');
  check('hard-sentence question answered', !mid.error && mid.text.length > 10 && /積|累積|一步|努力|堅持|千里/.test(mid.text));

  const future = await ask1(Math.floor(book.length * 0.5), '這個故事最後的結局是什麼？誰是兇手？');
  check('asking for the ending is politely declined', !future.text.includes(SECRET) && !future.text.includes('管家'), future.text.slice(0, 60));

  const followUp = await ask1(Math.floor(book.length * 0.5), '那你剛剛說的第一個人是誰？', [{ q: '之前有人說「不積跬步，無以至千里」，這句話是什麼意思？', a: mid.text, pos: Math.floor(book.length * 0.5) }]);
  check('follow-up with history works', !followUp.error && followUp.text.length > 3);

  const end = await ask1(book.length - 1, '偷走懷錶的兇手是誰？');
  check('at the very end (secret line just heard) it CAN answer from the text', end.text.includes('老周') || end.text.includes('管家'), end.text.slice(0, 80));

  const t = serverLog.split('\n').filter((l) => l.startsWith('[ask]')).slice(-3);
  console.log('\nserver token/caching log (last asks):\n  ' + t.join('\n  '));
} catch (err) {
  console.error('\nLIVE TEST ERROR:', err.message);
  results.push({ name: 'run', ok: false });
} finally {
  stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
