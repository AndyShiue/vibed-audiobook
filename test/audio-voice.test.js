// The second voice engine (audio-voice.js) and the switch between the two engines (voice-hub.js), with a fake <audio> element,
// a fake server and virtual time.
import test, { mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AudioOut, AudioNarrator, AudioAnswerSpeaker } from '../public/js/audio-voice.js';
import { VoiceEngine, NarratorHub, AnswerHub } from '../public/js/voice-hub.js';

// ---------------------------------------------------------------- fakes
const urlInfo = new Map(); // object URL → what the clip says and how long it lasts
const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
let revoked;
beforeEach(() => {
  revoked = [];
  URL.createObjectURL = (blob) => { const u = realCreate.call(URL, blob); if (blob.label !== undefined) urlInfo.set(u, { label: blob.label, dur: blob.dur }); return u; };
  URL.revokeObjectURL = (u) => { revoked.push(u); realRevoke.call(URL, u); };
});
afterEach(() => { URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; mock.timers.reset(); delete globalThis.Audio; });

/** An <audio> element that "plays" a clip for the length the fake server gave it (shorter at a higher playbackRate). */
function installAudio({ notAllowed = false } = {}) {
  const log = { played: [], rates: [], pauses: 0, silences: 0 };
  globalThis.Audio = class FakeAudio {
    constructor() { this.paused = true; this.playbackRate = 1; this.defaultPlaybackRate = 1; this.src = ''; }
    setAttribute() {}
    play() {
      const info = urlInfo.get(this.src);
      this.paused = false;
      if (!info) { log.silences++; return Promise.resolve(); } // the moment of silence that unlocks the element
      if (notAllowed) return Promise.reject(Object.assign(new Error('play() was blocked'), { name: 'NotAllowedError' }));
      log.played.push(info.label); log.rates.push(this.playbackRate);
      clearTimeout(this.t1); clearTimeout(this.t2);
      this.t1 = setTimeout(() => this.onplaying?.(), 5);
      this.t2 = setTimeout(() => { this.paused = true; this.onended?.(); }, info.dur / this.playbackRate);
      return Promise.resolve();
    }
    pause() { this.paused = true; log.pauses++; clearTimeout(this.t1); clearTimeout(this.t2); }
  };
  return log;
}

/** A server that makes a clip of `dur(text)` ms for a text, can be slow, and can fail. */
function fakeServer({ dur = (t) => t.length * 40, fail = () => null, delay = 0 } = {}) {
  const requests = [];
  const fetchClip = async (req) => {
    requests.push(req);
    const attempt = requests.filter((r) => r.text === req.text).length;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const err = fail(req, attempt);
    if (err) throw err;
    return Object.assign(new Blob([req.text]), { label: req.text, dur: dur(req.text) });
  };
  return { fetchClip, requests };
}
const httpErr = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

const flush = () => new Promise((r) => setImmediate(r));
async function advance(ms, step = 25) {
  await flush();
  for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await flush(); }
}

const base = { rate: 1, serverVoice: {}, serverAnswerVoice: {} };
const UNITS = ['一二三四五', '六七八九十', '甲乙丙丁戊'];

function narrate(units, { lang = 'zh-TW', settings = base, server = fakeServer(), ...opts } = {}) {
  mock.timers.enable({ apis: ['setTimeout'] });
  const audio = installAudio(opts.audio);
  const narr = new AudioNarrator(() => settings, { fetchClip: server.fetchClip, retryDelay: 100 });
  const seen = { index: [], end: 0, blocked: 0, error: [], state: [] };
  narr.addEventListener('index', (e) => seen.index.push(e.detail));
  narr.addEventListener('end', () => { seen.end++; });
  narr.addEventListener('blocked', () => { seen.blocked++; });
  narr.addEventListener('error', (e) => seen.error.push(e.detail));
  narr.addEventListener('state', () => seen.state.push(narr.state));
  narr.load(units, lang, 0);
  return { narr, audio, server, seen };
}

