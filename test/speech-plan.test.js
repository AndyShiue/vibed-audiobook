// Mixed-language reading: which voice reads which words (speech-plan.js) and how the narrator / answer speaker play several
// parts of one sentence back to back (tts.js), using a fake speech engine with a few voices and virtual time.
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { planSpeech, runsOf, scriptOf, scriptOfLang, MIXED_MODES } from '../public/js/speech-plan.js';
import { Narrator, AnswerSpeaker, speechParts, mixedMode, voiceScore } from '../public/js/tts.js';

const all = () => true;
const plan = (text, o = {}) => planSpeech(text, { hasVoice: all, ...o });
const langs = (parts) => parts.map((p) => p.lang);
const texts = (parts) => parts.map((p) => p.text);

// ---------------------------------------------------------------- the planner
test('a Chinese book: an English phrase gets the English voice, the rest stays Chinese', () => {
  const parts = plan('我昨天在 Apple Store 買了一支手機。', { lang: 'zh-TW' });
  assert.deepEqual(langs(parts), ['zh-TW', 'en-US', 'zh-TW']);
  assert.equal(parts[1].text.trim(), 'Apple Store');
});

test('a single English word gets the English voice by default ("words"); with "phrases" it stays with the main voice', () => {
  const s = '我昨天買了一支 iPhone 手機。';
  const words = plan(s, { lang: 'zh-TW' });
  assert.deepEqual(langs(words), ['zh-TW', 'en-US', 'zh-TW']);
  assert.equal(words[1].text.trim(), 'iPhone');
  assert.deepEqual(plan(s, { lang: 'zh-TW', mode: 'words' }), words);
  assert.deepEqual(langs(plan(s, { lang: 'zh-TW', mode: 'phrases' })), ['zh-TW']);
});

test('the English words of a typical mixed answer are all read by the English voice', () => {
  const cases = [
    ['老周最近在學 Python，還買了一台 iPhone。', ['Python', 'iPhone']],
    ['這個詞是 deadline，意思是截止日期。', ['deadline']],
    ['這個 character 的 motivation 很複雜。', ['character', 'motivation']],
    ['這裡的 Wi-Fi 密碼是 abc123。', ['Wi-Fi', 'abc123']],
    ['AI 會幫你整理重點。', ['AI']],
    ['Deadline 通常是「截止期限」。', ['Deadline']],
  ];
  for (const [text, english] of cases) {
    const parts = plan(text, { lang: 'zh-TW' });
    assert.equal(parts.map((p) => p.text).join(''), text);
    const spoken = parts.filter((p) => p.lang === 'en-US').map((p) => p.text.replace(/[^\p{L}\p{N}-]+/gu, ' ').trim());
    assert.deepEqual(spoken, english, text);
    assert.ok(parts.filter((p) => p.lang === 'zh-TW').every((p) => !/[A-Za-z]{2}/.test(p.text)), `no English is left to the Chinese voice in ${text}`);
  }
});

test('a unit that would need too many switches falls back step by step: words → phrases → one voice', () => {
  const manyWords = '我 Apple Store 你 Big Mac 他 ab 她 cd 它 ef 牠 gh 我 ij 你 kl 好';
  const parts = plan(manyWords, { lang: 'zh-TW' });
  assert.ok(parts.length <= 8 && parts.length > 1, `${parts.length} parts`);
  assert.deepEqual(parts.filter((p) => p.lang === 'en-US').map((p) => p.text.trim()), ['Apple Store', 'Big Mac'], 'only the phrases still switch');
  const onlyWords = '一 ab 二 cd 三 ef 四 gh 五 ij 六 kl 七 mn 八 op 九';
  assert.deepEqual(plan(onlyWords, { lang: 'zh-TW' }), [{ text: onlyWords, lang: 'zh-TW' }]);
});

test('a title in quotation marks is one phrase', () => {
  const parts = plan('她讀了《Pride and Prejudice》之後哭了。', { lang: 'zh-TW' });
  assert.deepEqual(langs(parts), ['zh-TW', 'en-US', 'zh-TW']);
  assert.match(parts[1].text, /^Pride and Prejudice/);
});

