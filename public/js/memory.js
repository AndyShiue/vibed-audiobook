// Hierarchical "story so far" memory.
//
// The book is cut into segments of ~2.8k tokens. Once the listener has fully passed a segment it is
// summarised (level 0). Every 8 consecutive summaries are merged into one coarser summary (level 1),
// and so on (level 2 = 64 segments, level 3 = 512 …). To answer a question we take the coarsest
// notes for the far past and finer notes towards the present, so the amount of text sent to the
// model grows logarithmically with the length of the book instead of linearly.
//
// Spoiler safety: a segment is only ever summarised after the listener's position is past its end,
// and a merged node only covers segments that are all before that position. Nodes are pure
// functions of the text they cover, so they stay valid (and unused) if the listener rewinds.
import { estTokens, bsearchLE, sleep } from './util.js';

export const MEM = { SEG_TOK: 2800, B: 8, WINDOW_MIN_TOK: 2200, SUMMARY_BUDGET_TOK: 6000, MAX_NODE_CHARS: 2800 };

export class MemoryTree {
  constructor(book, { segTok = MEM.SEG_TOK, B = MEM.B } = {}) {
    this.book = book;
    this.B = B;
    this.segTok = segTok;
    this.segs = book.segments(segTok);
    this.nodes = new Map(); // "lvl:idx" -> summary text
    this.pow = [1];
    while (this.pow[this.pow.length - 1] * B <= this.segs.length) this.pow.push(this.pow[this.pow.length - 1] * B);
  }

  get signature() {
    const last = this.segs[this.segs.length - 1];
    return `${this.segTok}:${this.B}:${this.segs.length}:${last ? last[1] : 0}`;
  }

  static key(lvl, i) { return `${lvl}:${i}`; }
  has(lvl, i) { return this.nodes.has(MemoryTree.key(lvl, i)); }
  get(lvl, i) { return this.nodes.get(MemoryTree.key(lvl, i)); }
  set(lvl, i, text) { this.nodes.set(MemoryTree.key(lvl, i), String(text).slice(0, MEM.MAX_NODE_CHARS)); }

  /** Segment index range [startSeg, endSeg) covered by node (lvl, i). */
  span(lvl, i) { return [i * this.pow[lvl], (i + 1) * this.pow[lvl]]; }
  /** Unit range [s, e) covered by node (lvl, i). */
  range(lvl, i) { const [a, b] = this.span(lvl, i); return [this.segs[a][0], this.segs[b - 1][1]]; }

  /** Number of segments that end at or before `known` units (i.e. that the listener has fully heard). */
  completeSegments(known) {
    let lo = 0, hi = this.segs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.segs[mid][1] <= known) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** Index of the segment containing unit `u`. */
  segmentOf(u) { return Math.max(0, bsearchLE(this._starts(), u)); }
  _starts() { return (this._st ??= this.segs.map((s) => s[0])); }

  /**
   * Coarse-to-fine cover of segments [0, k) using the summaries that exist.
   * Returns ordered items plus `gaps` (segment runs with no summary yet).
   */
  cover(k) {
    const items = [], gaps = [];
    let i = 0;
    while (i < k) {
      let lvl = 0;
      while (lvl + 1 < this.pow.length && i % this.pow[lvl + 1] === 0 && i + this.pow[lvl + 1] <= k) lvl++;
      let placed = false;
      for (; lvl >= 0; lvl--) {
        const size = this.pow[lvl];
        if (i % size === 0 && i + size <= k && this.has(lvl, i / size)) {
          const [s, e] = this.range(lvl, i / size);
          items.push({ lvl, idx: i / size, startSeg: i, endSeg: i + size, s, e, text: this.get(lvl, i / size) });
          i += size; placed = true; break;
        }
      }
      if (!placed) {
        const last = gaps[gaps.length - 1];
        if (last && last.endSeg === i) last.endSeg = i + 1; else gaps.push({ startSeg: i, endSeg: i + 1 });
        i += 1;
      }
    }
    for (const g of gaps) { g.s = this.segs[g.startSeg][0]; g.e = this.segs[g.endSeg - 1][1]; }
    return { items, gaps };
  }

  /**
   * Summaries that could be produced right now for segments [0, k): merges first (cheap, they shrink the
   * context), then level-0 notes newest first — when catching up after a jump, the text nearest the
   * listener is the most useful to have ready.
   */
  runnable(k) {
    const tasks = [];
    for (let i = 0; i < k; i++) if (!this.has(0, i)) tasks.push({ lvl: 0, i, endSeg: i + 1 });
    for (let lvl = 1; lvl < this.pow.length; lvl++) {
      const size = this.pow[lvl];
      for (let j = 0; (j + 1) * size <= k; j++) {
        if (this.has(lvl, j)) continue;
        let ready = true;
        for (let c = 0; c < this.B; c++) if (!this.has(lvl - 1, j * this.B + c)) { ready = false; break; }
        if (ready) tasks.push({ lvl, i: j, endSeg: (j + 1) * size });
      }
    }
    return tasks.sort((a, b) => (b.lvl > 0) - (a.lvl > 0) || b.endSeg - a.endSeg);
  }

