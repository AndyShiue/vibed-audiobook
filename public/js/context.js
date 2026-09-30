// Assembles the AI's view of the book for one question.
//
//   ┌ story so far ┐ ┌ earlier passages ┐ ┌──── just read ────┐
//   coarse→fine notes   BM25 hits, before     verbatim text up to and
//   for [0, winStart)   winStart only         including the current unit
//
// Every part is bounded, so the request size is independent of book length, and every part is
// drawn from units <= `pos`. `buildAskContext` verifies that invariant before returning.
import { estTokens } from './util.js';
import { MEM } from './memory.js';

export const CTX = { RETRIEVAL_CHUNK_TOK: 450, RETRIEVAL_K: 3, HISTORY_MAX: 4, MAX_RECENT_CHARS: 36_000, MAX_CHAPTER_TITLES: 120 };

function pctLabel(book, s, e) {
  const chS = book.chapterOf(s).title, chE = book.chapterOf(Math.max(s, e - 1)).title;
  const a = Math.round(book.fractionBefore(s) * 100), b = Math.round(book.fractionBefore(e) * 100);
  return `${a}%–${b}% of the book · ${chS}${chE !== chS ? ` → ${chE}` : ''}`;
}

/**
 * @param {object} o
 * @param {Book} o.book
 * @param {number} o.pos          index of the unit being read when the listener interrupted (inclusive)
 * @param {MemoryTree} o.tree
 * @param {RetrievalIndex} o.retr
 * @param {{q,a,pos}[]} o.history earlier Q&A (only entries asked at or before `pos` are used)
 * @param {{rate,sleep,wasPlaying}} [o.player] the player's own state, so the AI can turn "the next chapter" or
 *        "a bit faster" into the absolute values its control tools need; chapter titles stop at the current chapter
 */
export function buildAskContext({ book, pos, question, tree, retr, history = [], lang = '', includeTitle = false, player = null }) {
  if (!(pos >= 0 && pos < book.length)) throw new RangeError(`position ${pos} outside the book`);
  const known = pos + 1; // units the AI may see: [0, known)

  // 1. Verbatim window: whole segments, at least WINDOW_MIN_TOK tokens, ending at the current unit.
  const cur = tree.segmentOf(pos);
  let w = cur;
  while (w > 0 && book.tokens(tree.segs[w][0], known) < MEM.WINDOW_MIN_TOK) w--;
  let winStart = tree.segs[w][0];
  let recent = book.text(winStart, known);
  if (recent.length > CTX.MAX_RECENT_CHARS) { // pathological huge units: keep the tail
    let a = winStart;
    while (a < pos && book.text(a, known).length > CTX.MAX_RECENT_CHARS) a++;
    winStart = a; recent = book.text(a, known); w = tree.segmentOf(a);
  }

  // 2. Story so far: coarse-to-fine summaries of everything before the window.
  const { items, gaps } = tree.cover(w);
  let summaries = items.map((it) => ({ label: pctLabel(book, it.s, it.e), text: it.text, s: it.s, e: it.e }));
  let budget = summaries.reduce((t, it) => t + estTokens(it.text), 0);
  let trimmed = false;
  while (budget > MEM.SUMMARY_BUDGET_TOK && summaries.length > 1) { budget -= estTokens(summaries[0].text); summaries.shift(); trimmed = true; }

  const notes = [];
  if (gaps.length) {
    const missing = gaps.reduce((t, g) => t + (g.endSeg - g.startSeg), 0);
    const first = Math.round(book.fractionBefore(gaps[0].s) * 100), last = Math.round(book.fractionBefore(gaps[gaps.length - 1].e) * 100);
    notes.push(`The notes covering ${first === last ? `about ${first}%` : `roughly ${first}%–${last}%`} of the book (${missing} section${missing > 1 ? 's' : ''}) are still being prepared, so details from there may be missing; rely on <earlier_passages> and say so if unsure.`);
  }
  if (trimmed) notes.push('The very earliest part of the book is omitted from these notes.');

  // 3. Retrieval from earlier text (strictly before the window).
  const hint = book.text(Math.max(winStart, pos - 1), known);
  const hits = winStart > 0 ? retr.search(question, hint, winStart, { limit: CTX.RETRIEVAL_K }) : [];
  const passages = hits.map((h) => ({ label: pctLabel(book, h.s, h.e), text: book.text(h.s, h.e), s: h.s, e: h.e }));

  // 4. Earlier questions (only those asked at or before this point).
  // Logged player commands only matter for "again" / "a bit more", so they count only while they are the latest entries.
  const eligible = history.filter((h) => h.pos <= pos);
  const past = eligible.filter((h, i) => !h.cmd || i >= eligible.length - 2).slice(-CTX.HISTORY_MAX).map((h) => ({ q: h.q, a: h.a }));

  // 5. The player's state: where the listener is in the chapter list, plus titles of the chapters already reached.
  let playerState = null;
  let titleStarts = [];
  if (player) {
    const ci = book.chapterIndexOf(pos);
    const reached = book.chapters.slice(0, ci + 1).map((c, k) => ({ n: k + 1, title: c.title.slice(0, 100), start: c.start })).slice(-CTX.MAX_CHAPTER_TITLES);
    titleStarts = reached.map((c) => c.start);
    playerState = {
      chapterNumber: ci + 1,
      chapterCount: book.chapters.length,
      chapterTitle: book.chapters[ci].title,
      percent: book.fractionBefore(known) * 100,
      rate: player.rate || 1,
      sleep: player.sleep || 'off',
      wasPlaying: Boolean(player.wasPlaying),
      chapterTitles: reached.map(({ n, title }) => ({ n, title })),
    };
  }

  // Invariant: nothing beyond the current unit.
  const maxUnit = Math.max(pos, ...summaries.map((s) => s.e - 1), ...passages.map((p) => p.e - 1), ...titleStarts);
  if (maxUnit > pos) throw new Error(`spoiler guard: context reaches unit ${maxUnit} but position is ${pos}`);

  const payload = {
    question,
    lang,
    chapterTitle: book.chapterOf(pos).title,
    progressPct: book.fractionBefore(known) * 100,
    summaries: summaries.map(({ label, text }) => ({ label, text })),
    coverageNote: notes.join(' '),
    passages: passages.map(({ label, text }) => ({ label, text })),
    recent,
    history: past,
  };
  if (includeTitle && (book.title || book.author)) payload.bookInfo = { title: book.title, author: book.author };
  if (playerState) payload.player = playerState;

  const meta = {
    pos, winStart, maxUnit,
    windowTokens: estTokens(recent),
    summaryTokens: budget,
    summaryNodes: summaries.length,
    gaps: gaps.length,
    passages: passages.map((p) => [p.s, p.e]),
  };
  return { payload, meta };
}
