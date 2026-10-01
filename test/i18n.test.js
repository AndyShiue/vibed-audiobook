// The interface exists in three languages. These tests make sure none of them can silently fall behind:
// same keys everywhere, same placeholders, every key used by the code exists, and no user-visible Chinese is
// hard-coded in the modules that should go through t().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, LANGS, t, tIn, setLang, getLang, isLang, detectLang, resolveLang, FALLBACK_LANG, LANG_AUTO } from '../public/js/i18n.js';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../public/js/library.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUBLIC, p), 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const HAN = /[一-鿿]/;

test.afterEach(() => setLang('zh'));

test('Chinese, English and Japanese are offered; anything else falls back to English', () => {
  assert.deepEqual(LANGS.map((l) => l.code), ['zh', 'en', 'ja']);
  assert.ok(isLang('ja') && isLang('en') && isLang('zh') && !isLang('fr') && !isLang('auto') && !isLang('constructor') && !isLang('__proto__'));
  assert.equal(FALLBACK_LANG, 'en');
  assert.equal(setLang('fr'), 'en', 'an unknown language falls back to English');
  assert.equal(setLang('zh'), 'zh');
});

test('the interface language follows the phone: its first language that we have wins', () => {
  assert.equal(detectLang(['ja-JP', 'en-US']), 'ja');
  assert.equal(detectLang(['en-GB', 'ja']), 'en');
  assert.equal(detectLang(['zh-TW']), 'zh');
  assert.equal(detectLang(['zh-Hant-HK', 'en']), 'zh');
  assert.equal(detectLang(['zh-CN']), 'zh', 'Simplified-Chinese phones get the Chinese we have');
  assert.equal(detectLang(['yue-HK']), 'zh', 'Cantonese and other names for Chinese');
  assert.equal(detectLang(['fr-FR', 'de', 'ja-JP']), 'ja', 'languages we lack are skipped in favour of the next one');
  assert.equal(detectLang(['fr-FR', 'de-DE', 'ko-KR']), 'en', 'none of ours: English');
  assert.equal(detectLang([]), 'en');
  assert.equal(detectLang(['', undefined, null, 42, 'EN_us']), 'en', 'junk entries and underscores are tolerated');
  assert.equal(detectLang(['JA-jp']), 'ja', 'case does not matter');
  assert.equal(detectLang(['constructor', '__proto__', 'toString']), 'en', 'language codes are never looked up as object properties');
});

test('a language chosen by hand is kept; "auto" and anything unknown follow the phone', () => {
  assert.equal(LANG_AUTO, 'auto');
  assert.equal(resolveLang('auto', ['ja-JP']), 'ja');
  assert.equal(resolveLang('zh', ['ja-JP']), 'zh', "the listener's own choice wins over the phone");
  assert.equal(resolveLang('en', ['ja-JP']), 'en');
  assert.equal(resolveLang('ja', ['en-US']), 'ja');
  assert.equal(resolveLang(undefined, ['ja-JP']), 'ja', 'no setting yet');
  assert.equal(resolveLang('klingon', ['ja-JP']), 'ja', 'a damaged setting does not break the app');
  assert.equal(resolveLang('auto', ['fr']), 'en');
});

test("the browser's own language list is used when none is given", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    for (const [languages, expected] of [[['ja-JP', 'en'], 'ja'], [['fr-FR', 'zh-TW'], 'zh'], [[], 'en']]) {
      Object.defineProperty(globalThis, 'navigator', { value: { languages, language: languages[0] }, configurable: true });
      assert.equal(detectLang(), expected, JSON.stringify(languages));
    }
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'ja' }, configurable: true }); // older browsers have no languages list
    assert.equal(detectLang(), 'ja');
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
    assert.equal(detectLang(), 'en', 'no browser at all');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;
  }
});

// ---------------------------------------------------------------- the stored setting
function withStorage(initial, fn) {
  const raw = initial === undefined ? [] : [['audiobook-settings-v1', typeof initial === 'string' ? initial : JSON.stringify(initial)]];
  const data = new Map(raw);
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, String(v)); } }, configurable: true });
  try { return fn(data); } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved); else delete globalThis.localStorage;
  }
}

