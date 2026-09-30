// Entry point: detect the format of a File and turn it into {title, author, language, chapters:[{title, paras}]}.
import { getJSZip, stripExt } from './common.js';
import { hashBytes } from '../util.js';
import { t } from '../i18n.js';

export const ACCEPT = '.epub,.pdf,.txt,.text,.md,.markdown,.html,.htm,.xhtml,.docx,.odt,.fb2,.rtf,application/epub+zip,application/pdf,text/*';
// File extensions that are recognised but cannot be read, mapped to the translation key of the explanation.
const UNSUPPORTED = {
  mobi: 'err.mobi', azw: 'err.mobi', azw3: 'err.azw3', kfx: 'err.kfx', doc: 'err.doc',
  ppt: 'err.presentation', pptx: 'err.presentation', xls: 'err.spreadsheet', xlsx: 'err.spreadsheet',
  zip: 'err.zip', rar: 'err.rar', mp3: 'err.audio', m4b: 'err.audio',
};

async function sniff(buf, ext) {
  const u8 = new Uint8Array(buf, 0, Math.min(buf.byteLength, 4096));
  const ascii = new TextDecoder('latin1').decode(u8);
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (ascii.startsWith('PK')) {
    const JSZip = await getJSZip();
    const zip = await JSZip.loadAsync(buf);
    if (zip.file('META-INF/container.xml')) return 'epub';
    if (zip.file('word/document.xml')) return 'docx';
    if (zip.file('content.xml') && zip.file('mimetype')) return 'odt';
    if (ext === 'epub') return 'epub';
    throw new Error(t('err.zipUnknown'));
  }
  if (ascii.startsWith('{\\rtf')) return 'rtf';
  if (/<FictionBook/i.test(ascii) || ext === 'fb2') return 'fb2';
  if (/^\s*(<!doctype html|<html)/i.test(ascii) || ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'md';
  return 'txt';
}

const LOADERS = {
  epub: async () => (await import('./epub.js')).parseEpub,
  pdf: async () => (await import('./pdf.js')).parsePdf,
  docx: async () => (await import('./text.js')).parseDocx,
  odt: async () => (await import('./text.js')).parseOdt,
  fb2: async () => (await import('./text.js')).parseFb2,
  rtf: async () => (await import('./text.js')).parseRtf,
  html: async () => (await import('./text.js')).parseHtml,
  md: async () => (await import('./text.js')).parseMarkdown,
  txt: async () => (await import('./text.js')).parseTxt,
};

/** @returns {{parsed, hash, kind}} */
export async function parseBookFile(file, onProgress = () => {}) {
  const name = file.name || 'book';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (UNSUPPORTED[ext]) throw new Error(t(UNSUPPORTED[ext]));
  if (!file.size) throw new Error(t('err.empty'));
  onProgress(0, t('progress.readingFile'));
  const buf = await file.arrayBuffer();
  const hash = hashBytes(new Uint8Array(buf));
  const kind = await sniff(buf, ext);
  const parse = await LOADERS[kind]();
  const parsed = await parse(buf, { name, onProgress });
  if (!parsed.title) parsed.title = stripExt(name);
  return { parsed, hash, kind };
}

/** Text pasted or typed straight into the app. */
export async function parsePastedText(text, title) {
  const { paragraphsFromPlain } = await import('./text.js');
  const { chaptersFromParas } = await import('./common.js');
  const paras = paragraphsFromPlain(text);
  if (!paras.length) throw new Error(t('err.noReadable'));
  return { parsed: { title: title || paras[0].slice(0, 24), author: '', language: '', chapters: chaptersFromParas(paras) }, hash: hashBytes(new TextEncoder().encode(text)), kind: 'paste' };
}