// ---------------------------------------------------------------- reading the book
test('the book is read unit by unit; the next ones are fetched while one plays; the position moves once per unit', async () => {
  const { narr, audio, server, seen } = narrate(UNITS);
  narr.play(0);
  await advance(20);
  assert.deepEqual(server.requests.map((r) => r.text), UNITS, 'this unit first, then the ones after it');
  assert.deepEqual(audio.played, [UNITS[0]]);
  assert.deepEqual(seen.index, [0]);
  await advance(2000);
  assert.deepEqual(audio.played, UNITS);
  assert.deepEqual(seen.index, [0, 1, 2]);
  assert.equal(seen.end, 1);
  assert.equal(narr.playing, false);
  assert.equal(server.requests.length, 3, 'nothing is fetched twice');
  assert.ok(revoked.length >= 3, 'the audio of units that are done is released');
  assert.equal(audio.silences, 1, 'the element is unlocked by a moment of silence on the tap that starts playing');
});

test('the speed setting is the audio element\'s playback speed', async () => {
  const { narr, audio } = narrate(UNITS, { settings: { ...base, rate: 1.5 } });
  narr.play(0);
  await advance(2000);
  assert.deepEqual(audio.rates, [1.5, 1.5, 1.5]);
  assert.deepEqual(audio.played, UNITS);
});

test('a unit is sent as written, with the book\'s language, the voices chosen per language and the mixed-language setting — the server reads each language with its voice', async () => {
  const quoted = '她讀了《Pride and Prejudice》之後哭了。';
  const voices = { 'zh-TW': 'zh-voice', 'en-US': 'en-voice' };
  const { narr, server } = narrate([quoted], { settings: { ...base, serverVoice: voices, mixedVoice: 'phrases' } });
  narr.play(0);
  await advance(2000);
  assert.deepEqual(server.requests, [{ text: quoted, lang: 'zh-TW', voice: '', voices, mixed: 'phrases' }], 'the quotation marks are kept: they tell where a phrase begins');
});

test('by default every foreign word gets its language\'s voice ("words"); with no voice chosen the server picks', async () => {
  const { narr, server } = narrate(['這是中文的一句話。']);
  narr.play(0);
  await advance(500);
  assert.deepEqual(server.requests, [{ text: '這是中文的一句話。', lang: 'zh-TW', voice: '', voices: {}, mixed: 'words' }]);
});

test('with "one voice" chosen a unit is read whole, in its own language — a whole English sentence in a Chinese book in English', async () => {
  const english = 'This is a whole English sentence about nothing in particular.';
  const { narr, server } = narrate(['這是中文的一句話。', english], { settings: { ...base, mixedVoice: 'off', serverVoice: { 'zh-TW': 'zh-voice', 'en-US': 'en-voice' } } });
  narr.play(0);
  await advance(5000);
  assert.deepEqual(server.requests.map((r) => [r.lang, r.voice, r.mixed]), [['zh-TW', 'zh-voice', 'off'], ['en-US', 'en-voice', 'off']]);
});

test('pausing in the middle of a unit stops the sound; playing again starts that unit over', async () => {
  const { narr, audio } = narrate(UNITS);
  narr.play(0);
  await advance(100);
  narr.pause();
  assert.equal(narr.playing, false);
  const n = audio.played.length;
  await advance(3000);
  assert.equal(audio.played.length, n, 'nothing plays while paused');
  assert.equal(narr.idx, 0);
  narr.play();
  await advance(3000);
  assert.deepEqual(audio.played, [UNITS[0], UNITS[0], UNITS[1], UNITS[2]]);
});

test('seeking while playing jumps there; seeking while paused only moves the position', async () => {
  const { narr, audio, seen } = narrate(UNITS);
  narr.play(0);
  await advance(100);
  narr.seek(2);
  await advance(3000);
  assert.deepEqual(audio.played, [UNITS[0], UNITS[2]]);
  narr.seek(1);
  assert.equal(narr.idx, 1);
  assert.equal(seen.index.at(-1), 1);
  assert.equal(audio.played.length, 2, 'seeking while paused plays nothing');
});