test('a new listener starts with "follow the phone"; a language they pick is stored and stays', () => {
  assert.equal(DEFAULT_SETTINGS.uiLang, 'auto');
  withStorage(undefined, () => {
    const s = loadSettings();
    assert.equal(s.uiLang, 'auto');
    s.uiLang = 'ja'; // the listener picks Japanese in Settings
    saveSettings(s);
    const again = loadSettings();
    assert.equal(again.uiLang, 'ja', 'the choice survives a restart');
    again.uiLang = 'zh';
    saveSettings(again);
    assert.equal(loadSettings().uiLang, 'zh', 'and "Chinese" is kept as a choice from now on, whatever the phone says');
    again.uiLang = 'auto';
    saveSettings(again);
    assert.equal(loadSettings().uiLang, 'auto', 'going back to automatic is a choice too');
  });
});

test('settings saved by earlier versions: a stored "zh" was only the old default, "en" and "ja" were choices', () => {
  withStorage({ v: 2, uiLang: 'zh', rate: 1.4, shake: true }, () => {
    const s = loadSettings();
    assert.equal(s.uiLang, 'auto', 'the old default now follows the phone');
    assert.equal(s.rate, 1.4);
    assert.equal(s.shake, true, 'nothing else is touched');
  });
  withStorage({ v: 2, uiLang: 'ja' }, () => assert.equal(loadSettings().uiLang, 'ja'));
  withStorage({ v: 2, uiLang: 'en' }, () => assert.equal(loadSettings().uiLang, 'en'));
  withStorage({ rate: 1.2 }, () => assert.equal(loadSettings().uiLang, 'auto'));
  withStorage({ v: 3, uiLang: 'zh' }, () => assert.equal(loadSettings().uiLang, 'zh', 'from v3 on a stored language is always a choice'));
  withStorage('{not json', () => assert.equal(loadSettings().uiLang, 'auto'));
});

test('settings saved before v4: the old default "phrases" moves to the new default once, a choice made later stays', () => {
  withStorage({ v: 3, mixedVoice: 'phrases', rate: 1.3 }, () => {
    const s = loadSettings();
    assert.equal(s.mixedVoice, 'words');
    assert.equal(s.rate, 1.3, 'nothing else is touched');
  });
  withStorage({ v: 3, mixedVoice: 'off' }, () => assert.equal(loadSettings().mixedVoice, 'off'));
  withStorage({ v: 4, mixedVoice: 'phrases' }, () => assert.equal(loadSettings().mixedVoice, 'phrases', 'chosen by hand after the change'));
  withStorage({}, () => assert.equal(loadSettings().mixedVoice, 'words'));
});

test('settings saved before v6: the three shake levels become their numbers, the old default 3.5 becomes the new default 10, a number chosen later stays', () => {
  withStorage({ v: 4, shakeSens: 'high', rate: 1.3 }, () => {
    const s = loadSettings();
    assert.equal(s.shakeThreshold, 2.5);
    assert.equal(s.shakeSens, undefined, 'the old key is gone');
    assert.equal(s.rate, 1.3, 'nothing else is touched');
  });
  withStorage({ v: 4, shakeSens: 'normal' }, () => assert.equal(loadSettings().shakeThreshold, 10, '"normal" was the old default'));
  withStorage({ v: 4, shakeSens: 'low' }, () => assert.equal(loadSettings().shakeThreshold, 6));
  withStorage({ v: 3 }, () => assert.equal(loadSettings().shakeThreshold, 10, 'no choice made: the default'));
  withStorage({ v: 5, shakeThreshold: 12 }, () => assert.equal(loadSettings().shakeThreshold, 12));
  withStorage({ v: 5, shakeThreshold: 3.5 }, () => assert.equal(loadSettings().shakeThreshold, 10, 'the old default, saved along with everything else'));
  withStorage({ v: 6, shakeThreshold: 3.5 }, () => assert.equal(loadSettings().shakeThreshold, 3.5, 'chosen by hand after the change'));
  withStorage({}, () => assert.equal(loadSettings().shakeThreshold, 10));
});

