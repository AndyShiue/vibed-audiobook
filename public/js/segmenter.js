// Turns paragraphs into "speech units" — sentence-sized pieces that are spoken one at a time.
// The unit index is the app's reading position, so the result must be deterministic.
//
// What makes a cut sound wrong is a cut in the middle of something: "Dr. | Chen", a quotation cut from its
// "he said", a closing » left at the start of the next sentence, a Chinese word split in two. So every rule below errs
// on the side of NOT cutting — a missed boundary only makes one unit a little longer, a wrong one is audible — and the
// rules are written from Unicode properties and scripts rather than for one language:
//   • sentence ends come from the Unicode "Sentence_Terminal" property (. ! ? 。 ！ ？ । ۔ ؟ ։ ። ။ ។ …),
//   • quotation marks and brackets are tracked in pairs, so « French », „German“, 「Japanese」 and "English" all keep
//     their closing mark — and a following "he said" — with the sentence they belong to,
//   • abbreviations come from abbreviations.js (many languages) plus their shape (initials, "U.S.", "z.B."),
//   • where a long sentence has to be cut, the cut falls at a comma/clause or a word boundary — the browser's own word
//     dictionary for scripts written without spaces (Chinese, Japanese, Thai, Khmer, Lao, Burmese).
import { joinText } from './util.js';
import { ABBREVIATIONS, NUMBER_ABBREVIATIONS, ORDINAL_DOT_LANGS } from './abbreviations.js';

/** Bump when the rules change in a way that moves unit boundaries: stored books are then re-cut when opened. */
export const SEG_VERSION = 2;

// ---------------------------------------------------------------- character classes
let T; // built once, on first use
function tables() {
  if (T) return T;
  const sets = { term: new Set(), close: new Set(), open: new Set() };
  const scan = (from, to) => {
    for (let c = from; c <= to; c++) {
      const ch = String.fromCharCode(c);
      if (/\p{Sentence_Terminal}/u.test(ch)) sets.term.add(ch);
      else if (/[\p{Pe}\p{Pf}]/u.test(ch)) sets.close.add(ch);
      else if (/[\p{Ps}\p{Pi}]/u.test(ch)) sets.open.add(ch);
    }
  };
  scan(0x21, 0x2bff); scan(0x3000, 0x303f); scan(0xa000, 0xaaff); scan(0xfe10, 0xfe6f); scan(0xff00, 0xffef);
  sets.term.delete('၊'); // Burmese "little section": a comma in practice
  for (const ch of '…⋯།༎') sets.term.add(ch);
  for (const ch of '¿¡"\'') sets.open.add(ch);
  T = sets;
  return T;
}

const LATIN_TERM = new Set(['.', '!', '?', '…', '⋯', '‼', '⁇', '⁈', '⁉', ';', ';']); // punctuation of cased, spaced scripts
const isLower = (ch) => ch !== undefined && /\p{Ll}/u.test(ch);
const isLetter = (ch) => ch !== undefined && /\p{L}/u.test(ch);
const isDash = (ch) => ch !== undefined && /\p{Pd}/u.test(ch);
const isGreek = (ch) => ch !== undefined && /\p{Script=Greek}/u.test(ch);
/** Written without spaces between sentences: a new sentence can follow a full stop directly. */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}　-〿＀-￯]/u;

function isTerminatorAt(text, i) {
  const ch = text[i];
  if (tables().term.has(ch)) return true;
  // the Greek question mark is the semicolon character: "Τι κάνεις;"
  return (ch === ';' || ch === ';') && isGreek(text[i - 1]) && (text[i + 1] === undefined || text[i + 1] === ' ' || tables().close.has(text[i + 1]));
}

// ---------------------------------------------------------------- quotation marks and brackets, in pairs
const PAIRS = {
  '(': ')', '[': ']', '{': '}', '「': '」', '『': '』', '【': '】', '《': '》', '〈': '〉', '（': '）', '〔': '〕', '〖': '〗',
  '«': '»', '‹': '›', '“': '”', '‘': '’', '„': '“', '‚': '‘', '»': '«', '›': '‹', // » « also open German quotations: »Hallo!«
};

