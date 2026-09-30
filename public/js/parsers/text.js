// Plain-text family: .txt, .md, .rtf, .html — plus DOCX/ODT/FB2 (structured XML formats).
import {
  decodeText, chaptersFromParas, chaptersFromBlocks, htmlToBlocks, parseMarkup, parseXml, getJSZip, loadScript, stripExt,
} from './common.js';
import { normalizeText } from '../util.js';
import { t } from '../i18n.js';

/** Plain text → paragraphs. Handles hard-wrapped text (blank-line paragraphs) and one-line-per-paragraph text. */
export function paragraphsFromPlain(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/g, ''));
  const nonBlank = lines.filter((l) => l.trim()).length;
  const blank = lines.length - nonBlank;
  const out = [];
  if (nonBlank && blank / lines.length >= 0.04) {
    let cur = [];
    const flush = () => { if (cur.length) { out.push(joinWrapped(cur)); cur = []; } };
    for (const l of lines) { if (l.trim()) cur.push(l.trim()); else flush(); }
    flush();
  } else {
    for (const l of lines) if (l.trim()) out.push(l.trim());
  }
  return out.map(normalizeText).filter(Boolean);
}

function joinWrapped(lines) {
  let s = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const a = s[s.length - 1], b = lines[i][0];
    if (a.charCodeAt(0) >= 0x2e80 || b.charCodeAt(0) >= 0x2e80) s += lines[i];
    else if (/[a-zA-Z]-$/.test(s) && /^[a-z]/.test(lines[i])) s = s.slice(0, -1) + lines[i];
    else s += ' ' + lines[i];
  }
  return s;
}

export async function parseTxt(buf, { name = '' } = {}) {
  const text = decodeText(buf);
  const paras = paragraphsFromPlain(text);
  return { title: stripExt(name), author: '', language: '', chapters: chaptersFromParas(paras) };
}

export async function parseMarkdown(buf, { name = '' } = {}) {
  let text = decodeText(buf).replace(/\r\n?/g, '\n');
  text = text.replace(/^---\n[\s\S]*?\n---\n/, ''); // front matter
  text = text.replace(/```[\s\S]*?```/g, '\n').replace(/~~~[\s\S]*?~~~/g, '\n');
  const blocks = [];
  let buf2 = [];
  const flush = () => { if (buf2.length) { blocks.push({ text: normalizeText(buf2.join(' ')), tag: 'P' }); buf2 = []; } };
  for (let line of text.split('\n')) {
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flush(); blocks.push({ text: cleanInline(h[2]), tag: `H${h[1].length}` }); continue; }
    if (/^\s*([-*_]\s*){3,}$/.test(line)) { flush(); continue; }
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue; // table separator
    if (!line.trim()) { flush(); continue; }
    line = line.replace(/^\s*>+\s?/, '').replace(/^\s*([-*+]|\d+[.)])\s+/, '').replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\s*\|\s*/g, ' ');
    buf2.push(cleanInline(line));
  }
  flush();
  const clean = blocks.filter((b) => b.text);
  const title = clean.find((b) => b.tag === 'H1')?.text || stripExt(name);
  return { title, author: '', language: '', chapters: chaptersFromBlocks(clean, ['H1', 'H2']) };
}

function cleanInline(s) {
  return s
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1');
}

export async function parseHtml(buf, { name = '' } = {}) {
  const doc = parseMarkup(decodeText(buf));
  const body = doc.getElementsByTagName('body')[0] || doc.documentElement;
  const blocks = htmlToBlocks(body);
  const title = normalizeText(doc.getElementsByTagName('title')[0]?.textContent || '') || blocks.find((b) => b.tag === 'H1')?.text || stripExt(name);
  if (!blocks.length) throw new Error(t('err.noTextIn', { kind: 'HTML' }));
  return { title, author: '', language: doc.documentElement.getAttribute('lang') || '', chapters: chaptersFromBlocks(blocks, ['H1', 'H2']) };
}

/** Very small RTF reader: control words, \uN unicode escapes, \'hh (Latin-1) escapes, skips destinations. */
export async function parseRtf(buf, { name = '' } = {}) {
  const src = new TextDecoder('latin1').decode(new Uint8Array(buf));
  let out = '';
  const stack = [];
  let skip = 0; // depth at which a skipped destination started
  let uc = 1;   // bytes to skip after \uN
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { stack.push({ skip, uc }); if (src[i + 1] === '\\' && src[i + 2] === '*') skip = skip || stack.length; }
    else if (c === '}') { const st = stack.pop(); if (st) { if (skip === stack.length + 1) skip = 0; else skip = st.skip; uc = st.uc; } }
    else if (c === '\\') {
      const n = src[i + 1];
      if (n === '\\' || n === '{' || n === '}') { if (!skip) out += n; i++; }
      else if (n === "'") { if (!skip) out += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)); i += 3; }
      else if (n === '~') { if (!skip) out += ' '; i++; }
      else {
        const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i, i + 40));
        if (!m) continue;
        const [whole, word, arg] = m;
        i += whole.length - 1;
        if (['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'footnote', 'themedata', 'datastore'].includes(word)) skip = skip || stack.length + 1;
        else if (word === 'par' || word === 'line' || word === 'sect' || word === 'page') { if (!skip) out += '\n'; }
        else if (word === 'tab') { if (!skip) out += ' '; }
        else if (word === 'uc') uc = Number(arg) || 0;
        else if (word === 'u') {
          let code = Number(arg); if (code < 0) code += 65536;
          if (!skip) out += String.fromCharCode(code);
          let k = uc; while (k-- > 0 && i + 1 < src.length) { if (src[i + 1] === '\\' && src[i + 2] === "'") i += 4; else i++; }
        }
      }
    } else if (!skip && c !== '\r' && c !== '\n') out += c;
  }
  const paras = paragraphsFromPlain(out.replace(/\n/g, '\n\n'));
  if (!paras.length) throw new Error(t('err.noTextIn', { kind: 'RTF' }));
  return { title: stripExt(name), author: '', language: '', chapters: chaptersFromParas(paras) };
}

