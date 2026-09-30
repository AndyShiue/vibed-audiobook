// Turns paragraphs into "speech units" — sentence-sized pieces that are spoken one at a time.
// The unit index is the app's reading position, so the result must be deterministic.
import { cjkRatio, isCJKCode } from './util.js';

const HARD_END = new Set(['。', '！', '？', '!', '?', '…', '⋯', '︕', '︖', '‼', '⁇', '⁈', '⁉']);
const CLOSERS = new Set(['」', '』', '”', '’', '）', ')', ']', '】', '》', '〉', '"', "'", '〕', '﹂', '﹄', '›', '»']);
const SOFT_CJK = new Set(['，', '、', '；', '：', '—', '―', '─']);
const SOFT_LATIN = new Set([',', ';', ':', '—', '–']);
const ABBR = /(?:^|[\s(“"'])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|no|fig|inc|ltd|co|mt|gen|col|sgt|lt|capt|rev|hon|e\.g|i\.e|cf|approx|dept|est|vol|pp|al|u\.s|a\.m|p\.m)$/i;

const isSpace = (ch) => ch === ' ' || ch === '\n' || ch === '\t' || ch === ' ' || ch === '\r';

function latinPeriodEnds(text, i) {
  const next = text[i + 1];
  if (next !== undefined && !isSpace(next) && !CLOSERS.has(next)) return false; // 3.14, a.b, "...x"
  let j = i + 1;
  while (j < text.length && CLOSERS.has(text[j])) j++;
  let k = j;
  while (k < text.length && isSpace(text[k])) k++;
  if (k >= text.length) return true;
  if (/[a-z]/.test(text[k])) return false; // "etc. and" — sentence continues
  const before = text.slice(Math.max(0, i - 14), i);
  if (ABBR.test(before)) return false;
  if (/(?:^|[\s(“"'])[A-Z]$/.test(before)) return false; // initials: "J. K. Rowling"
  return true;
}

/** Split a paragraph into sentences (terminators stay attached; closing quotes stay with their sentence). */
export function splitSentences(text) {
  const out = [];
  let buf = '';
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    buf += ch;
    let end = false;
    if (HARD_END.has(ch)) {
      end = true;
      if (ch === '!' || ch === '?') {
        const nx = text[i + 1];
        if (nx !== undefined && !isSpace(nx) && !CLOSERS.has(nx) && !HARD_END.has(nx) && !isCJKCode(nx.codePointAt(0))) end = false; // "a.com/?x=1"
      }
    } else if (ch === '.') {
      end = latinPeriodEnds(text, i);
    }
    if (end) {
      while (i + 1 < n && (HARD_END.has(text[i + 1]) || CLOSERS.has(text[i + 1]))) buf += text[++i];
      out.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function breakLong(s, maxLen, cjk) {
  const parts = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = -1;
    for (let i = Math.min(maxLen, rest.length - 1); i > maxLen * 0.4; i--) {
      const c = rest[i];
      if (cjk ? SOFT_CJK.has(c) || SOFT_LATIN.has(c) : SOFT_LATIN.has(c) && isSpace(rest[i + 1] ?? ' ')) { cut = i + 1; break; }
    }
    if (cut < 0 && !cjk) {
      const sp = rest.lastIndexOf(' ', maxLen);
      if (sp > maxLen * 0.4) cut = sp + 1;
    }
    if (cut < 0) cut = maxLen;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--; // don't split a surrogate pair
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts.filter(Boolean);
}

function joinPieces(a, b) {
  return a.charCodeAt(a.length - 1) >= 0x2e80 || b.charCodeAt(0) >= 0x2e80 ? a + b : `${a} ${b}`;
}

/** One paragraph → speech units. Short sentences are merged, long ones are cut at soft breaks. */
export function unitsFromParagraph(par) {
  const cjk = cjkRatio(par) > 0.3;
  const minLen = cjk ? 28 : 70;
  const maxLen = cjk ? 110 : 220;
  const sentences = splitSentences(par).flatMap((s) => (s.length > maxLen ? breakLong(s, maxLen, cjk) : [s]));
  const units = [];
  let cur = '';
  for (const s of sentences) {
    if (!cur) cur = s;
    else if (cur.length < minLen && cur.length + 1 + s.length <= maxLen) cur = joinPieces(cur, s);
    else { units.push(cur); cur = s; }
  }
  if (cur) units.push(cur);
  return units;
}
