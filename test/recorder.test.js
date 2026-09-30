// The recorder has to decide by itself when a spoken question is over. These tests drive the pure decision
// logic with synthetic loudness curves (RMS samples every 50 ms).
import test from 'node:test';
import assert from 'node:assert/strict';
import { VadTracker } from '../public/js/recorder.js';

/** Feed a curve [{ms, rms}] in 50 ms steps and return {verdict, at}. */
function run(vad, segments) {
  let t = 0;
  for (const seg of segments) {
    for (let done = 0; done < seg.ms; done += 50, t += 50) {
      const verdict = vad.push(seg.rms + (seg.wobble ? Math.sin(t) * seg.wobble : 0), t);
      if (verdict !== 'continue') return { verdict, at: t };
    }
  }
  return { verdict: 'continue', at: t };
}

test('speech followed by a pause ends the recording about silenceMs later', () => {
  const r = run(new VadTracker(), [{ ms: 400, rms: 0.004 }, { ms: 2200, rms: 0.18, wobble: 0.08 }, { ms: 4000, rms: 0.004 }]);
  assert.equal(r.verdict, 'end');
  assert.ok(r.at >= 400 + 2200 + 1400 && r.at <= 400 + 2200 + 1700, `ended at ${r.at}`);
});

test('a short thinking pause inside the question does not cut it off', () => {
  const r = run(new VadTracker(), [
    { ms: 300, rms: 0.004 }, { ms: 1500, rms: 0.15 }, { ms: 900, rms: 0.005 }, // pause well below silenceMs
    { ms: 1500, rms: 0.15 }, { ms: 5000, rms: 0.004 },
  ]);
  assert.equal(r.verdict, 'end');
  assert.ok(r.at > 300 + 1500 + 900 + 1500, 'must have kept recording through the pause');
});

test('nobody speaking → no-speech after noSpeechMs', () => {
  const r = run(new VadTracker({ noSpeechMs: 6000 }), [{ ms: 20000, rms: 0.005, wobble: 0.002 }]);
  assert.equal(r.verdict, 'no-speech');
  assert.ok(r.at >= 6000 && r.at < 6200);
});

test('a single cough / click is not treated as a question', () => {
  const vad = new VadTracker({ noSpeechMs: 5000 });
  const r = run(vad, [{ ms: 600, rms: 0.005 }, { ms: 100, rms: 0.3 }, { ms: 20000, rms: 0.005 }]);
  assert.equal(r.verdict, 'no-speech');
  assert.equal(vad.spoke, false);
});

test('steady background noise is learned as the floor, speech above it still counts', () => {
  const noisy = 0.03; // fan / street noise
  const vad = new VadTracker();
  const r = run(vad, [{ ms: 500, rms: noisy }, { ms: 2000, rms: 0.22, wobble: 0.06 }, { ms: 5000, rms: noisy }]);
  assert.equal(r.verdict, 'end');
  assert.ok(vad.spoke);
});

test('already talking when the mic opens (right after the beep) is still detected', () => {
  const vad = new VadTracker();
  const r = run(vad, [{ ms: 2000, rms: 0.2, wobble: 0.05 }, { ms: 4000, rms: 0.004 }]);
  assert.equal(r.verdict, 'end');
  assert.ok(vad.spoke);
});

test('endless talking is capped at maxMs', () => {
  const r = run(new VadTracker({ maxMs: 8000 }), [{ ms: 60000, rms: 0.2, wobble: 0.05 }]);
  assert.equal(r.verdict, 'max');
  assert.ok(r.at >= 8000 && r.at < 8200);
});

test('level meter stays within 0..1', () => {
  const vad = new VadTracker();
  for (let t = 0; t < 1000; t += 50) { vad.push(t % 200 ? 0.9 : 0, t); assert.ok(vad.level >= 0 && vad.level <= 1); }
});