/** Which closing mark is expected next, e.g. after « in "« Bonjour. » dit-il." (French puts a space before ». ) */
class Quotes {
  constructor() { this.stack = []; }
  get top() { return this.stack[this.stack.length - 1]; }
  push(c) { this.stack.push(c); if (this.stack.length > 6) this.stack.shift(); } // unbalanced marks must not pile up
  feed(ch, next) {
    if (ch === '"') { if (this.top === '"') this.stack.pop(); else this.push('"'); return; }
    if (ch === '’' || ch === "'") { if (this.top === ch && !isLetter(next)) this.stack.pop(); return; } // apostrophes open nothing
    if (this.top === ch) { this.stack.pop(); return; }
    if (PAIRS[ch]) this.push(PAIRS[ch]);
  }
}

/** Closing marks that belong to the sentence that has just ended. Returns the index after them. */
function absorbClosers(text, from, q) {
  const { close } = tables();
  let k = from;
  for (;;) {
    const m = text[k] === ' ' ? k + 1 : k;
    const ch = text[m];
    if (ch === undefined) return k;
    const spaced = m > k;
    if (q.top === ch || (!spaced && (close.has(ch) || ch === '"' || ch === "'"))) { q.feed(ch, text[m + 1]); k = m + 1; } else return k;
  }
}

// ---------------------------------------------------------------- where does a sentence end?
function trailingToken(before) {
  const word = /(?:^|[^\p{L}\p{M}.])((?:[\p{L}\p{M}]+\.)*[\p{L}\p{M}]+)$/u.exec(before);
  if (word) return { kind: 'word', text: word[1] };
  const num = /(?:^|[^\p{N}.,])(\p{N}{1,3})$/u.exec(before);
  return num ? { kind: 'digits', text: num[1] } : null;
}

/** 'end' | 'continue' | 'wait' (streaming: the next character has not arrived yet). */
function judge(text, i, j, k, o) {
  const n = text.length;
  let m = k;
  while (m < n && text[m] === ' ') m++;
  if (m >= n) return o.final ? 'end' : 'wait';
  const run = text.slice(i, j);
  const next = text[m];
  const latin = [...run].every((c) => LATIN_TERM.has(c));
  const { open } = tables();

  if (m === k) { // no space after the stop (and its closing marks)
    if (open.has(next)) return 'end';                                // ...." "Next    or    。「Next」
    if (!latin) return 'end';                                         // 。 ！ ？ । ۔ ։ ។ — these are followed directly by the next sentence
    if (NO_SPACE_SCRIPT.test(next)) return run !== '.' || NO_SPACE_SCRIPT.test(text[i - 1] ?? '') ? 'end' : 'continue';
    return 'continue';                                                // 3.14   e.g   example.com/?x=1   Wait...what
  }

  if (latin) {
    if (isLower(next)) return 'continue';                             // "Stop!" he cried.   Wait... what?   etc. and so on
    if (',;:،؛'.includes(next)) return 'continue';                    // „Warum?“, fragte sie.
    if (isDash(next)) {                                               // dialogue dashes: —¿Quién eres? —preguntó él.  /  — Как дела? — спросил Иван.
      let t = m + 1;
      while (t < n && text[t] === ' ') t++;
      return isLower(text[t]) ? 'continue' : 'end';
    }
    if (run === '.') {
      const tok = trailingToken(text.slice(Math.max(0, i - 40), i));
      if (tok?.kind === 'word') {
        if (tok.text.includes('.')) return 'continue';                // U.S.  z.B.  т.е.  μ.μ.
        if ([...tok.text].length === 1) return 'continue';            // J. K. Rowling   А. С. Пушкин   z. B.
        const low = tok.text.toLowerCase();
        if (ABBREVIATIONS.has(low)) return 'continue';                // Dr. Chen   Sra. García   ул. Ленина
        if (NUMBER_ABBREVIATIONS.has(low) && /\p{N}/u.test(next)) return 'continue'; // No. 5   Fig. 2   but not "No. He left."
      } else if (tok?.kind === 'digits' && o.ordinalDot) return 'continue'; // am 3. Mai
    }
  }
  return 'end';
}