test('"off" never splits, and a language without a voice on the phone stays with the main voice', () => {
  const s = '我昨天在 Apple Store 買了一支手機。';
  assert.deepEqual(plan(s, { lang: 'zh-TW', mode: 'off' }), [{ text: s, lang: 'zh-TW' }]);
  assert.deepEqual(plan(s, { lang: 'zh-TW', hasVoice: (l) => !l.startsWith('en') }), [{ text: s, lang: 'zh-TW' }]);
});

test('an English book: Chinese and Japanese words switch voice even when they are one word', () => {
  assert.deepEqual(langs(plan('He said 不積跬步，無以至千里 and left.', { lang: 'en-US' })), ['en-US', 'zh-TW', 'en-US']);
  assert.deepEqual(langs(plan('My friend 老周 left.', { lang: 'en-US' })), ['en-US', 'zh-TW', 'en-US']);
  assert.deepEqual(langs(plan('The word ありがとう means thanks.', { lang: 'en-US' })), ['en-US', 'ja-JP', 'en-US']);
});

test('simplified Chinese gets a mainland voice', () => {
  assert.deepEqual(langs(plan('He said 他买了一部手机 and left.', { lang: 'en-US' })), ['en-US', 'zh-CN', 'en-US']);
});

test('a Japanese book: an English phrase switches, kana and kanji stay together', () => {
  const parts = plan('彼は Apple Store で買い物をした。', { lang: 'ja-JP' });
  assert.deepEqual(langs(parts), ['ja-JP', 'en-US', 'ja-JP']);
  assert.deepEqual(langs(plan('今日は天気がいいですね。', { lang: 'ja-JP' })), ['ja-JP']);
});

test('a Japanese phrase inside a Chinese book is spoken in Japanese, the Chinese around it is not taken along', () => {
  const parts = plan('他說「ありがとうございます」然後離開了。', { lang: 'zh-TW' });
  assert.deepEqual(langs(parts), ['zh-TW', 'ja-JP', 'zh-TW']);
  assert.match(parts[1].text, /^ありがとうございます/);
  assert.match(parts[2].text, /^然後離開了/);
});

test('one stray kana in Chinese text is not a Japanese sentence', () => {
  assert.deepEqual(plan('這是我の書。', { lang: 'zh-TW' }), [{ text: '這是我の書。', lang: 'zh-TW' }]);
});

test('other scripts: Russian, Korean and Arabic books get an English voice for an English phrase; Cyrillic in a Chinese book gets Russian', () => {
  assert.deepEqual(langs(plan('Он купил iPhone вчера в Apple Store.', { lang: 'ru-RU' })), ['ru-RU', 'en-US', 'ru-RU', 'en-US']);
  assert.deepEqual(langs(plan('Он купил iPhone вчера в Apple Store.', { lang: 'ru-RU', mode: 'phrases' })), ['ru-RU', 'en-US']);
  assert.deepEqual(langs(plan('나는 어제 Apple Store 에서 샀다.', { lang: 'ko-KR' })), ['ko-KR', 'en-US', 'ko-KR']);
  assert.deepEqual(langs(plan('ذهبت إلى Apple Store أمس.', { lang: 'ar-SA' })), ['ar-SA', 'en-US', 'ar-SA']);
  assert.deepEqual(langs(plan('他說了 Привет мир 然後走了。', { lang: 'zh-TW' })), ['zh-TW', 'ru-RU', 'zh-TW']);
});

test('a French book keeps its own language for Latin letters and sends Chinese to a Chinese voice', () => {
  assert.deepEqual(langs(plan('Il a dit 你好 puis il est parti.', { lang: 'fr-FR' })), ['fr-FR', 'zh-TW', 'fr-FR']);
  assert.deepEqual(plan('Il est parti hier soir.', { lang: 'fr-FR' }), [{ text: 'Il est parti hier soir.', lang: 'fr-FR' }]);
});

test('a whole English sentence in a Chinese book is read by the English voice', () => {
  const s = 'Pride and Prejudice is a novel about manners and marriage.';
  assert.deepEqual(plan(s, { lang: 'zh-TW' }), [{ text: s, lang: 'en-US' }]);
});

test('an English title longer than the Japanese around it does not turn the sentence into an English one', () => {
  const parts = plan('彼は Pride and Prejudice を読んだ。', { lang: 'ja-JP' });
  assert.deepEqual(langs(parts), ['ja-JP', 'en-US', 'ja-JP']);
});

