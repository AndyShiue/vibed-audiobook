// Which voice reads which words.
//
// A phone's voice is made for ONE language: an English voice skips Chinese characters altogether, and a Chinese voice
// reads an English phrase badly. Text that mixes languages — a Chinese book quoting "Pride and Prejudice", an English
// book with a Japanese word — therefore sounds wrong whichever single voice is used. So a unit is cut into runs by
// writing system, every run gets the language of its script, and each run is spoken by the best voice the phone has
// for that language. Nothing here depends on a model or on particular languages: it works for every script Unicode
// knows, and a language without a voice on the phone simply stays with the main voice.
//
// How much to switch is a setting (Settings → Mixed languages):
//   • "words" (the default): every foreign word gets the voice of its language — "deadline", "iPhone" and "Python" in a Chinese
//     answer are read by an English voice, which is what a listener expects to hear;
//   • "phrases": only phrases switch ("Apple Store", "Pride and Prejudice"); a single word stays with the main voice, which
//     has fewer audible seams — for a phone whose voices pause noticeably between utterances;
//   • "off": a unit is never split.
// In every mode a script the main voice cannot read at all (Chinese inside English, Cyrillic inside Chinese…) switches.
// A unit that would need too many switches falls back to fewer (words → phrases → only the other scripts → one voice).
import { chineseVariant } from './lang.js';

export const MIXED_MODES = ['words', 'phrases', 'off'];
export const DEFAULT_MIXED_MODE = 'words';

const MAX_PARTS = 8;          // a unit this chopped up sounds worse than one voice: fall back to fewer switches
const WIDE = 2.5;             // one Chinese/Japanese/Korean character carries about this many Latin letters of speech
const PHRASE_WORDS = 2;       // a foreign Latin run counts as a phrase from this many words…
const PHRASE_LETTERS = 12;    // …or this many letters
const MAIN_SHARE = 0.5;       // the book's own script stays the main one while it has at least this share of the biggest script

// ---------------------------------------------------------------- scripts
const OTHER_SCRIPTS = [
  ['latin', /\p{Script=Latin}/u], ['cyrillic', /\p{Script=Cyrillic}/u], ['greek', /\p{Script=Greek}/u], ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u], ['devanagari', /\p{Script=Devanagari}/u], ['bengali', /\p{Script=Bengali}/u], ['tamil', /\p{Script=Tamil}/u],
  ['telugu', /\p{Script=Telugu}/u], ['kannada', /\p{Script=Kannada}/u], ['malayalam', /\p{Script=Malayalam}/u], ['gujarati', /\p{Script=Gujarati}/u],
  ['gurmukhi', /\p{Script=Gurmukhi}/u], ['sinhala', /\p{Script=Sinhala}/u], ['thai', /\p{Script=Thai}/u], ['lao', /\p{Script=Lao}/u],
  ['khmer', /\p{Script=Khmer}/u], ['myanmar', /\p{Script=Myanmar}/u], ['georgian', /\p{Script=Georgian}/u], ['armenian', /\p{Script=Armenian}/u],
  ['ethiopic', /\p{Script=Ethiopic}/u],
];

/** The language a script is spoken in when nothing else says otherwise. */
const SCRIPT_LANG = {
  cyrillic: 'ru-RU', greek: 'el-GR', arabic: 'ar-SA', hebrew: 'he-IL', devanagari: 'hi-IN', bengali: 'bn-BD', tamil: 'ta-IN', telugu: 'te-IN',
  kannada: 'kn-IN', malayalam: 'ml-IN', gujarati: 'gu-IN', gurmukhi: 'pa-IN', sinhala: 'si-LK', thai: 'th-TH', lao: 'lo-LA', khmer: 'km-KH',
  myanmar: 'my-MM', georgian: 'ka-GE', armenian: 'hy-AM', ethiopic: 'am-ET',
};

const LANG_SCRIPT = {
  zh: 'han', ja: 'kana', ko: 'hangul', ru: 'cyrillic', uk: 'cyrillic', bg: 'cyrillic', sr: 'cyrillic', be: 'cyrillic', mk: 'cyrillic', kk: 'cyrillic',
  el: 'greek', ar: 'arabic', fa: 'arabic', ur: 'arabic', he: 'hebrew', yi: 'hebrew', hi: 'devanagari', mr: 'devanagari', ne: 'devanagari', bn: 'bengali',
  ta: 'tamil', te: 'telugu', kn: 'kannada', ml: 'malayalam', gu: 'gujarati', pa: 'gurmukhi', si: 'sinhala', th: 'thai', lo: 'lao', km: 'khmer',
  my: 'myanmar', ka: 'georgian', hy: 'armenian', am: 'ethiopic',
};

