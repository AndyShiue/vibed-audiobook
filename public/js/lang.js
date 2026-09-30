// Language helpers: BCP-47 normalisation, script-based detection, Traditional vs Simplified Chinese.
import { cjkRatio } from './util.js';

const DEFAULT_REGION = {
  en: 'en-US', fr: 'fr-FR', de: 'de-DE', es: 'es-ES', it: 'it-IT', pt: 'pt-BR', ru: 'ru-RU', nl: 'nl-NL',
  pl: 'pl-PL', tr: 'tr-TR', sv: 'sv-SE', ja: 'ja-JP', ko: 'ko-KR', ar: 'ar-SA', hi: 'hi-IN', th: 'th-TH', vi: 'vi-VN', id: 'id-ID',
};

const TRAD = '這們說對個時來從長見問過還發動將麼點開東車書學國會經實現電氣頭無與為產業務兩應關體機馬鳥龍愛讓後裡間點總樣邊條';
const SIMP = '这们说对个时来从长见问过还发动将么点开东车书学国会经实现电气头无与为产业务两应关体机马鸟龙爱让后里间点总样边条';

/** Count characters that only exist in one script (positions differ between the two strings). */
export function chineseVariant(text, tagHint = '') {
  const trad = new Set(), simp = new Set();
  for (let i = 0; i < TRAD.length; i++) if (TRAD[i] !== SIMP[i]) { trad.add(TRAD[i]); simp.add(SIMP[i]); }
  let t = 0, s = 0;
  const sample = text.length > 40000 ? text.slice(0, 40000) : text;
  for (const ch of sample) { if (trad.has(ch)) t++; else if (simp.has(ch)) s++; }
  if (t + s >= 2) return t >= s * 1.5 ? 'zh-TW' : s >= t * 1.5 ? 'zh-CN' : chineseFromTag(tagHint);
  return chineseFromTag(tagHint);
}

function chineseFromTag(tag) {
  const t = String(tag || '').toLowerCase().replace('_', '-');
  if (t.startsWith('zh-tw') || t.startsWith('zh-hk') || t.startsWith('zh-mo') || t.startsWith('zh-hant')) return 'zh-TW';
  return t.startsWith('zh') ? 'zh-CN' : 'zh-TW';
}

export function normalizeTag(tag) {
  if (!tag) return '';
  const parts = String(tag).replace('_', '-').split('-');
  const lang = parts[0].toLowerCase();
  if (lang === 'zh') return chineseFromTag(tag);
  const region = parts.find((p, i) => i > 0 && /^[A-Za-z]{2}$/.test(p));
  return region ? `${lang}-${region.toUpperCase()}` : (DEFAULT_REGION[lang] || lang);
}

/** Decide the spoken language of a piece of text from its scripts; `fallback` for pure Latin/unknown. */
export function detectLangFromText(text, fallback = 'en-US') {
  const sample = text.length > 4000 ? text.slice(0, 4000) : text;
  let kana = 0, hangul = 0, han = 0, latin = 0, cyr = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0);
    if (c >= 0x3040 && c <= 0x30ff) kana++;
    else if (c >= 0xac00 && c <= 0xd7af) hangul++;
    else if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) han++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0xc0 && c <= 0x24f)) latin++;
    else if (c >= 0x400 && c <= 0x4ff) cyr++;
  }
  const letters = kana + hangul + han + latin + cyr;
  if (!letters) return fallback;
  if (kana / letters > 0.03 && kana + han > latin) return 'ja-JP';
  if (hangul / letters > 0.2) return 'ko-KR';
  if (han / letters > 0.3) return chineseVariant(sample, fallback);
  if (cyr / letters > 0.5) return 'ru-RU';
  return /^(zh|ja|ko|ru)/i.test(fallback) ? 'en-US' : fallback;
}

/**
 * Language a (possibly mixed) sentence is *spoken* in. Character counts mislead here: English words are long, so
 * "這句話 The quick brown fox jumps over the lazy dog 是什麼意思" has more Latin than Chinese letters, yet it is a
 * Chinese sentence that quotes English — and an English voice cannot read the Chinese part at all. So a modest
 * amount of CJK text decides the sentence's language; only text with (almost) none is treated as Latin-script.
 */
export function detectSpokenLang(text, fallback = 'en-US') {
  let han = 0, kana = 0, hangul = 0, letters = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 0x3040 && c <= 0x30ff) { kana++; letters++; }
    else if (c >= 0xac00 && c <= 0xd7af) { hangul++; letters++; }
    else if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) { han++; letters++; }
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0xc0 && c <= 0x24f) || (c >= 0x400 && c <= 0x4ff)) letters++;
  }
  if (kana >= 2) return 'ja-JP';
  if (hangul >= 3 && hangul / letters >= 0.08) return 'ko-KR';
  if (han >= 3 && han / letters >= 0.08) return chineseVariant(text, fallback);
  return detectLangFromText(text, fallback);
}

/** Book language: script of the text wins; the declared metadata language refines Latin-script books. */
export function resolveBookLang(metaLang, sampleText) {
  const declared = normalizeTag(metaLang);
  return detectLangFromText(sampleText, declared || 'en-US');
}

export const isCJKLang = (tag) => /^(zh|ja|ko)/i.test(tag || '');
export { cjkRatio };