test('no letters at all: one part in the book language', () => {
  for (const s of ['1234 5678', '……', '']) assert.deepEqual(plan(s, { lang: 'zh-TW' }), [{ text: s, lang: 'zh-TW' }]);
});

test('a sentence chopped into too many pieces falls back to ONE voice — the book\'s, so its own characters are not skipped', () => {
  const phrases = '我 Apple Store 你 Google Maps 他 Red Bull 她 Coca Cola 它 Pizza Hut 牠 Taco Bell 我 Big Mac 你 Hot Dog 好';
  assert.deepEqual(plan(phrases, { lang: 'zh-TW' }), [{ text: phrases, lang: 'zh-TW' }]);
  const words = '一 AB 二 CD 三 EF 四 GH 五 IJ 六 KL 七 MN 八 OP 九 QR 十';
  assert.deepEqual(plan(words, { lang: 'zh-TW', mode: 'words' }), [{ text: words, lang: 'zh-TW' }]);
  assert.ok(plan('一 AB 二 CD 三', { lang: 'zh-TW', mode: 'words' }).length > 1, 'a few switches are fine');
});

test('whatever the plan, the parts joined are exactly the text, and every part has something to read', () => {
  const corpus = [
    '我昨天在 Apple Store 買了一支手機。', '"Hello," she said. 「你好」他回答。', '彼は Apple Store で iPhone を買った。', 'Он сказал: «Hello world» и ушёл.',
    'Il a dit 你好, puis « Pride and Prejudice » 。', '《Pride and Prejudice》與《傲慢與偏見》', '3.14 Pi 約等於 3.14，不是 22/7。',
    '😀 emoji 和 text 混在一起 😀', 'ありがとう、谢谢、감사합니다、thank you、Спасибо。', 'école 和 café', '   ', '，。！',
  ];
  const noVoice = () => false;
  for (const text of corpus) for (const lang of ['zh-TW', 'en-US', 'ja-JP', 'ru-RU', 'ko-KR']) for (const mode of MIXED_MODES) for (const hasVoice of [all, noVoice]) {
    const where = `${JSON.stringify(text)} ${lang} ${mode} ${hasVoice === all ? 'voices' : 'no voices'}`;
    const parts = planSpeech(text, { lang, mode, hasVoice });
    assert.equal(parts.map((p) => p.text).join(''), text, where);
    assert.ok(parts.length >= 1, where);
    if (parts.length > 1) for (const p of parts) assert.match(p.text, /[\p{L}\p{N}]/u, `a part with nothing to read: ${where}`);
    if (mode === 'off' || hasVoice === noVoice) assert.equal(parts.length, 1, where); // nothing to switch to, or switching is off
  }
});

test('scripts: letters by writing system, marks and punctuation go with the letters before them', () => {
  assert.equal(scriptOf('a'), 'latin');
  assert.equal(scriptOf('é'), 'latin');
  assert.equal(scriptOf('中'), 'han');
  assert.equal(scriptOf('の'), 'kana');
  assert.equal(scriptOf('ー'), 'kana');
  assert.equal(scriptOf('한'), 'hangul');
  assert.equal(scriptOf('Ж'), 'cyrillic');
  assert.equal(scriptOf('ع'), 'arabic');
  assert.equal(scriptOf('7'), null);
  assert.equal(scriptOf('，'), null);
  assert.equal(scriptOf('́'), 'mark');
  assert.deepEqual(runsOf('abc 123, 世界!').map((r) => `${r.script}:${r.text}`), ['latin:abc 123, ', 'han:世界!']);
  assert.deepEqual(runsOf('école').map((r) => r.script), ['latin']);
  assert.deepEqual(runsOf('「你好」').map((r) => `${r.script}:${r.text}`), ['han:「你好」']);
  assert.deepEqual(scriptOfLang('zh-TW'), 'han');
  assert.deepEqual(scriptOfLang('ja'), 'kana');
  assert.deepEqual(scriptOfLang('ru-RU'), 'cyrillic');
  assert.deepEqual(scriptOfLang('fr-FR'), 'latin');
  assert.deepEqual(scriptOfLang(''), 'latin');
});

