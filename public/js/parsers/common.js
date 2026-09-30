// Shared helpers for the file-format parsers.
import { normalizeText } from '../util.js';
import { t } from '../i18n.js';

const scripts = new Map();
export function loadScript(url) {
  if (!scripts.has(url)) {
    scripts.set(url, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = resolve;
      s.onerror = () => { scripts.delete(url); reject(new Error(t('err.loadComponent', { url }))); };
      document.head.appendChild(s);
    }));
  }
  return scripts.get(url);
}

export async function getJSZip() {
  if (!window.JSZip) await loadScript('/vendor/jszip.min.js');
  return window.JSZip;
}

export const tick = () => new Promise((r) => setTimeout(r, 0));

export function parseXml(str) {
  const doc = new DOMParser().parseFromString(str, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(t('err.xml'));
  return doc;
}

export function parseMarkup(str) {
  let doc = new DOMParser().parseFromString(str, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(str, 'text/html');
  return doc;
}

// ------------------------------------------------------------------ HTML → blocks
const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TR', 'DD', 'DT', 'FIGCAPTION', 'CAPTION',
  'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'ASIDE', 'HEADER', 'FOOTER', 'FIGURE', 'BODY', 'HTML', 'MAIN', 'DL', 'HR', 'FORM', 'ADDRESS']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'RT', 'RP', 'SVG', 'IMG', 'NAV', 'HEAD', 'TITLE', 'BUTTON', 'IFRAME', 'CANVAS', 'AUDIO', 'VIDEO',
  'SELECT', 'TEXTAREA', 'TEMPLATE', 'MATH', 'OBJECT', 'META', 'LINK']);

/** Walk a DOM subtree and return reading-order text blocks: [{text, tag}] (tag = nearest block element, upper-case). */
export function htmlToBlocks(root) {
  const blocks = [];
  let buf = '';
  const flush = (tag) => {
    const text = normalizeText(buf);
    buf = '';
    if (text) blocks.push({ text, tag });
  };
  const walk = (node, cur) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { buf += child.nodeValue; continue; }
      if (child.nodeType !== 1) continue;
      const name = child.nodeName.toUpperCase();
      if (SKIP.has(name)) continue;
      const etype = (child.getAttribute && (child.getAttribute('epub:type') || child.getAttribute('role'))) || '';
      if (/noteref|footnote|doc-noteref|doc-footnote|pagebreak|doc-pagebreak/.test(etype)) continue;
      if (name === 'SUP' && /^\s*[[(]?\s*[\d*†‡]+\s*[\])]?\s*$/.test(child.textContent)) continue;
      if (name === 'BR') { flush(cur); continue; }
      if (name === 'TD' || name === 'TH') { buf += ' '; walk(child, cur); continue; }
      if (BLOCK.has(name)) {
        flush(cur);
        walk(child, name);
        flush(name);
      } else {
        walk(child, cur);
      }
    }
  };
  walk(root, 'BODY');
  flush('BODY');
  return blocks;
}

// ------------------------------------------------------------------ chapters
export const CHAPTER_RE = new RegExp(
  '^\\s*(?:' +
  '第\\s*[零〇一二三四五六七八九十百千萬万两0-9０-９]+\\s*[章回節节卷部篇集幕話话]' + '.{0,40}' + '|' +
  '(?:序|前|後|后|自)\\s*言|序章|序幕|序曲|楔子|引子|終章|终章|尾聲|尾声|後記|后记|後序|番外.{0,30}|' +
  '(?:chapter|part|book|section|prologue|epilogue|preface|foreword|afterword|introduction|appendix)\\s*[\\dIVXLCDMivxlcdm]*[\\s:.\\-—]?.{0,60}' +
  ')\\s*$', 'i');

export const isChapterHeading = (text) => text.length <= 64 && CHAPTER_RE.test(text);

/** Group paragraphs into chunks of roughly `target` characters (for books with no usable structure). */
export function autoChapters(paras, target = 14000, label = (n) => t('part.n', { n })) {
  const total = paras.reduce((t, p) => t + p.length, 0);
  if (total < target * 1.4) return [{ title: '', paras }];
  const out = [];
  let cur = [], size = 0;
  for (const p of paras) {
    cur.push(p); size += p.length;
    if (size >= target) { out.push({ title: label(out.length + 1), paras: cur }); cur = []; size = 0; }
  }
  if (cur.length) {
    if (out.length && size < target * 0.3) out[out.length - 1].paras.push(...cur);
    else out.push({ title: label(out.length + 1), paras: cur });
  }
  return out;
}

