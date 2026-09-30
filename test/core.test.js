import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, unitsFromParagraph } from '../public/js/segmenter.js';
import { buildBookData, makeRanges } from '../public/js/book.js';
import { BM25, RetrievalIndex, tokenize } from '../public/js/retrieval.js';
import { MemoryTree, MemoryBuilder } from '../public/js/memory.js';
import { buildAskContext } from '../public/js/context.js';
import { detectLangFromText, resolveBookLang, chineseVariant } from '../public/js/lang.js';
import { estTokens, normalizeText } from '../public/js/util.js';
import { makeBook, makeEnglishBook, markersIn, fakeSummarizer } from './helpers.js';

test('splitSentences: Chinese terminators and closing quotes', () => {
  assert.deepEqual(splitSentences('他說：「你好。」然後走了。真的嗎？是的！'), ['他說：「你好。」', '然後走了。', '真的嗎？', '是的！']);
  assert.deepEqual(splitSentences('他想了想……然後點頭。'), ['他想了想……', '然後點頭。']);
});

test('splitSentences: English abbreviations, initials, decimals', () => {
  const s = splitSentences('Mr. Smith met J. K. Rowling at 3.14 p.m. in the U.S. Then they left. Was it fun? Yes!');
  assert.ok(s.some((x) => x.startsWith('Mr. Smith met J. K. Rowling at 3.14')), `got ${JSON.stringify(s)}`);
  assert.ok(s.includes('Was it fun?') && s.includes('Yes!'));
  assert.ok(s.some((x) => x.endsWith('Then they left.')));
});

test('unitsFromParagraph: merges short sentences and caps long ones', () => {
  assert.equal(unitsFromParagraph('好。是的。走吧。').length, 1);
  const raw = '很長的句子，'.repeat(60) + '結束了。';
  const long = unitsFromParagraph(raw);
  assert.ok(long.length > 1 && long.every((u) => u.length <= 110));
  assert.equal(long.join(''), raw);
  const en = unitsFromParagraph('word '.repeat(200).trim() + '.');
  assert.ok(en.length > 1 && en.every((u) => u.length <= 220));
});

test('buildBookData / Book: structure and navigation', () => {
  const book = makeBook();
  assert.equal(book.lang, 'zh-TW');
  assert.equal(book.chapters.length, 12);
  assert.ok(book.chapters[0].start === 0 && book.chapters[1].start > 0);
  for (let i = 0; i < book.length; i++) assert.match(book.sents[i], new RegExp(`Z${i}Z$`));
  const ps = book.paraStartOf(50);
  assert.ok(ps <= 50 && book.isParaStart[ps]);
  assert.ok(book.nextParaStart(50) > 50);
  assert.equal(book.chapterOf(0).title, '第1章測試章節1');
  assert.throws(() => buildBookData({ title: 'x', chapters: [{ title: 't', paras: ['   '] }] }));
});

test('makeRanges: contiguous, complete, roughly the requested size', () => {
  const book = makeBook();
  const r = makeRanges(book, 2800);
  assert.equal(r[0][0], 0);
  assert.equal(r[r.length - 1][1], book.length);
  for (let i = 1; i < r.length; i++) assert.equal(r[i][0], r[i - 1][1]);
  for (const [s, e] of r.slice(0, -1)) assert.ok(book.tokens(s, e) >= 2800 && book.tokens(s, e) <= 2800 * 1.6 + 100, `range ${s}-${e} = ${book.tokens(s, e)}`);
});

test('BM25: finds the right chunk and honours maxId', () => {
  const idx = new BM25();
  ['the red fox jumps', 'a blue whale swims', 'the red dragon sleeps', 'green tea is nice'].forEach((t, i) => idx.add(i, tokenize(t)));
  const q = new Map(tokenize('red dragon').map((t) => [t, 1]));
  assert.equal(idx.search(q, { limit: 1 })[0].id, 2);
  assert.ok(idx.search(q, { maxId: 1 }).every((h) => h.id <= 1));
  assert.deepEqual(idx.search(new Map([['zzz', 1]])), []);
});

test('tokenize: CJK bigrams and English words', () => {
  assert.deepEqual(tokenize('阿明來了'), ['阿明', '明來', '來了']);
  assert.deepEqual(tokenize('The Dragons sleep'), ['dragon', 'sleep']);
});

test('RetrievalIndex never indexes or returns text past the limit', () => {
  const book = makeBook();
  const retr = new RetrievalIndex(book);
  const limit = 200;
  const hits = retr.search('艾莉絲 銅鑰匙', '', limit, { limit: 5 });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.e <= limit));
  assert.ok(retr.chunks[retr.indexedChunks - 1][1] <= limit, 'index must stop at the limit');
});