  levelZeroCount(k) { let n = 0; for (let i = 0; i < k; i++) if (this.has(0, i)) n++; return n; }

  dump() { return { sig: this.signature, nodes: Object.fromEntries(this.nodes) }; }
  load(obj) {
    if (!obj || obj.sig !== this.signature) return false;
    for (const [k, v] of Object.entries(obj.nodes || {})) if (typeof v === 'string') this.nodes.set(k, v);
    return true;
  }
}

/** Runs summarisation in the background as the listener progresses. */
export class MemoryBuilder {
  /**
   * @param summarize async (request) => {summary: string|null, refusal?: boolean}; rejects with {status}
   */
  constructor({ book, tree, summarize, concurrency = 2, onChange = () => {}, onStatus = () => {} }) {
    Object.assign(this, { book, tree, summarize, concurrency, onChange, onStatus });
    this.known = 0;
    this.inflight = new Set();
    this.disabled = null; // 'auth' | 'config' | null
    this.failures = 0;
    this.timer = null;
    this.ac = new AbortController();
    this.stopped = false;
  }

  get k() { return this.tree.completeSegments(this.known); }

  setKnown(known) {
    const before = this.k;
    this.known = known;
    if (this.k !== before) this.kick();
  }

  status() {
    const k = this.k;
    return { done: this.tree.levelZeroCount(k), total: k, running: this.inflight.size, disabled: this.disabled, failures: this.failures };
  }

  resume() { this.disabled = null; this.failures = 0; this.kick(); }
  stop() { this.stopped = true; this.ac.abort(); clearTimeout(this.timer); }

  kick() {
    if (this.stopped || this.disabled || this.timer) return;
    const k = this.k;
    if (this.inflight.size < this.concurrency) {
      for (const t of this.tree.runnable(k)) {
        if (this.inflight.size >= this.concurrency) break;
        const key = MemoryTree.key(t.lvl, t.i);
        if (!this.inflight.has(key)) this.run(t, key);
      }
    }
    this.onStatus(this.status());
  }

  requestFor(t) {
    const { book, tree } = this;
    const cjk = book.cjk;
    if (t.lvl === 0) {
      const [s, e] = tree.segs[t.i];
      return {
        kind: 'segment', lang: book.lang, text: book.text(s, e), chapterTitle: book.chapterOf(s).title,
        prevTail: s > 0 ? book.text(Math.max(0, s - 6), s).slice(-400) : '', targetChars: cjk ? 220 : 800,
      };
    }
    const parts = [];
    for (let c = 0; c < tree.B; c++) parts.push(tree.get(t.lvl - 1, t.i * tree.B + c));
    return { kind: 'merge', lang: book.lang, parts, targetChars: Math.round((cjk ? 260 : 900) * (1 + 0.25 * (t.lvl - 1))) };
  }

  localFallback(t, req) {
    const src = req.kind === 'merge' ? req.parts.join(' ') : req.text;
    const flat = src.replace(/\s+/g, ' ');
    return `（自動摘要不可用）${flat.slice(0, 160)}${flat.length > 160 ? '…' : ''}`;
  }

  async run(t, key) {
    this.inflight.add(key);
    const req = this.requestFor(t);
    try {
      // Re-check at dispatch time: the listener may have rewound since this task was queued.
      if (t.endSeg > this.k) return;
      const res = await this.summarize(req, this.ac.signal);
      const text = res.summary && res.summary.trim() ? res.summary.trim() : this.localFallback(t, req);
      this.tree.set(t.lvl, t.i, text);
      this.failures = 0;
      this.onChange();
    } catch (err) {
      if (this.stopped || err?.name === 'AbortError') return;
      const status = err?.status;
      if (status === 401 || status === 403) this.disabled = 'auth';
      else if (status === 402) this.disabled = 'credit';
      else if (status === 503 || status === 404) this.disabled = 'config';
      else if (status === 400 || status === 413 || status === 422) {
        // The request itself is unacceptable: retrying won't help, so keep a plain excerpt as this note.
        this.tree.set(t.lvl, t.i, this.localFallback(t, req));
        this.onChange();
      } else {
        this.failures++;
        const delay = Math.min(60_000, 2000 * 2 ** Math.min(this.failures, 5));
        this.timer = setTimeout(() => { this.timer = null; this.kick(); }, delay);
      }
    } finally {
      this.inflight.delete(key);
      queueMicrotask(() => this.kick());
    }
  }

  /** Resolves when everything currently runnable is done (used by tests). */
  async idle(maxMs = 20_000) {
    const t0 = Date.now();
    while ((this.inflight.size || this.tree.runnable(this.k).length) && !this.disabled && Date.now() - t0 < maxMs) await sleep(20);
  }
}

export const nodeTokens = (text) => estTokens(text);