/** The index where the sentence that starts at `from` ends, or -1 if it has not ended (yet). */
function nextSentenceEnd(text, from, o) {
  const n = text.length;
  const q = new Quotes();
  for (let i = from; i < n;) {
    if (text[i] === '\n' && o.newlineEnds) return i + 1;
    if (!isTerminatorAt(text, i)) { q.feed(text[i], text[i + 1]); i++; continue; }
    let j = i + 1;
    while (j < n && isTerminatorAt(text, j)) j++;
    const k = absorbClosers(text, j, q);
    const verdict = judge(text, i, j, k, o);
    if (verdict === 'end') return k;
    if (verdict === 'wait') return -1;
    i = k;
  }
  return -1;
}

const optionsFrom = ({ lang = '', final = true, newlineEnds = false } = {}) => ({
  final, newlineEnds, ordinalDot: ORDINAL_DOT_LANGS.has(String(lang).split(/[-_]/)[0].toLowerCase()),
});

/** Sentences that are complete, plus the unfinished rest (only non-empty while streaming, i.e. final: false). */
export function scanSentences(text, opts) {
  const o = optionsFrom(opts);
  const sentences = [];
  let start = 0;
  for (;;) {
    while (text[start] === ' ') start++;
    if (start >= text.length) return { sentences, rest: '' };
    const end = nextSentenceEnd(text, start, o);
    if (end < 0) {
      const rest = text.slice(start);
      if (o.final) { if (rest.trim()) sentences.push(rest.trim()); return { sentences, rest: '' }; }
      return { sentences, rest };
    }
    const s = text.slice(start, end).trim();
    if (s) sentences.push(s);
    start = end;
  }
}

/** Split a paragraph into sentences (terminators stay attached; closing quotes and "he said" stay with their sentence). */
export function splitSentences(text, opts) {
  return scanSentences(text, opts).sentences;
}

// ---------------------------------------------------------------- cutting a sentence that is too long
const STRONG = new Set([';', ':', '；', '：', '—', '―', '–', '─', '؛', '፤']);
const COMMA = new Set([',', '，', '、', '､', '،', '፣', '၊', '·', '·']);
const isWide = (ch) => { const c = ch.codePointAt(0); return (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef); };

/** How good is it to cut the text after s[p-1]? 0 = not at all. */
function cutWeight(s, p) {
  const a = s[p - 1], b = s[p];
  const { open, close, term } = tables();
  if (b === undefined || a === ' ') return 0;
  if (open.has(a)) return 0;                                     // never leave an opening quote or bracket behind
  if (close.has(b) || term.has(b) || COMMA.has(b) || STRONG.has(b)) return 0; // never start a piece with a closer
  const base = STRONG.has(a) ? 5 : COMMA.has(a) ? 3 : close.has(a) ? 2 : 1;
  if (b === ' ') return base;                                    // between words
  return base > 1 && (isWide(a) || NO_SPACE_SCRIPT.test(b)) ? base : 0; // 「…」、，；in text without spaces
}

const wordSegmenters = new Map();
function wordBoundaries(s, lang) {
  try {
    const key = lang || 'und';
    if (!wordSegmenters.has(key)) wordSegmenters.set(key, typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(lang || undefined, { granularity: 'word' }) : null);
    const seg = wordSegmenters.get(key);
    return seg ? [...seg.segment(s)].map((x) => x.index) : null;
  } catch { return null; }
}

/** Never in the middle of a surrogate pair, a combining mark, a joiner or a variation selector. */
function safeCut(s, p) {
  while (p > 1 && (/[\udc00-\udfff‍︀-️]/.test(s[p]) || /\p{M}/u.test(s[p]))) p--;
  return p;
}