test('MemoryTree cover: coarse-to-fine, no overlap, reports gaps', () => {
  const book = makeBook({ chapters: 40 });
  const tree = new MemoryTree(book);
  const n = tree.segs.length;
  assert.ok(n > 20, `need enough segments, got ${n}`);
  for (let i = 0; i < n; i++) tree.set(0, i, `L0-${i}`);
  for (let j = 0; (j + 1) * 8 <= n; j++) tree.set(1, j, `L1-${j}`);
  const { items, gaps } = tree.cover(n);
  assert.equal(gaps.length, 0);
  let next = 0;
  for (const it of items) { assert.equal(it.startSeg, next); next = it.endSeg; }
  assert.equal(next, n);
  assert.ok(items[0].lvl >= items[items.length - 1].lvl, 'oldest notes should be the coarsest');
  assert.ok(items.length < n, 'coarse notes must actually compress');
  tree.nodes.delete('0:3'); tree.nodes.delete('1:0');
  const c2 = tree.cover(n);
  assert.ok(c2.gaps.some((g) => g.startSeg <= 3 && g.endSeg > 3), JSON.stringify(c2.gaps));
});

test('MemoryTree.runnable only offers work the listener has fully passed', () => {
  const book = makeBook({ chapters: 30 });
  const tree = new MemoryTree(book);
  const known = tree.segs[4][1]; // exactly 5 complete segments
  assert.equal(tree.completeSegments(known), 5);
  assert.equal(tree.completeSegments(known - 1), 4);
  assert.deepEqual(tree.runnable(5).map((t) => [t.lvl, t.i]), [[0, 4], [0, 3], [0, 2], [0, 1], [0, 0]], 'newest first');
});

test('MemoryBuilder: summarises only text before the position and builds merges', async () => {
  const book = makeBook({ chapters: 40 });
  const tree = new MemoryTree(book);
  const log = [];
  const b = new MemoryBuilder({ book, tree, summarize: fakeSummarizer(log), concurrency: 3 });
  const pos = Math.floor(book.length * 0.6);
  b.setKnown(pos + 1);
  await b.idle();
  assert.ok(log.length > 8);
  assert.ok(log.every((l) => l.max <= pos), `summariser saw a unit past ${pos}`);
  assert.ok(log.some((l) => l.kind === 'merge'), 'merge nodes should have been produced');
  assert.equal(b.status().done, b.status().total);
  const before = log.length; // rewinding must not trigger new work
  b.setKnown(Math.floor(pos / 2));
  await b.idle();
  assert.equal(log.length, before);
  const t2 = new MemoryTree(book);
  assert.ok(t2.load(JSON.parse(JSON.stringify(tree.dump()))));
  assert.equal(t2.nodes.size, tree.nodes.size);
  assert.equal(new MemoryTree(makeBook({ chapters: 20 })).load(tree.dump()), false, 'signature mismatch must reject');
});

test('MemoryBuilder: retries after transient errors, stops on auth errors', async () => {
  const book = makeBook({ chapters: 10 });
  let calls = 0;
  const flaky = async () => { calls++; if (calls === 1) throw Object.assign(new Error('boom'), { status: 500 }); return { summary: 'ok' }; };
  const b = new MemoryBuilder({ book, tree: new MemoryTree(book), summarize: flaky, concurrency: 1 });
  b.setKnown(book.length);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(b.status().failures, 1);
  b.stop();
  const b2 = new MemoryBuilder({ book, tree: new MemoryTree(book), summarize: async () => { throw Object.assign(new Error('no'), { status: 401 }); } });
  b2.setKnown(book.length);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(b2.status().disabled, 'auth');
});

test('SPOILER GUARD: nothing past the position ever reaches the AI payload', async () => {
  const book = makeBook({ chapters: 60 });
  const tree = new MemoryTree(book);
  const retr = new RetrievalIndex(book);
  const builder = new MemoryBuilder({ book, tree, summarize: fakeSummarizer(), concurrency: 4 });
  builder.setKnown(Math.floor(book.length * 0.9)); // heard 90%, then rewound and asked at several earlier points
  await builder.idle(60_000);
  for (const frac of [0.0, 0.01, 0.05, 0.2, 0.5, 0.75, 0.89]) {
    const pos = Math.floor(book.length * frac);
    const { payload, meta } = buildAskContext({
      book, pos, question: '艾莉絲為什麼要找銅鑰匙？', tree, retr, lang: 'zh-TW',
      history: [{ q: '未來的問題', a: `答案 Z${pos + 5}Z`, pos: pos + 5 }, { q: '之前的問題', a: `答案 Z${pos}Z`, pos }],
    });
    const seen = markersIn(JSON.stringify(payload));
    assert.ok(seen.length > 0);
    assert.ok(Math.max(...seen) <= pos, `pos ${pos}: payload contains marker ${Math.max(...seen)}`);
    assert.ok(meta.maxUnit <= pos);
    assert.equal(payload.history.length, 1, 'Q&A asked at a later position must be filtered out');
    assert.ok(payload.recent.endsWith(`Z${pos}Z`), 'the current unit must be the last thing in <just_read>');
  }
});

