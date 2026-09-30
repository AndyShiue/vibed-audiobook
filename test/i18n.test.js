// The interface exists in three languages. These tests make sure none of them can silently fall behind:
// same keys everywhere, same placeholders, every key used by the code exists, and no user-visible Chinese is
// hard-coded in the modules that should go through t().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, LANGS, t, tIn, setLang, getLang, isLang } from '../public/js/i18n.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUBLIC, p), 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const HAN = /[一-鿿]/;

test.afterEach(() => setLang('zh'));

test('Chinese is the default; English and Japanese are offered', () => {
  assert.equal(getLang(), 'zh');
  assert.deepEqual(LANGS.map((l) => l.code), ['zh', 'en', 'ja']);
  assert.ok(isLang('ja') && isLang('en') && !isLang('fr'));
  assert.equal(setLang('fr'), 'zh', 'an unknown language falls back to Chinese');
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
  const allowed = new Set(['set.language', 'preview.narration.zh', 'preview.answer.zh', 'preview.narration.ja', 'preview.answer.ja']); // previews are spoken in the voice's own language
  for (const [key, value] of Object.entries(STRINGS.en)) {
    if (typeof value !== 'string' || allowed.has(key)) continue;
    assert.ok(!HAN.test(value), `en:${key} still contains Chinese: ${value}`);
  }
});

test('Japanese strings are really translated (not copies of the Chinese ones)', () => {
  const allowedSame = new Set(['quote', 'shake.normal', 'set.language', 'lib.formatsList', 'preview.narration.zh', 'preview.answer.zh', 'preview.narration.ja', 'preview.answer.ja', 'preview.narration.en', 'preview.answer.en']);
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

test('the settings screen offers the three languages and the app starts in Chinese', () => {
  const html = read('index.html');
  assert.match(html, /<select id="setUiLang">[\s\S]*?value="zh">中文[\s\S]*?value="en">English[\s\S]*?value="ja">日本語/);
  assert.match(read('js/library.js'), /uiLang: 'zh'/);
  assert.match(read('js/app.js'), /setLang\(S\.settings\.uiLang\);\s*applyI18n\(\);/);
});
