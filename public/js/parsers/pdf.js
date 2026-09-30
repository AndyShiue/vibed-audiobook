// PDF (text layer only): rebuilds lines and paragraphs from pdf.js text items, drops running
// headers/footers/page numbers, joins paragraphs across page breaks and finds chapters from the
// outline or from headings. Scanned PDFs without a text layer are rejected with a clear message.
import { tick, autoChapters, isChapterHeading, looksGarbled } from './common.js';
import { normalizeText } from '../util.js';
import { t } from '../i18n.js';

let pdfjsPromise;
async function getPdfjs() {
  pdfjsPromise ??= import('/vendor/pdfjs/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    return m;
  });
  return pdfjsPromise;
}

const TERMINATOR = /[。！？!?.…」』”’）)\]】》〉:：;；]$/;
const SENTENCE_END = /[。！？!?.…」』”’"'）)]$/;
const isWideChar = (ch) => !!ch && ch.charCodeAt(0) >= 0x2e80;
const median = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
const quantile = (arr, q) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

function joinLines(a, b) {
  if (!a) return b;
  const last = a[a.length - 1], first = b[0];
  if (isWideChar(last) || isWideChar(first)) return a + b;
  if (/[a-zA-Z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b; // soft hyphen at a line break
  return `${a} ${b}`;
}

/** pdf.js text items → visual lines in stream order. */
function extractLines(items) {
  const lines = [];
  let cur = null;
  const push = () => { if (cur && cur.text.trim()) lines.push(cur); cur = null; };
  for (const it of items) {
    if (!('str' in it)) continue;
    const [a, b, , , x, y] = it.transform;
    const fs = Math.hypot(a, b) || it.height || 10;
    if (!cur || Math.abs(y - cur.y) > fs * 0.5 || x < cur.endX - fs * 3) {
      push();
      cur = { text: '', x, y, fs, endX: x, started: false };
    }
    if (cur.started && it.str) {
      const gap = x - cur.endX;
      const prev = cur.text[cur.text.length - 1];
      if (gap > fs * 0.2 && !isWideChar(prev) && !isWideChar(it.str[0]) && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
    }
    cur.text += it.str;
    cur.endX = x + (it.width || 0);
    cur.fs = Math.max(cur.fs, fs);
    if (it.str) cur.started = true;
    if (it.hasEOL) push();
  }
  push();
  for (const l of lines) l.text = l.text.replace(/\s+/g, ' ').trim();
  return lines.filter((l) => l.text);
}

const PAGE_NUMBER = /^[-–—\s]*(?:第\s*)?\d{1,4}\s*(?:[頁页])?[-–—\s]*$|^\d+\s*\/\s*\d+$|^[ivxlcdm]{1,7}$/i;
const keyOf = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

export async function parsePdf(buf, { onProgress = () => {} } = {}) {
  const pdfjs = await getPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf.slice(0)),
    cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    isEvalSupported: false,
  });
  let doc;
  try { doc = await task.promise; } catch (err) {
    if (err?.name === 'PasswordException') throw new Error(t('err.pdfPassword'));
    throw new Error(t('err.pdfOpen', { msg: err?.message || err }));
  }
  const numPages = doc.numPages;

  // 1. Extract lines page by page.
  const pages = [];
  for (let p = 1; p <= numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const [x0, y0, x1, y1] = page.view;
    pages.push({ lines: extractLines(tc.items), y0, y1, h: y1 - y0 });
    page.cleanup();
    if (p % 4 === 0 || p === numPages) { onProgress((p / numPages) * 0.8, t('progress.pdfPage', { p, n: numPages })); await tick(); }
  }
  const charCount = pages.reduce((t, pg) => t + pg.lines.reduce((s, l) => s + l.text.length, 0), 0);
  if (charCount < Math.max(30, numPages * 15)) {
    throw new Error(t('err.pdfScanned'));
  }

  // 2. Remove running headers/footers and page numbers.
  const zoneKeys = new Map();
  const zoneOf = (pg, l) => (l.y > pg.y1 - 0.09 * pg.h ? 'top' : l.y < pg.y0 + 0.09 * pg.h ? 'bottom' : null);
  for (const pg of pages) {
    const seen = new Set();
    for (const l of pg.lines) if (zoneOf(pg, l)) seen.add(keyOf(l.text));
    for (const k of seen) zoneKeys.set(k, (zoneKeys.get(k) || 0) + 1);
  }
  const repeatMin = Math.max(3, Math.ceil(numPages * 0.35));
  for (const pg of pages) {
    pg.lines = pg.lines.filter((l) => {
      const z = zoneOf(pg, l);
      if (!z) return true;
      if (PAGE_NUMBER.test(l.text)) return false;
      return !(numPages >= 4 && (zoneKeys.get(keyOf(l.text)) || 0) >= repeatMin);
    });
  }

  // 3. Lines → paragraphs (joined across pages when a sentence is left open).
  const allFs = pages.flatMap((pg) => pg.lines.map((l) => l.fs));
  const bodyFs = median(allFs) || 10;
  const paras = [];
  let pending = null;
  const close = () => { if (pending) { pending.text = normalizeText(pending.text); if (pending.text) paras.push(pending); pending = null; } };
  for (let pi = 0; pi < pages.length; pi++) {
    const { lines } = pages[pi];
    if (!lines.length) continue;
    const left = quantile(lines.map((l) => l.x), 0.1);
    const maxW = quantile(lines.map((l) => l.endX - l.x), 0.9);
    const dys = [];
    for (let i = 1; i < lines.length; i++) { const dy = lines[i - 1].y - lines[i].y; if (dy > 0) dys.push(dy); }
    const leading = median(dys) || bodyFs * 1.3;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const heading = l.fs > bodyFs * 1.25 && l.text.length <= 60;
      const prev = i > 0 ? lines[i - 1] : null;
      let startNew;
      if (!pending) startNew = true;
      else if (heading || pending.heading) startNew = true;
      else if (!prev) startNew = SENTENCE_END.test(pending.text) && !!pending.closedByShortLine; // page break
      else {
        const dy = prev.y - l.y;
        const shortPrev = (prev.endX - prev.x) < 0.8 * maxW;
        const indented = l.x > left + 1.2 * l.fs;
        startNew = dy > 1.6 * leading || (SENTENCE_END.test(prev.text) && (shortPrev || indented));
      }
      if (startNew) {
        close();
        pending = { text: l.text, page: pi, heading, closedByShortLine: false };
      } else {
        pending.text = joinLines(pending.text, l.text);
      }
      // Remember whether this page ended on a short, sentence-final line (=> real paragraph end).
      if (i === lines.length - 1) pending.closedByShortLine = SENTENCE_END.test(l.text) && (l.endX - l.x) < 0.85 * maxW;
    }
  }
  close();
  if (!paras.length) throw new Error(t('err.noTextIn', { kind: 'PDF' }));

  // 4. Chapters: outline → headings → fixed-size parts.
  onProgress(0.9, t('progress.chapters'));
  let chapters = await chaptersFromOutline(doc, paras);
  if (!chapters) chapters = chaptersFromHeadings(paras);
  if (!chapters) chapters = autoChapters(paras.map((p) => p.text));

  let title = '', author = '';
  try {
    const { info } = await doc.getMetadata();
    title = normalizeText(info?.Title || '');
    author = normalizeText(info?.Author || '');
  } catch { /* metadata is optional */ }
  doc.destroy();
  const warning = looksGarbled(paras.slice(0, 300).map((p) => p.text).join(''))
    ? t('warn.pdfGarbled')
    : '';
  return { title, author, language: '', chapters, warning };
}

