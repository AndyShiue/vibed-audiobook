// The in-memory model of an imported book, plus helpers to navigate it.
//
//   sents[i]      – speech unit i (this index IS the reading position)
//   paraStart[]   – ascending unit indices where a paragraph starts
//   chapters[]    – {title, start} ascending by start
//
// Everything downstream (progress, summaries, retrieval, the AI context) is expressed
// in unit indices, which makes the "never look past the listener" rule easy to enforce.
import { estTokens, normalizeText, bsearchLE, cjkRatio, gapBetween, joinText } from './util.js';
import { unitsFromParagraph, SEG_VERSION } from './segmenter.js';
import { resolveBookLang } from './lang.js';
import { t } from './i18n.js';

const PREAMBLE_MAX_PARAS = 3, PREAMBLE_MAX_CHARS = 80;

/**
 * A title page — just the book's name and author before the first real chapter — is not a chapter of its own:
 * left alone it would be "section 1" and shift every later chapter number by one, so "chapter 3" (the story's third)
 * would land in the second. Such a preamble is read first but belongs to the chapter that follows it.
 */
function foldTitlePage(chapters) {
  const [first, second, ...rest] = chapters;
  if (!second || (first.title || '').trim()) return chapters;
  const paras = (first.paras || []).map(normalizeText).filter((p) => /[\p{L}\p{N}]/u.test(p));
  if (!paras.length || paras.length > PREAMBLE_MAX_PARAS || paras.join('').length > PREAMBLE_MAX_CHARS) return chapters;
  return [{ ...second, preamble: paras }, ...rest];
}

const hasLetter = (p) => /[\p{L}\p{N}]/u.test(p);

/** parsed = {title, author, language, chapters: [{title, paras: string[]}]} → storable book data. */
export function buildBookData(parsed) {
  // 1. clean the text and decide the language — the sentence rules need it ("am 3. Mai" is an ordinal only in German …)
  const prepared = [];
  for (const ch of foldTitlePage(parsed.chapters)) {
    const paras = (ch.paras || []).map(normalizeText).filter(hasLetter);
    if (paras.length) prepared.push({ ch, paras, preamble: ch.preamble || [] });
  }
  if (!prepared.length) throw new Error(t('err.noReadable'));
  const sample = prepared.flatMap((c) => [...c.preamble, ...c.paras]).slice(0, 60).join(' ').slice(0, 6000);
  const lang = resolveBookLang(parsed.language, sample);

  // 2. cut it into speech units
  const sents = [];
  const paraStart = [];
  const chapters = [];
  const addParagraph = (p) => {
    paraStart.push(sents.length);
    for (const u of unitsFromParagraph(p, { lang })) sents.push(u);
  };
  prepared.forEach(({ ch, paras, preamble }, k) => {
    const title = normalizeText(ch.title || '') || t('section.n', { n: k + 1 });
    chapters.push({ title, start: sents.length });
    preamble.forEach(addParagraph);
    const titleIsFirstPara = paras[0] === title || paras[0].replace(/\s/g, '') === title.replace(/\s/g, '');
    if (ch.title && !titleIsFirstPara) addParagraph(title);
    paras.forEach(addParagraph);
  });
  if (!sents.length) throw new Error(t('err.noReadable'));
  return { title: normalizeText(parsed.title || ''), author: normalizeText(parsed.author || ''), lang, sents, paraStart, chapters, seg: SEG_VERSION };
}

/**
 * Cut a stored book again with the current rules (SEG_VERSION went up). The paragraphs are put back together from
 * their units, re-cut, and `mapIndex` carries a reading position (or a Q&A position) over to the new units, so that
 * the listener stays where they were.
 */
export function resegmentBook(rec) {
  const { sents: old, chapters: oldChapters, lang } = rec;
  const oldStart = rec.paraStart?.length ? rec.paraStart : [0];
  const sents = [];
  const paraStart = [];
  const firstUnit = []; // old paragraph -> first new unit
  oldStart.forEach((s, k) => {
    const e = oldStart[k + 1] ?? old.length;
    let text = old[s];
    for (let u = s + 1; u < e; u++) text = joinText(text, old[u]);
    firstUnit.push(sents.length);
    paraStart.push(sents.length);
    for (const u of unitsFromParagraph(text, { lang })) sents.push(u);
  });
  firstUnit.push(sents.length);
  const paraOf = (i) => Math.max(0, bsearchLE(oldStart, i));
  const chapters = oldChapters.map((c) => ({ title: c.title, start: firstUnit[paraOf(c.start)] }));

  const sum = (arr, a, b) => { let t = 0; for (let i = a; i < b; i++) t += arr[i].length; return t; };
  const mapIndex = (idx) => {
    const i = Math.max(0, Math.min(Number(idx) || 0, old.length - 1));
    const k = paraOf(i);
    const s = oldStart[k], e = oldStart[k + 1] ?? old.length;
    const frac = sum(old, s, i) / Math.max(1, sum(old, s, e)); // how far into its paragraph the position was
    const ns = firstUnit[k], ne = firstUnit[k + 1];
    const target = frac * sum(sents, ns, ne);
    let acc = 0;
    for (let u = ns; u < ne; u++) {
      if (acc + sents[u].length > target) return u;
      acc += sents[u].length;
    }
    return Math.max(ns, ne - 1);
  };
  return { data: { sents, paraStart, chapters, seg: SEG_VERSION }, mapIndex };
}

