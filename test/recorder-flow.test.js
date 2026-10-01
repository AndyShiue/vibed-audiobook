// Orchestration tests for VoiceRecorder with a fake microphone, fake MediaRecorder and fake audio graph.
// They pin down the ordering that matters for "the first words of my question are missing":
//   1. recording starts as soon as the microphone is open, and only then is `onReady` (the "go ahead" beep) called
//   2. the beep itself is not mistaken for the speaker's voice
//   3. cancelling while the permission prompt is open leaves nothing recording
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceRecorder } from '../public/js/recorder.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Installs fakes; `level(msSinceOpen)` is the microphone loudness (RMS) as a function of time. */
function install({ micOpenMs = 60, recorderStartMs = 10, level = () => 0.002 } = {}) {
  const log = { events: [], stopped: 0, recorderStartedAt: null, openedAt: null };
  const t0 = performance.now();
  const stamp = (name) => log.events.push([name, Math.round(performance.now() - t0)]);
  class FakeRecorder {
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm;codecs=opus'; }
    static isTypeSupported() { return true; }
    start() { this.state = 'recording'; log.recorderStartedAt = performance.now(); stamp('recorder.start()'); setTimeout(() => this.onstart?.(), recorderStartMs); this.tick = setInterval(() => this.ondataavailable?.({ data: new Blob([new Uint8Array(400)]) }), 100); }
    stop() { this.state = 'inactive'; clearInterval(this.tick); setTimeout(() => { this.ondataavailable?.({ data: new Blob([new Uint8Array(50)]) }); this.onstop?.(); }, 5); }
  }
  const stream = { getTracks: () => [{ stop() { log.stopped++; } }] };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => { await wait(micOpenMs); log.openedAt = performance.now(); stamp('mic open'); return stream; } } } });
  globalThis.MediaRecorder = FakeRecorder;
  const audioContext = {
    state: 'running', resume() {}, close() {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createAnalyser: () => ({ fftSize: 1024, getFloatTimeDomainData(buf) { buf.fill(level(performance.now() - log.openedAt)); } }),
  };
  return { log, ctx: audioContext, stamp };
}

afterEach(() => { delete globalThis.MediaRecorder; Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined }); });

const VAD = { calibrateMs: 100, minSpeechMs: 150, silenceMs: 350, noSpeechMs: 1200, maxMs: 5000 };

test('the ready beep is signalled only after the microphone is open AND recording, never before', async () => {
  const { log, ctx, stamp } = install({ micOpenMs: 250, level: (t) => (t > 600 && t < 1300 ? 0.2 : 0.002) });
  const rec = new VoiceRecorder(() => ctx);
  const result = await rec.record({ vad: VAD, onReady: () => stamp('READY (beep)') });
  const at = Object.fromEntries(log.events.map(([n, t]) => [n, t]));
  assert.ok(at['mic open'] >= 240, 'the fake microphone needs ~250 ms to open');
  assert.ok(at['recorder.start()'] >= at['mic open'], 'recording starts right after the mic opens');
  assert.ok(at['READY (beep)'] > at['recorder.start()'], 'the beep comes after recording has started');
  assert.ok(at['READY (beep)'] - at['mic open'] < 200, `the beep must follow the mic promptly, took ${at['READY (beep)'] - at['mic open']} ms`);
  assert.equal(result.speech, true);
  assert.equal(result.reason, 'end');
  assert.equal(log.stopped, 1, 'the microphone is released');
});

test('speech that starts before the beep has finished is still recorded and counted', async () => {
  // the speaker starts 100 ms after "ready", while the 450 ms ignore window for the beep is still open
  let readyRel = null; // ms since the microphone opened, at the moment the beep was signalled
  const { log, ctx } = install({ level: (t) => (readyRel !== null && t > readyRel + 100 && t < readyRel + 1300 ? 0.2 : 0.002) });
  const rec = new VoiceRecorder(() => ctx);
  const result = await rec.record({ vad: VAD, ignoreMs: 450, onReady: () => { readyRel = performance.now() - log.openedAt; } });
  assert.equal(result.speech, true, 'the utterance continues past the ignore window, so it is detected');
  assert.ok(result.ms > 1200, `the recording covers the whole utterance (${result.ms} ms)`);
});

test('the beep is not mistaken for speech: nothing said → "no speech", nothing to upload', async () => {
  let readyRel = null;
  // loud for 350 ms right after ready = the beep leaking into the microphone; then silence
  const { log, ctx } = install({ level: (t) => (readyRel !== null && t >= readyRel && t < readyRel + 350 ? 0.25 : 0.002) });
  const rec = new VoiceRecorder(() => ctx);
  const withIgnore = await rec.record({ vad: VAD, ignoreMs: 500, onReady: () => { readyRel = performance.now() - log.openedAt; } });
  assert.equal(withIgnore.speech, false);
  assert.equal(withIgnore.reason, 'no-speech');
});

test('cancelling while the permission prompt is still open leaves nothing recording', async () => {
  const { log, ctx } = install({ micOpenMs: 300 });
  const rec = new VoiceRecorder(() => ctx);
  const pending = rec.record({ vad: VAD, onReady: () => assert.fail('must not signal ready after a cancel') });
  await wait(50);
  rec.abort();
  const result = await pending;
  assert.equal(result.error, 'aborted');
  assert.equal(log.stopped, 1, 'the late-arriving microphone is released immediately');
  assert.equal(log.recorderStartedAt, null, 'recording never started');
});

test('tapping to finish delivers what was recorded so far', async () => {
  const { log, ctx } = install({ level: (t) => (t > 200 ? 0.2 : 0.002) });
  const rec = new VoiceRecorder(() => ctx);
  const pending = rec.record({ vad: { ...VAD, silenceMs: 60_000, maxMs: 60_000 }, onReady: () => {} });
  await wait(900);
  rec.stop();
  const result = await pending;
  assert.ok(result.blob.size > 0);
  assert.equal(result.speech, true);
  assert.equal(result.reason, 'manual');
  assert.equal(log.stopped, 1);
});

test('the recorder says whether anything that sounds like speech has been heard yet (a second tap before that goes back to "tap to ask")', async () => {
  let readyRel = null;
  const { log, ctx } = install({ level: (t) => (readyRel !== null && t > readyRel + 500 && t < readyRel + 1500 ? 0.2 : 0.002) });
  const rec = new VoiceRecorder(() => ctx);
  assert.equal(rec.heard, false, 'before anything');
  const pending = rec.record({ vad: VAD, onReady: () => { readyRel = performance.now() - log.openedAt; } });
  await wait(450);
  assert.equal(rec.heard, false, 'the quiet room is not speech');
  await wait(700);
  assert.equal(rec.heard, true, 'the speaker has been talking for a while');
  rec.stop();
  await pending;
  // a cough or a click is not speech
  const quiet = install({ level: (t) => (t > 300 && t < 360 ? 0.3 : 0.002) });
  const rec2 = new VoiceRecorder(() => quiet.ctx);
  const done2 = rec2.record({ vad: VAD });
  await wait(800);
  assert.equal(rec2.heard, false, 'a click of 60 ms');
  rec2.abort();
  await done2;
});