test('a unit with nothing to say is passed silently', async () => {
  const { narr, audio, server, seen } = narrate(['……', '一二三', '！']);
  narr.play(0);
  await advance(2000);
  assert.deepEqual(seen.index, [0, 1, 2]);
  assert.deepEqual(audio.played, ['一二三']);
  assert.equal(server.requests.length, 1);
  assert.equal(seen.end, 1);
});

test('a clip that fails for a passing reason is fetched again, and reading goes on', async () => {
  const server = fakeServer({ fail: (req, attempt) => (req.text === UNITS[0] && attempt === 1 ? httpErr(503) : null) });
  const { narr, audio, seen } = narrate(UNITS, { server });
  narr.play(0);
  await advance(3000);
  assert.deepEqual(audio.played, UNITS);
  assert.equal(server.requests.filter((r) => r.text === UNITS[0]).length, 2);
  assert.deepEqual(seen.error, []);
});

test('a clip the server refuses (wrong key, no credit…) is not retried: reading stops with the reason, positioned on that unit', async () => {
  const server = fakeServer({ fail: (req) => (req.text === UNITS[1] ? httpErr(402, 'no credit left') : null) });
  const { narr, audio, seen } = narrate(UNITS, { server });
  narr.play(0);
  await advance(3000);
  assert.deepEqual(audio.played, [UNITS[0]]);
  assert.deepEqual(seen.error, ['no credit left']);
  assert.equal(server.requests.filter((r) => r.text === UNITS[1]).length, 1, 'no retry for a refusal');
  assert.equal(narr.playing, false);
  assert.equal(narr.idx, 1, 'the position is the unit that could not be made, so a fallback continues from there');
  assert.equal(seen.end, 0);
});

test('a browser that blocks autoplay is reported as "blocked", not as an error', async () => {
  const { narr, seen } = narrate(UNITS, { audio: { notAllowed: true } });
  narr.play(0);
  await advance(500);
  assert.equal(seen.blocked, 1);
  assert.deepEqual(seen.error, []);
  assert.equal(narr.playing, false);
});

test('a second clip replaces the first in the one <audio> element', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const audio = installAudio();
  const out = new AudioOut();
  const url = (label, dur) => URL.createObjectURL(Object.assign(new Blob([label]), { label, dur }));
  const first = out.play(url('a', 1000));
  await flush();
  const second = out.play(url('b', 100));
  assert.equal(await first, 'stopped');
  await advance(200);
  assert.equal(await second, 'ended');
  assert.deepEqual(audio.played, ['a', 'b']);
});

// ---------------------------------------------------------------- the spoken answer
function answer({ lang = 'zh-TW', settings = base, server = fakeServer(), speakDevice = null, onFail = null } = {}) {
  mock.timers.enable({ apis: ['setTimeout'] });
  const audio = installAudio();
  const sp = new AudioAnswerSpeaker(() => settings, () => lang, { fetchClip: server.fetchClip, speakDevice, onFail, retryDelay: 100 });
  return { sp, audio, server };
}

test('an answer is spoken sentence by sentence; every sentence is fetched at once, and "done" waits for the last one', async () => {
  const { sp, audio, server } = answer({ settings: { ...base, serverVoice: { 'zh-TW': 'book-voice' }, serverAnswerVoice: { 'zh-TW': 'answer-voice' } } });
  let playedAtDone = null;
  const done = sp.begin().then((ok) => { playedAtDone = audio.played.length; return ok; });
  const sentences = ['第一句回答。', '第二句回答。', '第三句回答。'];
  sentences.forEach((s) => sp.push(s));
  sp.finish();
  await flush();
  assert.equal(server.requests.length, 3, 'all requested up front');
  assert.ok(server.requests.every((r) => r.voices['zh-TW'] === 'answer-voice' && r.mixed === 'words'), 'the answer voice beats the reading voice');
  await advance(100);
  assert.equal(playedAtDone, null, 'not finished while sentences are left');
  await advance(3000);
  assert.equal(await done, true);
  assert.deepEqual(audio.played, sentences);
  assert.equal(playedAtDone, 3);
});