const primary = (tag) => String(tag || '').toLowerCase().split(/[-_]/)[0];
/** The script a language is written in (anything not listed is written in Latin script). */
export const scriptOfLang = (tag) => LANG_SCRIPT[primary(tag)] || 'latin';

/** Script of one character: a script name, 'mark' (a combining mark: goes with the letter before it) or null (digits, punctuation, spaces…). */
export function scriptOf(ch) {
  const c = ch.codePointAt(0);
  if (c < 0x80) return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 'latin' : null;
  if (c === 0x30fc || (c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff)) return 'kana';
  if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x20000 && c <= 0x2fa1f)) return 'han';
  if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) return 'hangul';
  if (!/\p{L}/u.test(ch)) return /\p{M}/u.test(ch) ? 'mark' : null;
  for (const [name, re] of OTHER_SCRIPTS) if (re.test(ch)) return name;
  return 'other';
}

/**
 * Cuts text into runs of one script each. Digits, punctuation and spaces have no script of their own and stay with the
 * letters before them ("Apple Store, " ends its run after the comma, which gives the English phrase its natural pause).
 */
export function runsOf(text) {
  const runs = [];
  let lead = '';
  let tail = ''; // what lies between the last letter and the next one
  for (const ch of text) {
    const s = scriptOf(ch);
    const cur = runs[runs.length - 1];
    if (s === null || s === 'mark') { if (cur) cur.text += ch; else lead += ch; if (s === null) tail += ch; continue; }
    // a clause ends or a quotation starts/ends here: the next letters start a new run even in the same script, so that Chinese
    // around a Japanese quotation is not taken along when the quotation claims its neighbours (see japaneseClusters)
    if (cur && cur.script === s && !CLAUSE_END.test(tail)) { cur.text += ch; tail = ''; continue; }
    runs.push({ script: s, text: (cur ? '' : lead) + ch }); // leading punctuation goes with the first run
    tail = '';
  }
  if (!runs.length && lead) return [{ script: null, text: lead }];
  return runs;
}

const letterCount = (s) => { let n = 0; for (const ch of s) if (/\p{L}/u.test(ch)) n++; return n; };
const wordsOf = (s) => s.match(/[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu) || [];

const CLAUSE_END = /[。！？；：」』”）)\]】》〉…!?;:「『“（(【《〈\[]/u; // the end of a clause, or the start of a quotation or bracket
const NEAR = /^[\s、・]*$/u; // between a kana run and a Han run that belongs to it there may be a space or a 、

/** Kana only counts as Japanese from two letters on (a lone の in Chinese text is not a Japanese sentence); Han next to kana is Japanese too. */
function japaneseClusters(runs, ctxLang) {
  const kanaLetters = runs.filter((r) => r.script === 'kana').reduce((n, r) => n + letterCount(r.text), 0);
  const ja = kanaLetters >= 2 || primary(ctxLang) === 'ja';
  const out = runs.map((r) => ({ ...r, script: r.script === 'kana' && !ja ? 'other' : r.script }));
  const was = out.map((r) => r.script);
  const tailOf = (r) => /[^\p{L}\p{M}]*$/u.exec(r.text)[0];
  if (ja) {
    out.forEach((r, i) => {
      const afterKana = was[i - 1] === 'kana' && NEAR.test(tailOf(out[i - 1]));
      const beforeKana = was[i + 1] === 'kana' && NEAR.test(tailOf(r));
      if (was[i] === 'han' && (afterKana || beforeKana)) r.script = 'kana';
    });
  }
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && last.script === r.script) last.text += r.text; else merged.push({ ...r });
  }
  return merged;
}