test('Context size stays bounded no matter how far into a long book we are', async () => {
  const book = makeBook({ chapters: 200, paras: 8, sentences: 9 });
  const tree = new MemoryTree(book);
  const retr = new RetrievalIndex(book);
  const builder = new MemoryBuilder({ book, tree, summarize: fakeSummarizer(), concurrency: 8 });
  builder.setKnown(book.length);
  await builder.idle(120_000);
  const sizes = [];
  for (const frac of [0.02, 0.1, 0.3, 0.6, 0.99]) {
    const pos = Math.floor(book.length * frac);
    const { payload } = buildAskContext({ book, pos, question: '鮑伯是誰？', tree, retr });
    sizes.push([frac, estTokens(JSON.stringify(payload))]);
  }
  const max = Math.max(...sizes.map((s) => s[1]));
  assert.ok(max < 30000, `context too large: ${JSON.stringify(sizes)}`);
  console.log('   book ≈', Math.round(book.tokens(0, book.length)), 'tokens; context tokens by position:', JSON.stringify(sizes));
});

test('language helpers', () => {
  assert.equal(detectLangFromText('这是一个关于时间的故事，他们说过很多话。'), 'zh-CN');
  assert.equal(detectLangFromText('這是一個關於時間的故事，他們說過很多話。'), 'zh-TW');
  assert.equal(detectLangFromText('これは日本語の文章です。ひらがなとカタカナ。'), 'ja-JP');
  assert.equal(detectLangFromText('Hello there, this is an English sentence.', 'fr-FR'), 'fr-FR');
  assert.equal(resolveBookLang('en', 'Just some English text here for a book.'), 'en-US');
  assert.equal(chineseVariant('', 'zh-Hant'), 'zh-TW');
  assert.equal(normalizeText('你 好  world ​'), '你好 world');
});

test('English (Latin-script) books: units, segments, retrieval and the spoiler guard all work too', async () => {
  const book = makeEnglishBook({ chapters: 40 });
  assert.equal(book.lang, 'en-US');
  assert.equal(book.cjk, false);
  assert.ok(book.sents.every((u) => u.length <= 240), 'units must stay short enough for TTS');
  assert.ok(book.text(0, 3).includes(' '), 'Latin units are joined with spaces');
  const tree = new MemoryTree(book);
  const retr = new RetrievalIndex(book);
  const builder = new MemoryBuilder({ book, tree, summarize: fakeSummarizer(), concurrency: 4 });
  builder.setKnown(book.length);
  await builder.idle(60_000);
  for (const frac of [0.03, 0.4, 0.95]) {
    const pos = Math.floor(book.length * frac);
    const { payload } = buildAskContext({ book, pos, question: 'Why did Dr. Chen want the silver compass?', tree, retr });
    assert.ok(Math.max(...markersIn(JSON.stringify(payload))) <= pos);
    assert.ok(payload.recent.endsWith(`Z${pos}Z`));
  }
  const hits = retr.search('silver compass Bob Harrington', '', book.length, { limit: 3 });
  assert.ok(hits.length > 0);
});

test('MemoryBuilder: an account without credit pauses the background work instead of retrying forever', async () => {
  const book = makeBook({ chapters: 10 });
  let calls = 0;
  const b = new MemoryBuilder({ book, tree: new MemoryTree(book), summarize: async () => { calls++; throw Object.assign(new Error('no credit'), { status: 402 }); }, concurrency: 2 });
  b.setKnown(book.length);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.status().disabled, 'credit');
  const seen = calls;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls, seen, 'no further requests once paused');
  b.stop();
});

test('spoken language of mixed sentences: a Chinese sentence quoting English is Chinese', async () => {
  const { detectSpokenLang } = await import('../public/js/lang.js');
  assert.equal(detectSpokenLang('這句話"The quick brown fox jumps over the lazy dog"是什麼意思?', 'zh-TW'), 'zh-TW');
  assert.equal(detectSpokenLang('英文原句是 The quick brown fox jumps over the lazy dog。', 'en-US'), 'zh-TW', 'an English voice cannot read the Chinese part');
  assert.equal(detectSpokenLang('我聽不懂這個metaphor在故事裡代表什麼。', 'zh-TW'), 'zh-TW');
  assert.equal(detectSpokenLang('这句话里的 metaphor 是什么意思？', 'en-US'), 'zh-CN');
  assert.equal(detectSpokenLang('What does 鑰匙 mean in this story, and why does she keep it in her pocket?', 'zh-TW'), 'en-US', 'a couple of Chinese words inside an English sentence stay English');
  assert.equal(detectSpokenLang('これはどういう意味ですか', 'en-US'), 'ja-JP');
  assert.equal(detectSpokenLang('이 문장은 무슨 뜻인가요', 'en-US'), 'ko-KR');
  assert.equal(detectSpokenLang('Why did he leave?', 'fr-FR'), 'fr-FR');
});
