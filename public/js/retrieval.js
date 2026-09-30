// A small BM25 index over passages the listener has already heard.
// No embeddings needed: CJK text is indexed as character bigrams, Latin text as words.
// Because chunks are only ever added for text before the reading position (and every query
// carries a hard `maxId`), retrieval can never surface something the listener hasn't reached.
import { isCJKCode } from './util.js';

const STOP = new Set(('the a an and or of to in is are was were be been being it its he she they them his her their i you we me my your our this that these those ' +
  'with for on at as by from but not had has have do does did what who whom which when where why how so if then than there here would could should will can may about into out up over ' +
  'said says say').split(' '));

export function tokenize(text) {
  const toks = [];
  let latin = '', cjk = '';
  const flushLatin = () => {
    if (latin.length >= 2 && !STOP.has(latin)) {
      let w = latin;
      if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
      toks.push(w);
    }
    latin = '';
  };
  const flushCjk = () => {
    const chars = Array.from(cjk);
    if (chars.length === 1) toks.push(chars[0]);
    else for (let i = 0; i < chars.length - 1; i++) toks.push(chars[i] + chars[i + 1]);
    cjk = '';
  };
  for (const ch of text.toLowerCase()) {
    const c = ch.codePointAt(0);
    if (isCJKCode(c)) { if (latin) flushLatin(); cjk += ch; }
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c > 127 && /[\p{L}\p{N}]/u.test(ch))) { if (cjk) flushCjk(); latin += ch; }
    else { if (latin) flushLatin(); if (cjk) flushCjk(); }
  }
  if (latin) flushLatin();
  if (cjk) flushCjk();
  return toks;
}

export class BM25 {
  constructor(k1 = 1.2, b = 0.75) {
    this.k1 = k1; this.b = b;
    this.postIds = new Map(); // token -> number[] of doc ids (ascending)
    this.postTfs = new Map(); // token -> number[] of term frequencies
    this.docLen = [];
    this.totalLen = 0;
  }

  get size() { return this.docLen.length; }

  /** Docs must be added with consecutive ids 0,1,2,… */
  add(id, tokens) {
    if (id !== this.docLen.length) throw new Error(`BM25.add expects id ${this.docLen.length}, got ${id}`);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, f] of tf) {
      let ids = this.postIds.get(t);
      if (!ids) { ids = []; this.postIds.set(t, ids); this.postTfs.set(t, []); }
      ids.push(id); this.postTfs.get(t).push(f);
    }
    this.docLen.push(tokens.length);
    this.totalLen += tokens.length;
  }

  /** query: Map<token, weight>. Only docs with id <= maxId can be returned. */
  search(query, { maxId = Infinity, limit = 5 } = {}) {
    const N = Math.min(this.docLen.length, maxId + 1);
    if (N <= 0) return [];
    const avg = this.totalLen / this.docLen.length || 1;
    const scores = new Map();
    for (const [t, w] of query) {
      const ids = this.postIds.get(t);
      if (!ids) continue;
      const tfs = this.postTfs.get(t);
      let df = 0;
      while (df < ids.length && ids[df] <= maxId) df++;
      if (!df) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let k = 0; k < df; k++) {
        const id = ids[k], f = tfs[k];
        const s = w * idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * this.docLen[id] / avg));
        scores.set(id, (scores.get(id) || 0) + s);
      }
    }
    return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/**
 * Incremental retrieval index for a Book. `ensure(limitUnit)` indexes every chunk that ends at or
 * before `limitUnit`; nothing beyond that is ever tokenised.
 */
export class RetrievalIndex {
  constructor(book, chunkTokens = 450) {
    this.book = book;
    this.chunks = book.segments(chunkTokens); // [[s, e], ...]
    this.bm25 = new BM25();
  }

  get indexedChunks() { return this.bm25.size; }

  ensure(limitUnit, budgetMs = Infinity) {
    const t0 = performance.now();
    while (this.bm25.size < this.chunks.length) {
      const [s, e] = this.chunks[this.bm25.size];
      if (e > limitUnit) break;
      this.bm25.add(this.bm25.size, tokenize(this.book.text(s, e)));
      if (performance.now() - t0 > budgetMs) break;
    }
    return this.bm25.size;
  }

  /** How many chunks lie completely before `limitUnit`. */
  chunksBefore(limitUnit) {
    let lo = 0, hi = this.chunks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.chunks[mid][1] <= limitUnit) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /**
   * Best earlier passages for a question. Only chunks ending at or before `limitUnit` are eligible.
   * `hintText` (e.g. the last couple of sentences) is added at lower weight to resolve pronouns.
   */
  search(question, hintText, limitUnit, { limit = 3, minRatio = 0.35 } = {}) {
    this.ensure(limitUnit);
    const maxId = this.chunksBefore(limitUnit) - 1;
    if (maxId < 0) return [];
    const q = new Map();
    for (const t of tokenize(question)) q.set(t, (q.get(t) || 0) + 3);
    for (const t of tokenize(hintText || '')) q.set(t, (q.get(t) || 0) + 1);
    const hits = this.bm25.search(q, { maxId, limit: limit * 2 });
    if (!hits.length) return [];
    const top = hits[0].score;
    return hits.filter((h) => h.score >= top * minRatio).slice(0, limit)
      .map((h) => ({ id: h.id, score: h.score, s: this.chunks[h.id][0], e: this.chunks[h.id][1] }))
      .sort((a, b) => a.s - b.s);
  }
}
