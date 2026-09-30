// Regression tests for spoken answers, using a fake speech engine and virtual time.
// Bug this guards against: every sentence's time-out started when it was *queued*, so in a long answer the
// later sentences "timed out" before their turn, the answer was reported finished while the engine was still
// talking, and the audiobook resuming cut the rest of the answer off.
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AnswerSpeaker, SentenceStream } from '../public/js/tts.js';

const settings = { rate: 1, answerPitch: 1, voiceURI: {}, answerVoiceURI: {} };

/** A speech engine that speaks one utterance at a time; each takes `msPerChar` per character. */
function installFakeEngine({ msPerChar = 200, dropFirstStart = false, neverEnd = new Set() } = {}) {
  const engine = { queue: [], current: null, timer: null, spoken: [], cancels: 0, maxQueued: 0, dropped: false };
  const synth = {
    speaking: false, pending: false,
    getVoices: () => [], addEventListener() {}, removeEventListener() {},
    speak(u) {
      engine.queue.push(u);
      engine.maxQueued = Math.max(engine.maxQueued, engine.queue.length + (engine.current ? 1 : 0));
      synth.pending = engine.queue.length > 0;
      pump();
    },
    cancel() {
      clearTimeout(engine.timer);
      engine.queue.length = 0; engine.current = null;
      synth.speaking = false; synth.pending = false;
      engine.cancels++;
    },
  };
  function pump() {
    if (engine.current || !engine.queue.length) return;
    const u = engine.queue.shift();
    synth.pending = engine.queue.length > 0;
    if (dropFirstStart && !engine.dropped) { engine.dropped = true; return; } // accepted but never starts
    engine.current = u;
    synth.speaking = true;
    setTimeout(() => u.onstart?.(), 20);
    engine.timer = setTimeout(() => {
      engine.current = null; synth.speaking = false;
      engine.spoken.push(u.text);
      if (!neverEnd.has(u.text)) u.onend?.();
      pump();
    }, 20 + u.text.length * msPerChar);
  }
  globalThis.speechSynthesis = synth;
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  return engine;
}

afterEach(() => { mock.timers.reset(); delete globalThis.speechSynthesis; delete globalThis.SpeechSynthesisUtterance; });

const advance = (ms, step = 50) => { for (let t = 0; t < ms; t += step) mock.timers.tick(step); };
const sentence = (i) => `這是第${i}句回答，它有一點長度而已。`; // 17 chars
const flush = () => new Promise((r) => setImmediate(r)); // let pending promise callbacks run (timers are mocked)

test('a long answer is reported finished only when the engine has really finished speaking it', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installFakeEngine({ msPerChar: 400 }); // 17 chars → ~6.8 s per sentence, ~48 s in total
  const sp = new AnswerSpeaker(() => settings, () => 'zh-TW');
  let resolved = null, spokenWhenResolved = null;
  const done = sp.begin().then((ok) => { resolved = ok; spokenWhenResolved = engine.spoken.length; });
  for (let i = 1; i <= 7; i++) sp.push(sentence(i));
  sp.finish();
  advance(30_000); // old code declared the answer finished at ~13 s
  await flush();
  assert.equal(resolved, null, 'answer must not be reported finished while sentences are still waiting to be spoken');
  advance(20_000);
  await done;
  assert.equal(resolved, true);
  assert.equal(spokenWhenResolved, 7, 'all 7 sentences were actually spoken before `done` resolved');
  assert.equal(engine.maxQueued <= 2, true, 'at most two utterances are handed to the engine at a time');
  assert.equal(engine.cancels, 1, 'the only cancel is the reset performed by begin()');
});

test('sentences that arrive slowly (streaming) are all spoken; done waits for finish()', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installFakeEngine({ msPerChar: 200 }); // 3 s per sentence
  const sp = new AnswerSpeaker(() => settings, () => 'zh-TW');
  let resolved = false;
  sp.begin().then(() => { resolved = true; });
  sp.push(sentence(1));
  advance(10_000); // engine idle: model is still thinking
  await flush();
  assert.equal(resolved, false, 'must not finish just because the queue is momentarily empty');
  sp.push(sentence(2)); sp.push(sentence(3));
  advance(20_000);
  await flush();
  assert.equal(resolved, false, 'still waiting for finish()');
  sp.finish();
  await flush();
  assert.equal(resolved, true);
  assert.deepEqual(engine.spoken, [sentence(1), sentence(2), sentence(3)]);
});

test('cancel() stops immediately and resolves false; nothing more is spoken', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installFakeEngine({ msPerChar: 400 });
  const sp = new AnswerSpeaker(() => settings, () => 'zh-TW');
  const done = sp.begin();
  for (let i = 1; i <= 5; i++) sp.push(sentence(i));
  advance(7_000); // one sentence done, second in progress
  const cancelsBefore = engine.cancels;
  sp.cancel();
  assert.equal(await done, false);
  assert.equal(engine.cancels, cancelsBefore + 1);
  advance(60_000);
  assert.equal(engine.spoken.length, 1, 'no further sentences after cancel');
});

test('an utterance the engine never starts cannot hang the answer', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installFakeEngine({ msPerChar: 100, dropFirstStart: true });
  const sp = new AnswerSpeaker(() => settings, () => 'zh-TW');
  const done = sp.begin();
  sp.push(sentence(1)); sp.push(sentence(2)); sp.finish();
  advance(30_000);
  assert.equal(await done, true);
  assert.deepEqual(engine.spoken, [sentence(2)], 'the stuck sentence is skipped, the next one is still spoken');
});

test('an utterance that starts but never fires "end" is abandoned after a limit counted from its own start', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installFakeEngine({ msPerChar: 100, neverEnd: new Set([sentence(1)]) });
  const sp = new AnswerSpeaker(() => settings, () => 'zh-TW');
  const done = sp.begin();
  sp.push(sentence(1)); sp.push(sentence(2)); sp.finish();
  advance(40_000);
  assert.equal(await done, true);
  assert.equal(engine.spoken.length, 2);
});

test('say() speaks one short message and resolves when it is done', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const engine = installFakeEngine({ msPerChar: 200 });
  const sp = new AnswerSpeaker(() => settings, () => 'zh-TW');
  let finished = false;
  sp.say('現在沒有網路連線。').then(() => { finished = true; });
  advance(500);
  await flush();
  assert.equal(finished, false);
  advance(5_000);
  await flush();
  assert.equal(finished, true);
  assert.equal(engine.spoken.length, 1);
});

test('SentenceStream cuts long sentences at commas so no single utterance runs for ~15 s', () => {
  const long = '首先' + '這是一段很長很長的說明文字，'.repeat(8) + '最後才結束。';
  const s = new SentenceStream();
  const parts = [...s.push(long), ...s.end()];
  assert.ok(parts.length > 2, `expected several pieces, got ${parts.length}`);
  assert.ok(parts.every((p) => p.length <= 62), `pieces too long: ${parts.map((p) => p.length)}`);
  assert.equal(parts.join('').replace(/[，,]/g, ''), long.replace(/[，,]/g, '').replace(/。$/, '。'));
  const en = new SentenceStream();
  const eParts = [...en.push(('Here is a long English sentence with several clauses, ' .repeat(8)) + 'and it ends here.'), ...en.end()];
  assert.ok(eParts.length > 1 && eParts.every((p) => p.length <= 172));
});