function bestCut(s, target, maxLen, lang) {
  const lo = Math.max(8, Math.floor(target * 0.55));
  const hi = Math.min(maxLen, Math.ceil(target * 1.45), s.length - 1);
  let best = -1, bestCost = Infinity;
  for (let p = lo; p <= hi; p++) {
    const w = cutWeight(s, p);
    if (!w) continue;
    const cost = Math.abs(p - target) - w * 6; // punctuation beats a plain word boundary, but not by much distance
    if (cost < bestCost) { bestCost = cost; best = p; }
  }
  if (best > 0) return best;
  // no punctuation and no space nearby: a word boundary from the browser's dictionary (Chinese, Japanese, Thai, …)
  const bounds = wordBoundaries(s.slice(0, hi + 16), lang);
  if (bounds) {
    const { open, close, term } = tables();
    let pick = -1;
    for (const p of bounds) {
      if (p < lo || p > hi || close.has(s[p]) || term.has(s[p]) || COMMA.has(s[p]) || open.has(s[p - 1])) continue;
      if (pick < 0 || Math.abs(p - target) < Math.abs(pick - target)) pick = p;
    }
    if (pick > 0) return pick;
  }
  return safeCut(s, Math.min(hi, Math.round(target)));
}

/**
 * Cut `s` into pieces of at most `maxLen` characters, as even as possible and at the best places available: after a
 * semicolon/colon/dash, then after a comma, then between words. (The third argument may still be a boolean `cjk`.)
 */
export function breakLong(s, maxLen, opts = {}) {
  const lang = typeof opts === 'object' && opts ? opts.lang || '' : '';
  const parts = [];
  let rest = s.trim();
  while (rest.length > maxLen) {
    const k = Math.ceil(rest.length / maxLen);
    const cut = bestCut(rest, rest.length / k, maxLen, lang);
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

// ---------------------------------------------------------------- speech units
/** How the text is written: dense scripts (Chinese, Japanese, Korean) carry more per character; some need no spaces. */
function profile(text) {
  let han = 0, hangul = 0, other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) han++;
    else if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x3130 && c <= 0x318f)) hangul++;
    else if (c >= 0xd800 && c <= 0xdbff) { han++; i++; }
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0xc0 && c < 0x2000 && c !== 0xd7 && c !== 0xf7)) other++;
  }
  const letters = han + hangul + other;
  return { dense: letters > 0 && (han + hangul) / letters > 0.3 };
}

const endsWithCloser = (s) => { const ch = s[s.length - 1]; return tables().close.has(ch) || ch === '"' || ch === "'"; };

/** A short sentence right after a quotation is almost always its tag ("她問。", "と彼は言った。", "dit-il."): keep them together. */
function glueTags(sentences, tagMax) {
  const out = [];
  for (const s of sentences) {
    const prev = out[out.length - 1];
    if (prev && s.length <= tagMax && endsWithCloser(prev) && !tables().open.has(s[0]) && !isDash(s[0])) out[out.length - 1] = joinText(prev, s);
    else out.push(s);
  }
  return out;
}

/** One paragraph → speech units. Short sentences are merged, long ones are cut at soft breaks. */
export function unitsFromParagraph(par, { lang = '' } = {}) {
  const { dense } = profile(par);
  const minLen = dense ? 28 : 70;
  const maxLen = dense ? 110 : 220;
  const sentences = glueTags(splitSentences(par, { lang }), dense ? 14 : 36)
    .flatMap((s) => (s.length > maxLen ? breakLong(s, maxLen, { lang }) : [s]));
  const units = [];
  let cur = '';
  for (const s of sentences) {
    if (!cur) cur = s;
    else if (cur.length < minLen && cur.length + 1 + s.length <= maxLen) cur = joinText(cur, s);
    else { units.push(cur); cur = s; }
  }
  if (cur) units.push(cur);
  // a few stray words are attached to the unit before them when that still fits
  const orphan = dense ? 10 : 24;
  for (let i = units.length - 1; i > 0; i--) {
    if (units[i].length < orphan && units[i - 1].length + 1 + units[i].length <= maxLen) {
      units[i - 1] = joinText(units[i - 1], units[i]);
      units.splice(i, 1);
    }
  }
  return units;
}