test('an answer sentence is sent as written, with the question\'s language: the server reads each part in its own language', async () => {
  const { sp, server } = answer({ lang: 'zh-TW', settings: { ...base, serverVoice: { 'en-US': 'en-voice' } } });
  const done = sp.begin();
  const sentence = '這個詞是 deadline，意思是「截止期限」。';
  sp.push(sentence);
  sp.finish();
  await advance(3000);
  await done;
  assert.deepEqual(server.requests, [{ text: sentence, lang: 'zh-TW', voice: '', voices: { 'en-US': 'en-voice' }, mixed: 'words' }]);
});

test('with "one voice" chosen an answer sentence is read whole in the language it is in, even when the question was in another', async () => {
  const { sp, server } = answer({ lang: 'en-US', settings: { ...base, mixedVoice: 'off', serverAnswerVoice: { 'zh-TW': 'zh-answer' } } });
  const done = sp.begin();
  sp.push('It means that small steps matter.');
  sp.push('這句話的意思是說，不要小看每一步。');
  sp.finish();
  await advance(3000);
  await done;
  assert.deepEqual(server.requests.map((r) => [r.lang, r.voice]), [['en-US', ''], ['zh-TW', 'zh-answer']]);
});

test('cancelling an answer stops the sound at once and nothing more is spoken', async () => {
  const { sp, audio } = answer();
  const done = sp.begin();
  ['第一句回答。', '第二句回答。', '第三句回答。'].forEach((s) => sp.push(s));
  await advance(100);
  const n = audio.played.length;
  sp.cancel();
  assert.equal(await done, false);
  await advance(3000);
  assert.equal(audio.played.length, n);
  sp.push('太晚了。');
  await advance(500);
  assert.equal(audio.played.length, n, 'a cancelled answer ignores late sentences');
});

test('a sentence the server cannot make is said by the phone instead — in its place — and the app is told', async () => {
  const bad = '第二句回答。';
  const server = fakeServer({ fail: (req) => (req.text === bad ? httpErr(401, 'key rejected') : null) });
  const said = [];
  const speakDevice = (text, o) => {
    said.push({ text, lang: o.lang });
    let finish; const done = new Promise((r) => { finish = r; });
    setTimeout(finish, 300);
    return { done, cancel: finish };
  };
  const failures = [];
  const { sp, audio } = answer({ server, speakDevice, onFail: (e) => failures.push(e.message) });
  const done = sp.begin();
  ['第一句回答。', bad, '第三句回答。'].forEach((s) => sp.push(s));
  sp.finish();
  await advance(5000);
  assert.equal(await done, true);
  assert.deepEqual(audio.played, ['第一句回答。', '第三句回答。']);
  assert.deepEqual(said, [{ text: bad, lang: 'zh-TW' }]);
  assert.deepEqual(failures, ['key rejected']);
});

test('say() speaks a short message and resolves when it is done; a message with nothing to say resolves at once', async () => {
  const { sp, audio } = answer();
  let finished = false;
  const p = sp.say('好的，已經往回三句。').then(() => { finished = true; });
  await advance(100);
  assert.equal(finished, false);
  await advance(3000);
  await p;
  assert.deepEqual(audio.played, ['好的，已經往回三句。']);
  await sp.say('……');
});