test('all three languages define exactly the same keys', () => {
  const zh = Object.keys(STRINGS.zh).sort();
  for (const lang of ['en', 'ja']) {
    const keys = Object.keys(STRINGS[lang]).sort();
    assert.deepEqual(zh.filter((k) => !keys.includes(k)), [], `${lang} is missing keys`);
    assert.deepEqual(keys.filter((k) => !zh.includes(k)), [], `${lang} has keys Chinese does not`);
  }
});

test('{placeholders} match across languages (a missing one would print the wrong or an empty value)', () => {
  const holders = (s) => (typeof s === 'string' ? [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',') : 'fn');
  for (const key of Object.keys(STRINGS.zh)) {
    for (const lang of ['en', 'ja']) {
      assert.equal(holders(STRINGS[lang][key]), holders(STRINGS.zh[key]), `${key} (${lang})`);
    }
  }
});

test('function-valued strings (plurals, durations) work in every language', () => {
  const samples = { 'lib.chaptersN': { n: 1 }, 'dur.min': { m: 5 }, 'dur.hour': { h: 2, rem: 30 }, 'mem.failures': { n: 2 }, 'cmd.rewind': { n: 3 }, 'cmd.skip': { n: 1 } };
  for (const lang of ['zh', 'en', 'ja']) {
    setLang(lang);
    for (const [key, p] of Object.entries(samples)) {
      const out = t(key, p);
      assert.equal(typeof out, 'string');
      assert.ok(out.length > 0 && !out.includes('undefined') && !out.includes('NaN'), `${lang}:${key} → ${out}`);
    }
  }
  setLang('en');
  assert.equal(t('lib.chaptersN', { n: 1 }), '1 chapter');
  assert.equal(t('lib.chaptersN', { n: 3 }), '3 chapters');
  assert.equal(t('dur.hour', { h: 2, rem: 0 }), '2 h');
  setLang('ja');
  assert.equal(t('dur.hour', { h: 2, rem: 30 }), '2時間30分');
  setLang('en');
  assert.equal(t('cmd.rewind', { n: 1 }), 'Back one sentence');
  assert.equal(t('cmd.rewind', { n: 3 }), 'Back 3 sentences');
});

test('tIn() speaks in the language the listener used, whatever the interface language is', () => {
  setLang('zh');
  assert.equal(tIn('en-US', 'cmd.rewind', { n: 3 }), 'Back 3 sentences');
  assert.equal(tIn('ja-JP', 'cmd.stop'), 'はい、ここで止めます');
  assert.equal(tIn('zh-TW', 'cmd.chapter', { n: 5 }), '跳到第 5 章');
  assert.equal(tIn('ko-KR', 'cmd.resume'), '繼續念', 'an unsupported language falls back to the interface language');
  assert.equal(tIn('', 'cmd.resume'), '繼續念');
  setLang('ja');
  assert.equal(tIn('ko-KR', 'cmd.resume'), '続けます');
});

test('t() fills placeholders and falls back sensibly', () => {
  setLang('en');
  assert.equal(t('sleep.minutes', { n: 15 }), 'Sleep 15 min');
  assert.equal(t('lib.delete.confirm', { title: 'Dune' }), 'Delete "Dune"? Its progress and AI memory will be deleted too.');
  assert.equal(t('this.key.does.not.exist'), 'this.key.does.not.exist');
  setLang('ja');
  assert.equal(t('time.left', { t: '5分' }), '残り約5分');
  setLang('zh');
  assert.equal(t('time.left', { t: '5 分鐘' }), '還剩約 5 分鐘');
});

test('English strings contain no Chinese characters (except the deliberate multilingual ones)', () => {
  const allowed = new Set(['set.language', 'preview.narration.zh', 'preview.answer.zh', 'preview.narration.ja', 'preview.answer.ja', 'preview.mixed.zh', 'preview.mixed.ja', 'preview.mixed.en']); // previews are spoken in the voice's own language
  for (const [key, value] of Object.entries(STRINGS.en)) {
    if (typeof value !== 'string' || allowed.has(key)) continue;
    assert.ok(!HAN.test(value), `en:${key} still contains Chinese: ${value}`);
  }
});