// ---------------------------------------------------------------- voices
const voice = (name, lang, extra = {}) => ({ name, lang, voiceURI: name, localService: true, default: false, ...extra });

test('voiceScore: the right language and locale, then quality; novelty and compact voices lose', () => {
  assert.equal(voiceScore(voice('Samantha', 'ja-JP'), 'en-US'), -1);
  const exact = voiceScore(voice('Samantha', 'en-US'), 'en-US');
  const other = voiceScore(voice('Daniel', 'en-GB'), 'en-US');
  assert.ok(exact > other && other > 0);
  const zh = (lang) => voiceScore(voice('V', lang), 'zh-TW');
  assert.ok(zh('zh-TW') > zh('zh-HK') && zh('zh-HK') > zh('zh-CN'), 'Traditional text prefers Taiwan, then Hong Kong, then mainland voices');
  // iOS tells the quality in the URI, not in the name
  const ios = (q) => voice('Samantha', 'en-US', { voiceURI: `com.apple.voice.${q}.en-US.Samantha` });
  assert.ok(voiceScore(ios('enhanced'), 'en-US') > voiceScore(ios('compact'), 'en-US'));
  assert.ok(voiceScore(ios('premium'), 'en-US') > voiceScore(ios('compact'), 'en-US'));
  assert.ok(voiceScore(voice('Samantha', 'en-US'), 'en-US') > voiceScore(voice('Zarvox', 'en-US'), 'en-US'));
  assert.ok(voiceScore(voice('Samantha', 'en-US'), 'en-US') > voiceScore(voice('Fred', 'en-US'), 'en-US'));
  assert.ok(voiceScore(voice('Microsoft Aria Online (Natural)', 'en-US', { localService: false }), 'en-US') > voiceScore(voice('Samantha', 'en-US'), 'en-US'));
});

// ---------------------------------------------------------------- the fake engine
const VOICES = [
  voice('Mei-Jia', 'zh-TW', { default: true }), voice('Tingting', 'zh-CN'), voice('Samantha', 'en-US'), voice('Daniel', 'en-GB'),
  voice('Alex', 'en-US', { voiceURI: 'alex-uri' }), voice('Kyoko', 'ja-JP'),
];

/** Speaks one utterance at a time (`msPerChar` per character) and records what it spoke, with the voice it was given. */
function installEngine({ voices = VOICES, msPerChar = 100, failText = null } = {}) {
  const e = { queue: [], current: null, timer: null, started: [], cancels: 0, maxQueued: 0 };
  const synth = {
    speaking: false, pending: false,
    getVoices: () => voices, addEventListener() {}, removeEventListener() {},
    speak(u) {
      e.queue.push(u);
      e.maxQueued = Math.max(e.maxQueued, e.queue.length + (e.current ? 1 : 0));
      synth.pending = true;
      pump();
    },
    cancel() { clearTimeout(e.timer); e.queue.length = 0; e.current = null; synth.speaking = false; synth.pending = false; e.cancels++; },
  };
  function pump() {
    if (e.current || !e.queue.length) return;
    const u = e.queue.shift();
    synth.pending = e.queue.length > 0;
    e.current = u; synth.speaking = true;
    e.started.push({ text: u.text, lang: u.voice?.lang ?? u.lang, voice: u.voice?.name ?? null });
    setTimeout(() => { if (e.current === u) u.onstart?.(); }, 20);
    e.timer = setTimeout(() => {
      e.current = null; synth.speaking = false;
      if (failText !== null && u.text === failText) u.onerror?.({ error: 'synthesis-failed' }); else u.onend?.();
      pump();
    }, 20 + u.text.length * msPerChar);
  }
  globalThis.speechSynthesis = synth;
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  return e;
}

afterEach(() => { mock.timers.reset(); delete globalThis.speechSynthesis; delete globalThis.SpeechSynthesisUtterance; });

const advance = (ms, step = 50) => { for (let t = 0; t < ms; t += step) mock.timers.tick(step); };
const flush = () => new Promise((r) => setImmediate(r));
const base = { rate: 1, answerPitch: 1, voiceURI: {}, answerVoiceURI: {}, mixedVoice: 'phrases' };
const UNITS = ['我昨天在 Apple Store 買了一支手機。', '第二句話在這裡。'];