/** Split a flat paragraph list into chapters at chapter-looking headings; falls back to fixed-size parts. */
export function chaptersFromParas(paras) {
  const idx = [];
  paras.forEach((p, i) => { if (isChapterHeading(p)) idx.push(i); });
  if (idx.length < 2) return autoChapters(paras);
  const chapters = [];
  if (idx[0] > 0) chapters.push({ title: '', paras: paras.slice(0, idx[0]) });
  idx.forEach((start, k) => {
    const end = k + 1 < idx.length ? idx[k + 1] : paras.length;
    const body = paras.slice(start + 1, end);
    chapters.push({ title: paras[start], paras: body.length ? body : [paras[start]] });
  });
  return chapters;
}

/** Split HTML-ish blocks into chapters at headings of the given levels (falls back to text-pattern splitting). */
export function chaptersFromBlocks(blocks, levels = ['H1', 'H2']) {
  for (const tags of [[levels[0]], levels]) {
    const idx = [];
    blocks.forEach((b, i) => { if (tags.includes(b.tag) && b.text.length <= 120) idx.push(i); });
    if (idx.length >= 2) {
      const chapters = [];
      if (idx[0] > 0 && blocks.slice(0, idx[0]).some((b) => b.text.length > 20)) chapters.push({ title: '', paras: blocks.slice(0, idx[0]).map((b) => b.text) });
      idx.forEach((start, k) => {
        const end = k + 1 < idx.length ? idx[k + 1] : blocks.length;
        const body = blocks.slice(start + 1, end).map((b) => b.text);
        if (body.length) chapters.push({ title: blocks[start].text, paras: body });
      });
      if (chapters.length) return chapters;
    }
  }
  return chaptersFromParas(blocks.map((b) => b.text));
}

// ------------------------------------------------------------------ text decoding
const COMMON = new Set(Array.from('的一是不了人我在有他這这中大來来上國国個个到說说們们為为子和你地出道也時时年得就那要下以生會会自著着去之過过家學学對对可她裡里後后小麼么心多天而能好都然沒没日於于起還还發发成事只作當当想看文無无開开手十用主行方又如前所本見见經经頭头面公同三已老從从動动兩两長长知民樣样現现分將将外但身些與与高意進进把法此實实回二理美點点月明其種种聲声全工己話话兒儿者向情部正名定女問问力機机給给等幾几很業业最間间新什麽樂乐'));
const KANA = /[぀-ヿ]/;
const HANGUL = /[가-힯]/;
const CJK = /[㐀-鿿]/;

function scoreDecoded(text) {
  const s = text.length > 20000 ? text.slice(0, 20000) : text;
  let common = 0, other = 0, kana = 0, hangul = 0, ascii = 0, bad = 0;
  for (const ch of s) {
    if (COMMON.has(ch)) common++;
    else if (CJK.test(ch)) other++;
    else if (KANA.test(ch)) kana++;
    else if (HANGUL.test(ch)) hangul++;
    else if (ch === '�') bad++;
    else if (/[\u0000-\u007f]/.test(ch)) ascii++;
  }
  const n = Math.max(1, [...s].length);
  return (common + 0.25 * other + 0.6 * kana + 0.6 * hangul + 0.6 * ascii) / n - 4 * bad / n;
}

/** Decode bytes to text: BOMs, then UTF-8, then the best-scoring legacy encoding (Big5, GBK, Shift-JIS, EUC-KR, Latin-1). */
export function decodeText(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { /* not UTF-8 */ }
  let best = null;
  for (const enc of ['big5', 'gb18030', 'shift_jis', 'euc-kr', 'windows-1252']) {
    try {
      const text = new TextDecoder(enc).decode(u8);
      const score = scoreDecoded(text);
      if (!best || score > best.score) best = { text, score, enc };
    } catch { /* encoding unsupported in this browser */ }
  }
  return best ? best.text : new TextDecoder('utf-8').decode(u8);
}

/**
 * Detects mojibake in extracted CJK text: real Chinese/Japanese text is dominated by a few hundred very
 * common characters, garbled text (e.g. wrongly mapped PDF fonts) is not.
 */
export function looksGarbled(text) {
  let cjk = 0, common = 0;
  for (const ch of text.length > 30000 ? text.slice(0, 30000) : text) {
    if (COMMON.has(ch)) { common++; cjk++; } else if (CJK.test(ch) || KANA.test(ch)) cjk++;
  }
  return cjk > 300 && common / cjk < 0.12;
}

export const stripExt = (name) => String(name || '').replace(/\.[^./\\]+$/, '');