test('Japanese strings are really translated (not copies of the Chinese ones)', () => {
  const allowedSame = new Set(['quote', 'shake.normal', 'set.language', 'lib.formatsList', 'preview.narration.zh', 'preview.answer.zh', 'preview.narration.ja', 'preview.answer.ja', 'preview.narration.en', 'preview.answer.en', 'preview.mixed.zh', 'preview.mixed.ja', 'preview.mixed.en']);
  for (const [key, value] of Object.entries(STRINGS.ja)) {
    if (typeof value !== 'string' || allowedSame.has(key) || value.length <= 6) continue;
    assert.notEqual(value, STRINGS.zh[key], `ja:${key} is identical to the Chinese text`);
  }
});

test('every translation key used by the code or the HTML exists', () => {
  const used = new Map(); // key -> where
  const add = (k, where) => { if (!used.has(k)) used.set(k, where); };
  for (const file of walk(path.join(PUBLIC, 'js'))) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(PUBLIC, file).replaceAll('\\', '/');
    if (rel === 'js/i18n.js') continue;
    for (const m of src.matchAll(/\bt\('([A-Za-z0-9_.]+)'/g)) add(m[1], rel);
    for (const m of src.matchAll(/\bt\(`([A-Za-z0-9_.]+)\.\$\{/g)) { // t(`preview.narration.${...}`) — every suffix must exist
      for (const suffix of ['zh', 'ja', 'en']) add(`${m[1]}.${suffix}`, rel);
    }
    if (rel === 'js/parsers/index.js') for (const m of src.matchAll(/'(err\.[A-Za-z0-9]+)'/g)) add(m[1], rel);
    if (rel === 'js/commands.js') for (const m of src.matchAll(/'((?:cmd|sleep)\.[A-Za-z0-9]+)'/g)) add(m[1], rel); // the planner names the message, the app speaks it
  }
  const html = read('index.html');
  for (const m of html.matchAll(/data-i18n(?:-aria|-ph)?="([^"]+)"/g)) add(m[1], 'index.html');
  assert.ok(used.size > 100, `only found ${used.size} keys — the scan is broken`);
  for (const [key, where] of used) assert.ok(key in STRINGS.zh, `${where} uses "${key}" which has no translation`);
});

test('user-visible Chinese is not hard-coded in modules that should use t()', () => {
  // Files where Chinese legitimately appears in code: character tables, sentence-splitting rules, regexes, fallbacks.
  const allowed = new Set(['js/i18n.js', 'js/lang.js', 'js/segmenter.js', 'js/tts.js', 'js/retrieval.js', 'js/util.js', 'js/memory.js', 'js/parsers/common.js', 'js/parsers/pdf.js']);
  for (const file of walk(path.join(PUBLIC, 'js'))) {
    const rel = path.relative(PUBLIC, file).replaceAll('\\', '/');
    if (allowed.has(rel)) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (HAN.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) assert.fail(`${rel}:${i + 1} hard-codes Chinese: ${line.trim().slice(0, 90)}`);
    });
  }
  // pdf.js may only mention Chinese in its page-number pattern
  read('js/parsers/pdf.js').split('\n').forEach((line, i) => { if (HAN.test(line) && !/PAGE_NUMBER|^\s*(\/\/|\*)/.test(line)) assert.fail(`pdf.js:${i + 1} hard-codes Chinese: ${line.trim()}`); });
});

test('the settings screen offers "follow the phone" and the three languages; the app starts by following the phone', () => {
  const html = read('index.html');
  assert.match(html, /<select id="setUiLang">\s*<option value="auto" data-i18n="set\.language\.auto">[\s\S]*?value="zh">中文[\s\S]*?value="en">English[\s\S]*?value="ja">日本語/);
  assert.match(read('js/library.js'), /uiLang: 'auto'/);
  const app = read('js/app.js');
  assert.match(app, /setLang\(resolveLang\(S\.settings\.uiLang\)\);\s*applyI18n\(\);/, 'the language is resolved at startup');
  assert.match(app, /function changeUiLang\(\) \{[\s\S]*?setLang\(resolveLang\(S\.settings\.uiLang\)\)/, 'and again whenever the setting changes');
  assert.match(app, /addEventListener\('languagechange'/, "and when the phone's language changes while the app is open");
  assert.match(app, /\$\('setUiLang'\)\.addEventListener\('change', \(e\) => \{ s\.uiLang = e\.target\.value; save\(\);/, 'a language picked by hand is saved at once');
});