// ---------------------------------------------------------------- text preparation
/** Makes text friendlier for speech engines, which read some symbols aloud: links, footnote numbers, quotation marks, dashes, emoji… */
export function cleanForSpeech(text) {
  return String(text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[\d{1,3}\]|［\d{1,3}］/g, '')
    .replace(/[「」『』《》〈〉“”‘’"]/g, '')
    .replace(/[…⋯]+|\.{3,}/g, '，')
    .replace(/[—―─–]{1,}/g, '，')
    .replace(/[*#_~`|^<>{}\\]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[，,]\s*[，,]+/g, '，')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- languages
/** The language a run in `script` is spoken in, given the language of the book (or of the question). */
function languageOf(script, runText, ctxLang) {
  const own = primary(ctxLang);
  if (script === 'latin') return scriptOfLang(ctxLang) === 'latin' ? ctxLang : 'en-US';
  if (script === 'han') {
    if (own === 'ja') return 'ja-JP';
    if (own === 'zh' || own === 'ko') return ctxLang;   // hanja in a Korean book are read the Korean way
    return chineseVariant(runText, 'zh-TW');
  }
  if (script === 'kana') return 'ja-JP';
  if (script === 'hangul') return 'ko-KR';
  if (SCRIPT_LANG[script]) return scriptOfLang(ctxLang) === script ? ctxLang : SCRIPT_LANG[script];
  return ctxLang;
}

const isPhrase = (text) => wordsOf(text).length >= PHRASE_WORDS || letterCount(text) >= PHRASE_LETTERS;
const hasWord = (text) => wordsOf(text).some((w) => [...w].length >= 2);

/**
 * Splits `text` into parts to be spoken one after the other, each with the language whose voice should read it.
 * @param {string} text       the text as written — quotation marks are clues to where a phrase begins and ends, so clean it afterwards
 * @param {object} o
 * @param {string} o.lang       language of the book (or of the question) — the main voice's language, unless the text is
 *                              mostly in another script (an English sentence in a Chinese book is read in English)
 * @param {(lang:string)=>boolean} o.hasVoice  whether the phone has a voice for a language (without one, the run stays)
 * @param {'phrases'|'words'|'off'} o.mode
 * @returns {{text:string, lang:string}[]}  the texts joined are exactly `text`
 */
export function planSpeech(text, { lang = 'en-US', hasVoice = () => true, mode = DEFAULT_MIXED_MODE } = {}) {
  const ctxLang = lang || 'en-US';
  const runs = japaneseClusters(runsOf(text), ctxLang).filter((r) => r.script !== null);
  if (!runs.length) return [{ text, lang: ctxLang }];

  // The main voice speaks the language of the book (or of the question) — unless the unit is mostly in another script,
  // like a whole English sentence in a Chinese book, which is then read in that language. (Judging by the most letters
  // alone would flip a Japanese sentence to English as soon as an English title is longer than its kana.)
  const weight = new Map();
  for (const r of runs) weight.set(r.script, (weight.get(r.script) || 0) + letterCount(r.text) * (['han', 'kana', 'hangul'].includes(r.script) ? WIDE : 1));
  const [topScript, topWeight] = [...weight.entries()].sort((a, b) => b[1] - a[1])[0];
  const ctxScript = scriptOfLang(ctxLang);
  const ctxIsPresent = (weight.get(ctxScript) || 0) > 0;
  const mainScript = ctxIsPresent && weight.get(ctxScript) >= MAIN_SHARE * topWeight ? ctxScript : topScript;
  const mainRun = runs.find((r) => r.script === mainScript);
  const main = languageOf(mainScript, mainRun.text, ctxLang);
  // One voice for the whole unit ("off", or too chopped up): the book's language when its script is there, because a voice for
  // another language skips the book's own characters altogether, while the book's voice at least stumbles through a foreign word.
  const single = [{ text, lang: ctxIsPresent ? languageOf(ctxScript, runs.find((r) => r.script === ctxScript).text, ctxLang) : main }];
  if (mode === 'off') return single;

  // `latin` is how foreign Latin-script text is treated: 'words' (every word), 'phrases', or 'none'
  const build = (latin) => {
    const parts = [];
    for (const r of runs) {
      const l = languageOf(r.script, r.text, ctxLang);
      let target = main;
      if (primary(l) !== primary(main) && hasVoice(l)) {
        if (r.script === 'latin') { if (latin === 'words' ? hasWord(r.text) : latin === 'phrases' && isPhrase(r.text)) target = l; }
        else if (r.script !== 'other') target = l;
      }
      const last = parts[parts.length - 1];
      if (last && last.lang === target) last.text += r.text; else parts.push({ text: r.text, lang: target });
    }
    return parts;
  };
  for (const latin of mode === 'words' ? ['words', 'phrases', 'none'] : ['phrases', 'none']) {
    const parts = build(latin);
    if (parts.length <= MAX_PARTS) return parts;
  }
  return single;
}