// ---------------------------------------------------------------- choosing between the engines
class StubNarrator extends EventTarget {
  constructor() { super(); this.calls = []; this.idx = 0; this.playing = false; }
  load(s, l, i) { this.calls.push(['load', i]); this.idx = i; this.playing = false; }
  hardStop() { this.calls.push(['hardStop']); this.playing = false; }
  play(from = this.idx) { this.calls.push(['play', from]); this.idx = from; this.playing = true; }
  pause() { this.calls.push(['pause']); this.playing = false; }
  seek(i) { this.calls.push(['seek', i]); this.idx = i; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

function hubFixture({ want = false, canFallBack = true } = {}) {
  const state = { want };
  const engine = new VoiceEngine(() => state.want, { canFallBack: () => canFallBack });
  const device = new StubNarrator(), server = new StubNarrator();
  const hub = new NarratorHub(device, server, engine);
  const seen = [], fallbacks = [];
  for (const type of ['index', 'state', 'end', 'blocked', 'error']) hub.addEventListener(type, (e) => seen.push([type, e.detail]));
  engine.addEventListener('fallback', (e) => fallbacks.push(e.detail));
  return { state, engine, device, server, hub, seen, fallbacks };
}

test('the app hears only the engine in use', () => {
  const f = hubFixture();
  f.hub.load(['a', 'b', 'c'], 'zh-TW', 2);
  assert.deepEqual(f.device.calls.at(-1), ['load', 2]);
  f.server.emit('index', 7); f.device.emit('index', 2);
  assert.deepEqual(f.seen, [['index', 2]]);
});

test('choosing the server voices moves the book to them at the same position', () => {
  const f = hubFixture();
  f.hub.load(['a', 'b', 'c'], 'zh-TW', 1);
  f.hub.play(); // the phone's voices
  f.device.idx = 2;
  f.state.want = true;
  f.hub.refresh(); // the settings screen changed the engine while it was reading
  assert.equal(f.hub.kind, 'server');
  assert.deepEqual(f.server.calls, [['load', 2], ['play', 2]]);
  assert.ok(f.device.calls.some((c) => c[0] === 'hardStop'));
  f.server.emit('index', 3);
  assert.deepEqual(f.seen.at(-1), ['index', 3]);
  assert.equal(f.hub.idx, 2);
});

test('when the server voices fail the phone\'s voices carry on from the same unit, the app is told once, and the error is not shown as an error', () => {
  const f = hubFixture({ want: true });
  f.hub.load(['a', 'b', 'c'], 'zh-TW', 0);
  assert.equal(f.hub.kind, 'server');
  f.hub.play();
  f.server.idx = 1; f.server.playing = false;
  f.server.emit('error', 'no credit left');
  assert.equal(f.hub.kind, 'device');
  assert.deepEqual(f.fallbacks, ['no credit left']);
  assert.deepEqual(f.device.calls.slice(-2), [['load', 1], ['play', 1]]);
  assert.ok(!f.seen.some(([type]) => type === 'error'));
  f.server.emit('error', 'again'); // the server is no longer in use: ignored
  assert.equal(f.fallbacks.length, 1);
  f.hub.play(); // still the phone's voices, although the setting says server
  assert.equal(f.hub.kind, 'device');
  f.engine.retry(); // the listener chose an engine again
  f.hub.refresh();
  assert.equal(f.hub.kind, 'server');
});

test('with no phone voices to fall back on the error is shown as one', () => {
  const f = hubFixture({ want: true, canFallBack: false });
  f.hub.load(['a'], 'zh-TW', 0);
  f.hub.play();
  f.server.emit('error', 'offline');
  assert.deepEqual(f.seen.at(-1), ['error', 'offline']);
  assert.equal(f.hub.kind, 'server');
  assert.deepEqual(f.fallbacks, []);
});

test('answers: the engine is chosen when an answer begins, and cancelling cancels both', async () => {
  const mk = (name) => ({ name, calls: [], spoken: 0, begin() { this.calls.push('begin'); return Promise.resolve(true); }, push(t) { this.calls.push(`push:${t}`); }, finish() { this.calls.push('finish'); }, cancel() { this.calls.push('cancel'); }, async say(t) { this.calls.push(`say:${t}`); } });
  const state = { want: false };
  const engine = new VoiceEngine(() => state.want, { canFallBack: () => true });
  const device = mk('device'), server = mk('server');
  const hub = new AnswerHub(device, server, engine);
  await hub.begin(); hub.push('a'); hub.finish();
  assert.deepEqual(device.calls, ['begin', 'push:a', 'finish']);
  state.want = true;
  await hub.begin(); hub.push('b');
  assert.deepEqual(server.calls, ['begin', 'push:b']);
  await hub.say('c');
  assert.equal(server.calls.at(-1), 'say:c');
  hub.cancel();
  assert.equal(device.calls.at(-1), 'cancel'); assert.equal(server.calls.at(-1), 'cancel');
});
