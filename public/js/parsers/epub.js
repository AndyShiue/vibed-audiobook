// EPUB 2/3: container.xml → OPF (metadata, manifest, spine) → one chapter per spine document.
import { getJSZip, parseXml, parseMarkup, htmlToBlocks, tick } from './common.js';
import { normalizeText } from '../util.js';
import { t } from '../i18n.js';

const ns = (doc, name) => Array.from(doc.getElementsByTagNameNS('*', name));
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

function resolvePath(baseDir, href) {
  const clean = href.split('#')[0].split('?')[0];
  const url = new URL(clean, `http://x/${baseDir}`);
  let p = url.pathname.slice(1);
  try { p = decodeURIComponent(p); } catch { /* keep as is */ }
  return p;
}

const FONT_OBFUSCATION = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];

export async function parseEpub(buf, { onProgress = () => {} } = {}) {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(buf);
  const readText = async (path) => {
    const f = zip.file(path) || zip.file(decodeURI(path));
    if (!f) return null;
    return f.async('string');
  };

  const enc = await readText('META-INF/encryption.xml');
  if (enc) {
    const algos = ns(parseXml(enc), 'EncryptionMethod').map((e) => e.getAttribute('Algorithm'));
    if (algos.some((a) => a && !FONT_OBFUSCATION.includes(a))) throw new Error(t('err.drm'));
  }

  const container = await readText('META-INF/container.xml');
  if (!container) throw new Error(t('err.epubContainer'));
  const opfPath = ns(parseXml(container), 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error(t('err.epubOpf'));
  const opfText = await readText(opfPath);
  if (!opfText) throw new Error(t('err.epubOpf'));
  const opf = parseXml(opfText);
  const opfDir = dirOf(opfPath);

  const meta = (name) => normalizeText(ns(opf, name)[0]?.textContent || '');
  const manifest = new Map();
  for (const it of ns(opf, 'item')) {
    manifest.set(it.getAttribute('id'), { href: it.getAttribute('href'), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' });
  }
  const spineEl = ns(opf, 'spine')[0];
  const spine = ns(opf, 'itemref').map((r) => ({ id: r.getAttribute('idref'), linear: r.getAttribute('linear') !== 'no' }));

  // Table of contents → titles per document.
  const titles = new Map();
  try {
    const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
    if (navItem) {
      const navPath = resolvePath(opfDir, navItem.href);
      const navDoc = parseMarkup(await readText(navPath) || '');
      const navs = Array.from(navDoc.getElementsByTagName('nav'));
      const toc = navs.find((n) => /toc/.test(n.getAttribute('epub:type') || '')) || navs[0];
      const navDir = dirOf(navPath);
      for (const a of toc ? Array.from(toc.getElementsByTagName('a')) : []) {
        const href = a.getAttribute('href');
        if (href) titles.set(resolvePath(navDir, href), titles.get(resolvePath(navDir, href)) || normalizeText(a.textContent));
      }
    } else {
      const ncxId = spineEl?.getAttribute('toc');
      const ncxItem = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
      if (ncxItem) {
        const ncxPath = resolvePath(opfDir, ncxItem.href);
        const ncx = parseXml(await readText(ncxPath) || '<x/>');
        for (const np of ns(ncx, 'navPoint')) {
          const label = ns(np, 'text')[0]?.textContent;
          const src = ns(np, 'content')[0]?.getAttribute('src');
          if (label && src) {
            const key = resolvePath(dirOf(ncxPath), src);
            if (!titles.has(key)) titles.set(key, normalizeText(label));
          }
        }
      }
    }
  } catch { /* the TOC is a nicety; chapters still work without it */ }

  const chapters = [];
  const docs = spine.filter((s) => s.linear).map((s) => manifest.get(s.id)).filter((m) => m && /x?html|xml/.test(m.type) && !/\bnav\b/.test(m.props));
  for (let i = 0; i < docs.length; i++) {
    const path = resolvePath(opfDir, docs[i].href);
    const raw = await readText(path);
    if (raw == null) continue;
    const doc = parseMarkup(raw);
    const body = doc.getElementsByTagName('body')[0] || doc.documentElement;
    let blocks = htmlToBlocks(body);
    if (!blocks.length) continue;

    let title = titles.get(path) || '';
    const first = blocks[0];
    if (/^H[1-3]$/.test(first.tag) && first.text.length <= 100) {
      if (!title) { title = first.text; blocks = blocks.slice(1); }
      else if (first.text.includes(title) || title.includes(first.text)) { title = first.text.length >= title.length ? first.text : title; blocks = blocks.slice(1); }
    }
    const total = blocks.reduce((t, b) => t + b.text.length, 0);
    if (total < 12 && !title) continue;
    chapters.push({ title, paras: blocks.map((b) => b.text) });
    if (i % 4 === 0) { onProgress((i + 1) / docs.length, t('progress.chapter', { i: i + 1, n: docs.length })); await tick(); }
  }
  if (!chapters.length) throw new Error(t('err.noTextIn', { kind: 'EPUB' }));
  return { title: meta('title'), author: meta('creator'), language: meta('language'), chapters };
}