async function chaptersFromOutline(doc, paras) {
  let outline;
  try { outline = await doc.getOutline(); } catch { return null; }
  if (!outline?.length) return null;
  const flat = (items, depth) => items.flatMap((it) => [{ title: it.title, dest: it.dest, depth }, ...(depth < 2 && it.items?.length ? flat(it.items, depth + 1) : [])]);
  let entries = flat(outline, 1);
  if (outline.length >= 4) entries = entries.filter((e) => e.depth === 1);
  const marks = [];
  for (const e of entries) {
    try {
      let dest = e.dest;
      if (typeof dest === 'string') dest = await doc.getDestination(dest);
      if (!Array.isArray(dest)) continue;
      const ref = dest[0];
      const page = typeof ref === 'object' ? await doc.getPageIndex(ref) : ref;
      marks.push({ title: normalizeText(e.title), page });
    } catch { /* skip unresolvable entries */ }
  }
  marks.sort((a, b) => a.page - b.page);
  const uniq = marks.filter((m, i) => i === 0 || m.page !== marks[i - 1].page);
  if (uniq.length < 2) return null;
  const chapters = [];
  const firstPage = uniq[0].page;
  const before = paras.filter((p) => p.page < firstPage).map((p) => p.text);
  if (before.length && before.join('').length > 200) chapters.push({ title: '', paras: before });
  uniq.forEach((m, k) => {
    const end = k + 1 < uniq.length ? uniq[k + 1].page : Infinity;
    const body = paras.filter((p) => p.page >= m.page && p.page < end).map((p) => p.text);
    if (body.length) chapters.push({ title: m.title, paras: body });
  });
  return chapters.length >= 2 ? chapters : null;
}

function chaptersFromHeadings(paras) {
  const idx = [];
  paras.forEach((p, i) => { if ((p.heading && p.text.length <= 40 && isChapterHeading(p.text)) || isChapterHeading(p.text)) idx.push(i); });
  if (idx.length < 2) return null;
  const chapters = [];
  if (idx[0] > 0) chapters.push({ title: '', paras: paras.slice(0, idx[0]).map((p) => p.text) });
  idx.forEach((start, k) => {
    const end = k + 1 < idx.length ? idx[k + 1] : paras.length;
    const body = paras.slice(start + 1, end).map((p) => p.text);
    chapters.push({ title: paras[start].text, paras: body.length ? body : [paras[start].text] });
  });
  return chapters;
}
