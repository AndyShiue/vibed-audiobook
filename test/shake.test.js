// Shake detection on synthetic accelerometer traces (60 Hz, m/s², gravity on the z axis like a phone lying flat).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ShakeDetector, SHAKE_PRESETS } from '../public/js/shake.js';

const HZ = 60;
/** Runs a trace and returns the times (ms) at which the detector reported a shake. */
function run(detector, seconds, fn, startMs = 0) {
  const hits = [];
  for (let i = 0; i < seconds * HZ; i++) {
    const t = i / HZ;
    const [x, y, z] = fn(t);
    if (detector.push(x, y, z, startMs + t * 1000)) hits.push(Math.round(startMs + t * 1000));
  }
  return hits;
}
const rest = () => [0.1, 0.2, 9.8];
const still = (detector, seconds = 1) => run(detector, seconds, rest);

test('a real shake (back and forth, ~4 Hz, strong) is detected within about half a second', () => {
  const d = new ShakeDetector(SHAKE_PRESETS.normal);
  still(d);
  const hits = run(d, 1.5, (t) => [35 * Math.sin(2 * Math.PI * 4 * t), 2, 9.8], 1000);
  assert.equal(hits.length, 1, 'exactly one trigger for one shake');
  assert.ok(hits[0] - 1000 < 700, `detected after ${hits[0] - 1000} ms`);
});

test('a phone lying still or held normally never triggers, even with slow rotation (gravity moving between axes)', () => {
  const d = new ShakeDetector(SHAKE_PRESETS.high);
  assert.deepEqual(still(d, 5), []);
  // slowly tilting the phone from flat to upright over 3 s: gravity swings from z to y
  const tilt = run(d, 3, (t) => [0, 9.8 * Math.sin((t / 3) * Math.PI / 2), 9.8 * Math.cos((t / 3) * Math.PI / 2)], 5000);
  assert.deepEqual(tilt, []);
});

test('walking with the phone in a pocket does not trigger (one same-direction spike per step)', () => {
  for (const preset of ['normal', 'high']) {
    const d = new ShakeDetector(SHAKE_PRESETS[preset]);
    still(d);
    // 2 steps/s: a sharp upward spike of ~14 m/s² each, with a weak rebound
    const walk = run(d, 8, (t) => { const ph = (t * 2) % 1; return [0.5, 0.5, 9.8 + (ph < 0.12 ? 14 * Math.sin((ph / 0.12) * Math.PI) : -1.5 * Math.sin(ph * Math.PI))]; }, 1000);
    assert.deepEqual(walk, [], `preset ${preset}`);
  }
});

test('a single bump (putting the phone down, a knock) does not trigger', () => {
  const d = new ShakeDetector(SHAKE_PRESETS.high);
  still(d);
  const bump = run(d, 2, (t) => [t > 0.5 && t < 0.56 ? 60 : 0, 0, 9.8], 1000);
  assert.deepEqual(bump, []);
});

test('a gentle wave is below the threshold at normal sensitivity but counts at high sensitivity', () => {
  const gentle = (t) => [13 * Math.sin(2 * Math.PI * 4 * t), 0, 9.8];
  const normal = new ShakeDetector(SHAKE_PRESETS.normal); still(normal);
  assert.deepEqual(run(normal, 2, gentle, 1000), []);
  const high = new ShakeDetector(SHAKE_PRESETS.high); still(high);
  assert.equal(run(high, 2, gentle, 1000).length >= 1, true);
});

test('low sensitivity needs a vigorous shake', () => {
  const moderate = (t) => [20 * Math.sin(2 * Math.PI * 4 * t), 0, 9.8];
  const low = new ShakeDetector(SHAKE_PRESETS.low); still(low);
  assert.deepEqual(run(low, 2, moderate, 1000), []);
  const strong = (t) => [45 * Math.sin(2 * Math.PI * 4 * t), 0, 9.8];
  const low2 = new ShakeDetector(SHAKE_PRESETS.low); still(low2);
  assert.equal(run(low2, 2, strong, 1000).length, 1);
});

test('after a trigger there is a cool-down, so one long shake does not start several questions', () => {
  const d = new ShakeDetector({ ...SHAKE_PRESETS.normal, cooldownMs: 2500 });
  still(d);
  const hits = run(d, 4, (t) => [35 * Math.sin(2 * Math.PI * 4 * t), 0, 9.8], 1000);
  assert.ok(hits.length >= 1 && hits.length <= 2, `hits: ${hits}`);
  if (hits.length === 2) assert.ok(hits[1] - hits[0] >= 2500);
});

test('the shake works in any orientation (phone upright, shaken along its long axis)', () => {
  const d = new ShakeDetector(SHAKE_PRESETS.normal);
  run(d, 1, () => [0, 9.8, 0.2]);
  const hits = run(d, 1.5, (t) => [0.3, 9.8 + 35 * Math.sin(2 * Math.PI * 4 * t), 0.2], 1000);
  assert.equal(hits.length, 1);
});