function narrate(units, lang, settings = base) {
  const narr = new Narrator(() => settings);
  const index = [], seen = { end: 0, error: [] };
  narr.addEventListener('index', (e) => index.push(e.detail));
  narr.addEventListener('end', () => { seen.end++; });
  narr.addEventListener('error', (e) => seen.error.push(e.detail));
  narr.load(units, lang, 0);
  return { narr, index, seen };
}

test('speechParts cleans each part after planning and understands the mode setting', () => {
  installEngine();
  const fallback = () => 'zh-TW';
  const parts = speechParts('她讀了《Pride and Prejudice》之後哭了。', { lang: 'zh-TW', settings: base, fallback });
  assert.deepEqual(parts, [{ lang: 'zh-TW', text: '她讀了' }, { lang: 'en-US', text: 'Pride and Prejudice' }, { lang: 'zh-TW', text: '之後哭了。' }]);
  assert.equal(speechParts('她讀了《Pride and Prejudice》之後哭了。', { lang: 'zh-TW', settings: { ...base, mixedVoice: 'off' }, fallback }).length, 1);
  assert.equal(mixedMode({ mixedVoice: 'nonsense' }), 'words');
  assert.equal(mixedMode({}), 'words');
  assert.equal(mixedMode({ mixedVoice: 'phrases' }), 'phrases');
  assert.equal(mixedMode({ mixedVoice: 'off' }), 'off');
});

// ---------------------------------------------------------------- the narrator
test('a sentence with an English phrase is spoken as three utterances in order, with the voices of their languages — and is ONE reading position', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installEngine();
  const { narr, index, seen } = narrate(UNITS, 'zh-TW');
  narr.play(0);
  advance(30_000);
  assert.deepEqual(engine.started.map((s) => [s.text, s.voice]), [
    ['我昨天在', 'Mei-Jia'], ['Apple Store', 'Samantha'], ['買了一支手機。', 'Mei-Jia'], ['第二句話在這裡。', 'Mei-Jia'],
  ]);
  assert.deepEqual(index, [0, 1], 'the position moves once per sentence, not once per part');
  assert.equal(seen.end, 1);
  assert.equal(narr.playing, false);
  await flush();
});

test('"off" speaks every sentence as one utterance; a language without a voice stays with the main voice', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installEngine();
  const a = narrate(UNITS, 'zh-TW', { ...base, mixedVoice: 'off' });
  a.narr.play(0); advance(30_000);
  assert.deepEqual(engine.started.map((s) => s.text), ['我昨天在 Apple Store 買了一支手機。', '第二句話在這裡。']);
  const engine2 = installEngine({ voices: VOICES.filter((v) => !v.lang.startsWith('en')) });
  const b = narrate(UNITS, 'zh-TW');
  b.narr.play(0); advance(30_000);
  assert.deepEqual(engine2.started.map((s) => s.text), ['我昨天在 Apple Store 買了一支手機。', '第二句話在這裡。']);
});

test('pausing in the middle of a sentence and playing again starts that sentence over, from its first part', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installEngine();
  const { narr, index } = narrate(UNITS, 'zh-TW');
  narr.play(0);
  advance(700); // "我昨天在" is done, "Apple Store" is being spoken
  assert.equal(engine.started.at(-1).text, 'Apple Store');
  narr.pause();
  const n = engine.started.length;
  advance(5_000);
  assert.equal(engine.started.length, n, 'nothing is spoken while paused');
  assert.equal(narr.idx, 0);
  narr.play();
  advance(3_000);
  assert.equal(engine.started[n].text, '我昨天在', 'the sentence restarts at its first part');
  assert.deepEqual(index.slice(0, 2), [0, 0]);
});

test('seeking in the middle of a sentence drops its remaining parts', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installEngine();
  const { narr } = narrate(UNITS, 'zh-TW');
  narr.play(0);
  advance(700);
  narr.seek(1);
  advance(10_000);
  const spoken = engine.started.map((s) => s.text);
  assert.ok(!spoken.includes('買了一支手機。'), 'the rest of sentence 0 is not spoken after seeking away');
  assert.equal(spoken.at(-1), '第二句話在這裡。');
});