export async function parseDocx(buf, { name = '' } = {}) {
  await loadScript('/vendor/mammoth.browser.min.js');
  const result = await window.mammoth.convertToHtml({ arrayBuffer: buf }, {
    styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"],
  });
  const doc = new DOMParser().parseFromString(`<body>${result.value}</body>`, 'text/html');
  const blocks = htmlToBlocks(doc.body);
  if (!blocks.length) throw new Error(t('err.noTextIn', { kind: 'Word' }));
  const title = blocks.find((b) => b.tag === 'H1')?.text || stripExt(name);
  return { title, author: '', language: '', chapters: chaptersFromBlocks(blocks, ['H1', 'H2']) };
}

export async function parseOdt(buf, { name = '' } = {}) {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(buf);
  const content = await zip.file('content.xml')?.async('string');
  if (!content) throw new Error(t('err.invalidFile', { kind: 'ODT' }));
  const doc = parseXml(content);
  const blocks = [];
  let cur = '';
  const flush = (tag) => { const t = normalizeText(cur); cur = ''; if (t) blocks.push({ text: t, tag }); };
  const walk = (node) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) { cur += ch.nodeValue; continue; }
      if (ch.nodeType !== 1) continue;
      const ln = ch.localName;
      if (ln === 'h') { flush('P'); walk(ch); flush(`H${Math.min(6, Number(ch.getAttribute('text:outline-level')) || 1)}`); }
      else if (ln === 'p') { flush('P'); walk(ch); flush('P'); }
      else if (ln === 's') cur += ' '.repeat(Number(ch.getAttribute('text:c')) || 1);
      else if (ln === 'tab') cur += ' ';
      else if (ln === 'line-break') flush('P');
      else if (ln === 'note' || ln === 'annotation' || ln === 'tracked-changes') continue;
      else walk(ch);
    }
  };
  walk(doc.documentElement);
  flush('P');
  if (!blocks.length) throw new Error(t('err.noTextIn', { kind: 'ODT' }));
  let title = stripExt(name), author = '', language = '';
  try {
    const meta = parseXml(await zip.file('meta.xml').async('string'));
    const get = (n) => normalizeText(meta.getElementsByTagNameNS('*', n)[0]?.textContent || '');
    title = get('title') || title; author = get('creator') || get('initial-creator'); language = get('language');
  } catch { /* metadata optional */ }
  return { title, author, language, chapters: chaptersFromBlocks(blocks, ['H1', 'H2']) };
}

export async function parseFb2(buf, { name = '' } = {}) {
  const doc = parseXml(decodeText(buf));
  const t = (el) => normalizeText(el?.textContent || '');
  const first = (root, n) => Array.from(root.getElementsByTagNameNS('*', n))[0];
  const info = first(doc, 'title-info');
  const title = t(first(info || doc, 'book-title')) || stripExt(name);
  const au = info && first(info, 'author');
  const author = au ? normalizeText(['first-name', 'middle-name', 'last-name'].map((n) => t(first(au, n))).filter(Boolean).join(' ')) : '';
  const language = t(first(info || doc, 'lang'));
  const chapters = [];
  const visit = (section, inherited) => {
    const titleEl = Array.from(section.children).find((c) => c.localName === 'title');
    const secTitle = titleEl ? normalizeText(Array.from(titleEl.children).map((p) => p.textContent).join(' ')) : inherited;
    const paras = [];
    for (const c of section.children) {
      if (c.localName === 'p' || c.localName === 'v' || c.localName === 'subtitle') paras.push(normalizeText(c.textContent));
      else if (c.localName === 'epigraph' || c.localName === 'cite' || c.localName === 'poem') paras.push(...Array.from(c.getElementsByTagNameNS('*', 'p')).concat(Array.from(c.getElementsByTagNameNS('*', 'v'))).map((p) => normalizeText(p.textContent)));
    }
    const kids = Array.from(section.children).filter((c) => c.localName === 'section');
    if (paras.filter(Boolean).length) chapters.push({ title: secTitle, paras: paras.filter(Boolean) });
    for (const k of kids) visit(k, secTitle);
  };
  for (const body of Array.from(doc.getElementsByTagNameNS('*', 'body'))) {
    if (body.getAttribute('name')) continue; // notes / comments
    const sections = Array.from(body.children).filter((c) => c.localName === 'section');
    if (sections.length) sections.forEach((s) => visit(s, ''));
    else visit(body, '');
  }
  if (!chapters.length) throw new Error(t('err.noTextIn', { kind: 'FB2' }));
  return { title, author, language, chapters };
}