/** Split units into consecutive [s, e) ranges of roughly `target` tokens, ending on paragraph boundaries. */
export function makeRanges(book, target, maxFactor = 1.5, tailFactor = 0.3) {
  const n = book.sents.length;
  const isPS = book.isParaStart;
  const ranges = [];
  let s = 0, acc = 0;
  for (let i = 0; i < n; i++) {
    acc += book.tok[i];
    const last = i === n - 1;
    if (last || (acc >= target && (isPS[i + 1] || acc >= maxFactor * target))) {
      ranges.push([s, i + 1]);
      s = i + 1;
      acc = 0;
    }
  }
  if (ranges.length > 1) {
    const [ts, te] = ranges[ranges.length - 1];
    if (book.tokens(ts, te) < tailFactor * target) { ranges.pop(); ranges[ranges.length - 1][1] = te; }
  }
  return ranges;
}

export class Book {
  constructor(record) {
    Object.assign(this, { id: record.id, title: record.title, author: record.author, lang: record.lang, seg: record.seg ?? 1 });
    this.sents = record.sents;
    this.paraStart = record.paraStart;
    this.chapters = record.chapters;
    const n = this.sents.length;
    this.tok = new Uint16Array(n);
    this.cumTok = new Float64Array(n + 1);
    this.cumChars = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const t = Math.min(65535, estTokens(this.sents[i]));
      this.tok[i] = t;
      this.cumTok[i + 1] = this.cumTok[i] + t;
      this.cumChars[i + 1] = this.cumChars[i] + this.sents[i].length;
    }
    this.isParaStart = new Uint8Array(n + 1);
    for (const p of this.paraStart) this.isParaStart[p] = 1;
    this.isParaStart[n] = 1;
    this.chapterStarts = this.chapters.map((c) => c.start);
    this.cjk = cjkRatio(this.sents.slice(0, 200).join('')) > 0.3;
  }

  get length() { return this.sents.length; }
  tokens(a, b) { return this.cumTok[b] - this.cumTok[a]; }
  /** Fraction of the book's characters that lie before unit `i` (i.e. through unit i-1). */
  fractionBefore(i) { return this.cumChars[this.length] ? this.cumChars[i] / this.cumChars[this.length] : 0; }
  /** Unit at which `f` (0..1) of the book's characters have passed. */
  unitAtFraction(f) {
    const target = Math.min(1, Math.max(0, f)) * this.cumChars[this.length];
    let lo = 0, hi = this.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cumChars[mid + 1] <= target) lo = mid + 1; else hi = mid; }
    return lo;
  }
  chapterIndexOf(i) { return Math.max(0, bsearchLE(this.chapterStarts, i)); }
  chapterOf(i) { return this.chapters[this.chapterIndexOf(i)]; }
  paraIndexOf(i) { return Math.max(0, bsearchLE(this.paraStart, i)); }
  paraStartOf(i) { return this.paraStart[this.paraIndexOf(i)] ?? 0; }
  nextParaStart(i) { const k = this.paraIndexOf(i) + 1; return k < this.paraStart.length ? this.paraStart[k] : this.length; }

  /** Text of units [a, b) with a blank line between paragraphs. */
  text(a, b) {
    let out = '';
    for (let i = a; i < b; i++) {
      if (i > a && this.isParaStart[i]) out += '\n\n';
      else if (i > a) out += gapBetween(this.sents[i - 1], this.sents[i]); // no space next to Chinese/Japanese; Korean and the rest keep theirs
      out += this.sents[i];
    }
    return out;
  }

  /** Summary-memory segments, cached per target size. */
  segments(target) {
    this._seg ??= new Map();
    if (!this._seg.has(target)) this._seg.set(target, makeRanges(this, target));
    return this._seg.get(target);
  }
}