test('a part the engine fails on makes the sentence be spoken again, plainly and as one utterance, and reading goes on', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installEngine({ failText: 'Apple Store' });
  const { narr, index, seen } = narrate(UNITS, 'zh-TW');
  narr.play(0);
  advance(30_000);
  assert.deepEqual(engine.started.map((s) => s.text), ['我昨天在', 'Apple Store', '我昨天在 Apple Store 買了一支手機。', '第二句話在這裡。']);
  assert.equal(engine.started[2].voice, null, 'the retry leaves the voice to the engine');
  assert.equal(engine.started[2].lang, 'zh-TW');
  assert.equal(seen.end, 1);
  assert.deepEqual(seen.error, []);
  assert.deepEqual([...new Set(index)], [0, 1]);
});

test('a sentence made only of marks is skipped silently; a book of mixed units reads on to the end', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installEngine();
  const { narr, index, seen } = narrate(['……', 'Hello 世界朋友。', '「Apple Store」'], 'en-US');
  narr.play(0);
  advance(30_000);
  assert.deepEqual(engine.started.map((s) => [s.text, s.voice]), [['Hello', 'Samantha'], ['世界朋友。', 'Mei-Jia'], ['Apple Store', 'Samantha']]);
  assert.deepEqual(index, [0, 1, 2]);
  assert.equal(seen.end, 1);
});

// ---------------------------------------------------------------- the spoken answer
test('an answer is planned around the language of the QUESTION; its parts go out two at a time and "done" waits for the last', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installEngine({ msPerChar: 150 });
  const sp = new AnswerSpeaker(() => base, () => 'en-US'); // the question was English, the book is Chinese
  let spokenAtDone = null;
  const done = sp.begin().then((ok) => { spokenAtDone = engine.started.length; return ok; });
  sp.push('It means 不積跬步，無以至千里 in the old saying.');
  sp.finish();
  advance(200);
  await flush();
  assert.equal(spokenAtDone, null, 'not finished while parts are still to be spoken');
  advance(20_000);
  assert.equal(await done, true);
  assert.deepEqual(engine.started.map((s) => [s.voice, s.lang]), [['Samantha', 'en-US'], ['Mei-Jia', 'zh-TW'], ['Samantha', 'en-US']]);
  assert.equal(spokenAtDone, 3);
  assert.ok(engine.maxQueued <= 2, 'at most two utterances are in the engine at a time');
});

test('an answer to a Chinese question that names an English book is read by a Chinese voice with the title in English', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installEngine();
  const sp = new AnswerSpeaker(() => base, () => 'zh-TW');
  const done = sp.begin();
  sp.push('不太像，《Pride and Prejudice》主要寫婚姻和階級。');
  sp.finish();
  advance(20_000);
  await done;
  assert.deepEqual(engine.started.map((s) => [s.text, s.voice]), [['不太像，', 'Mei-Jia'], ['Pride and Prejudice', 'Samantha'], ['主要寫婚姻和階級。', 'Mei-Jia']]);
});

test('the answer voice chosen in the settings is used per language, and "off" keeps an answer in one utterance', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installEngine();
  const chosen = { ...base, answerVoiceURI: { 'en-US': 'alex-uri' } };
  const sp = new AnswerSpeaker(() => chosen, () => 'zh-TW');
  let done = sp.begin();
  sp.push('我昨天在 Apple Store 買了一支手機。');
  sp.finish();
  advance(20_000);
  await done;
  assert.deepEqual(engine.started.map((s) => s.voice), ['Mei-Jia', 'Alex', 'Mei-Jia']);

  engine.started.length = 0;
  const off = new AnswerSpeaker(() => ({ ...base, mixedVoice: 'off' }), () => 'zh-TW');
  done = off.begin();
  off.push('我昨天在 Apple Store 買了一支手機。');
  off.finish();
  advance(20_000);
  await done;
  assert.deepEqual(engine.started.map((s) => s.text), ['我昨天在 Apple Store 買了一支手機。']);
});

test('cancelling an answer in the middle of a sentence leaves no later part to be spoken', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installEngine();
  const sp = new AnswerSpeaker(() => base, () => 'zh-TW');
  const done = sp.begin();
  sp.push('我昨天在 Apple Store 買了一支手機。');
  advance(700);
  sp.cancel();
  assert.equal(await done, false);
  const n = engine.started.length;
  advance(20_000);
  assert.equal(engine.started.length, n);
});
