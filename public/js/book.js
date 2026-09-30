// The in-memory model of an imported book, plus helpers to navigate it.
//
//   sents[i]      – speech unit i (this index IS the reading position)
//   paraStart[]   – ascending unit indices where a paragraph starts
//   chapters[]    – {title, start} ascending by start
//
// Everything downstream (progress, summaries, retrieval, the AI context) is expressed
// in unit indices, which makes the "never look past the listener" rule easy to enforce.
import { estTokens, normalizeText, bsearchLE, cjkRatio } from './util.js';
import { unitsFromParagraph } from './segmenter.js';
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

/** parsed = {title, author, language, chapters: [{title, paras: string[]}]} → storable book data. */
export function buildBookData(parsed) {
  const sents = [];
  const paraStart = [];
  const chapters = [];
  let fallbackNo = 0;
  for (const ch of foldTitlePage(parsed.chapters)) {
    const paras = (ch.paras || []).map(normalizeText).filter((p) => /[\p{L}\p{N}]/u.test(p));
    if (!paras.length) continue;
    fallbackNo++;
    const title = normalizeText(ch.title || '') || t('section.n', { n: fallbackNo });
    chapters.push({ title, start: sents.length });
    for (const p of ch.preamble || []) {
      paraStart.push(sents.length);
      for (const u of unitsFromParagraph(p)) sents.push(u);
    }
    const titleIsFirstPara = paras[0] === title || paras[0].replace(/\s/g, '') === title.replace(/\s/g, '');
    if (ch.title && !titleIsFirstPara) {
      paraStart.push(sents.length);
      for (const u of unitsFromParagraph(title)) sents.push(u);
    }
    for (const p of paras) {
      paraStart.push(sents.length);
      for (const u of unitsFromParagraph(p)) sents.push(u);
    }
  }
  if (!sents.length) throw new Error(t('err.noReadable'));
  const sample = sents.slice(0, 400).join(' ');
  const lang = resolveBookLang(parsed.language, sample);
  return { title: normalizeText(parsed.title || ''), author: normalizeText(parsed.author || ''), lang, sents, paraStart, chapters };
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
    Object.assign(this, { id: record.id, title: record.title, author: record.author, lang: record.lang });
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
      else if (i > a) {
        const prev = this.sents[i - 1], cur = this.sents[i];
        out += prev.charCodeAt(prev.length - 1) >= 0x2e80 || cur.charCodeAt(0) >= 0x2e80 ? '' : ' ';
      }
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
