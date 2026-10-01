// "Shake the phone to ask": the glue around shake.js (public/js/shake.js), tested with the REAL shake.js from node_modules, a fake
// window and simulated accelerometer readings (m/s², gravity on the z axis like a phone lying flat), on a virtual clock.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ShakeListener, scaledThreshold, REFERENCE_HZ, SHAKE_MIN, SHAKE_MAX, SHAKE_DEFAULT, clampThreshold, thresholdFromSlider, sliderFromThreshold, formatThreshold } from '../public/js/shake.js';

const require = createRequire(import.meta.url);

function fakeWindow(extra = {}) {
  const win = new EventTarget();
  win.document = { createEvent: () => { const e = new Event('shake'); e.initEvent = () => {}; return e; } }; // what shake.js asks of a document
  win.ondevicemotion = null;
  win.DeviceMotionEvent = class {};
  return Object.assign(win, extra);
}

/** Installs a fake window and the virtual clock, loads a fresh copy of the real shake.js, runs `fn`, and puts everything back. */
async function withShake(extra, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const win = fakeWindow(extra);
  globalThis.window = win;
  mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  try {
    delete require.cache[require.resolve('shake.js')];
    return await fn({ win, Shake: require('shake.js') });
  } finally {
    mock.timers.reset();
    if (had) Object.defineProperty(globalThis, 'window', had); else delete globalThis.window;
  }
}

let seed = 11;
const noise = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5; };
const rest = (hz, seconds) => Array.from({ length: Math.round(hz * seconds) }, () => [0.1 + noise() * 0.3, 0.2 + noise() * 0.3, 9.8 + noise() * 0.3]);
/** A hand shake of `amp` m/s² at `freq` Hz for `dur` s, building up and dying down, along `dir` (normalised). */
function shake(amp, freq, dur, hz, dir = [1, 0.7, 0.4]) {
  const n = Math.hypot(...dir), u = dir.map((c) => c / n);
  return Array.from({ length: Math.round(dur * hz) }, (_, i) => {
    const t = i / hz, env = Math.min(1, 0.3 + t * 4, (dur - t) * 6);
    const a = amp * env * Math.sin(2 * Math.PI * freq * t);
    return [0.1 + u[0] * a + noise() * 0.3, 0.2 + u[1] * a + noise() * 0.3, 9.8 + u[2] * a + noise() * 0.3];
  });
}

/** A listener on the real shake.js, with a feeder that sends readings at `hz` (a whole number of ms apart) and returns the shakes it reported. */
async function rig(win, Shake, { threshold = SHAKE_DEFAULT, hz = 50, ...opts } = {}) {
  const shakes = [], statuses = [];
  const l = new ShakeListener({ Shake, now: () => Date.now(), onShake: () => shakes.push(Date.now()), onStatus: (s) => statuses.push(s), ...opts });
  assert.equal(await l.start({ threshold }), 'waiting');
  const dt = 1000 / hz;
  const feed = async (samples) => {
    for (const [x, y, z] of samples) {
      mock.timers.tick(dt);
      const e = new Event('devicemotion'); e.accelerationIncludingGravity = { x, y, z };
      win.dispatchEvent(e);
      if (!l.lib) await Promise.resolve(); // shake.js is started on the first real reading
    }
  };
  return { l, feed, shakes, statuses, hz };
}

/** Does a rest + this shake make the listener report a shake? */
async function triggers({ threshold, amp, freq = 3.5, hz = 50, dir, dur = 1.6 }) {
  return withShake({}, async ({ win, Shake }) => {
    const r = await rig(win, Shake, { threshold, hz });
    await r.feed(rest(hz, 1.2));
    await r.feed(shake(amp, freq, dur, hz, dir));
    await r.feed(rest(hz, 0.5));
    return r.shakes.length;
  });
}

// ---------------------------------------------------------------- what each number takes (measured on the real shake.js)
test('what the number takes: 2.5 reacts to a light shake, 3.5 to a casual one, 6 wants a vigorous one', async () => {
  for (const freq of [2.5, 3.5, 4.5]) {
    // (the change between two readings grows with the frequency, so a slow 2.5 Hz shake needs about 40% more than a usual 3.5 Hz one)
    assert.ok(await triggers({ threshold: 2.5, amp: 22, freq }) >= 1, `2.5, 22 m/s² at ${freq} Hz`);
    assert.equal(await triggers({ threshold: 2.5, amp: 6, freq }), 0, `2.5, 6 m/s² at ${freq} Hz is just handling the phone`);
    assert.ok(await triggers({ threshold: 3.5, amp: 30, freq }) >= 1, `3.5, 30 m/s² at ${freq} Hz`);
    assert.equal(await triggers({ threshold: 3.5, amp: 9, freq }), 0, `3.5, 9 m/s² at ${freq} Hz`);
    assert.ok(await triggers({ threshold: 6, amp: 50, freq }) >= 1, `6, 50 m/s² at ${freq} Hz`);
    assert.equal(await triggers({ threshold: 6, amp: 18, freq }), 0, `6, 18 m/s² at ${freq} Hz`);
  }
  // at the usual 3.5 Hz: 2.5 from about 12 m/s², 3.5 about 17, 6 about 30
  for (const [threshold, light, enough] of [[2.5, 9, 15], [3.5, 12, 21], [6, 22, 36]]) {
    assert.equal(await triggers({ threshold, amp: light, freq: 3.5 }), 0, `${threshold}, ${light} m/s² at 3.5 Hz`);
    assert.ok(await triggers({ threshold, amp: enough, freq: 3.5 }) >= 1, `${threshold}, ${enough} m/s² at 3.5 Hz`);
  }
});

test('the phone\'s own rate is taken into account: the same shake works whether it reports 25, 50 or 100 times a second', async () => {
  for (const hz of [25, 50, 100]) assert.ok(await triggers({ threshold: 3.5, amp: 26, hz }) >= 1, `${hz} Hz`);
  for (const hz of [25, 50, 100]) assert.equal(await triggers({ threshold: 3.5, amp: 8, hz }), 0, `${hz} Hz, handling`);
  // shake.js alone, with its default threshold of 15, would need a violent shake on a 50 Hz phone: that is what the scaling is for
  assert.equal(await withShake({}, async ({ win, Shake }) => {
    const lib = new Shake({ threshold: 15, timeout: 2500 });
    let n = 0; win.addEventListener('shake', () => n++);
    lib.start();
    for (const [x, y, z] of [...rest(50, 1), ...shake(26, 3.5, 1.6, 50)]) { mock.timers.tick(20); const e = new Event('devicemotion'); e.accelerationIncludingGravity = { x, y, z }; win.dispatchEvent(e); }
    return n;
  }), 0);
});

test('the threshold is the preset scaled by the rate (the presets are for 60 readings a second)', () => {
  assert.equal(REFERENCE_HZ, 60);
  assert.equal(scaledThreshold(3.5, 60), 3.5);
  assert.equal(scaledThreshold(3.5, 30), 7);
  assert.equal(scaledThreshold(3.5, 120), 1.75);
  assert.equal(scaledThreshold(3.5, 5), 14, 'a rate that low is taken as 15');
  assert.equal(scaledThreshold(3.5, 500), 1.75, 'and one that high as 120');
  assert.equal(scaledThreshold(3.5, 0), 3.5, 'no rate known yet: 60');
});

test('after a shake nothing counts for 2.5 seconds, so one long shake starts one question', async () => {
  await withShake({}, async ({ win, Shake }) => {
    const r = await rig(win, Shake, { threshold: 3.5 });
    await r.feed(rest(50, 1.2));
    await r.feed(shake(26, 3.5, 4, 50));
    assert.ok(r.shakes.length >= 1 && r.shakes.length <= 2, `shakes: ${r.shakes.length}`);
    if (r.shakes.length === 2) assert.ok(r.shakes[1] - r.shakes[0] >= 2500);
  });
});

test('what shake.js counts as a shake: one hard jolt is enough (6 needs a harder one), and motion along a single direction is not', async () => {
  const jolt = (amp) => shake(amp, 4, 0.25, 50);
  const count = (threshold, trace) => withShake({}, async ({ win, Shake }) => {
    const r = await rig(win, Shake, { threshold });
    await r.feed(rest(50, 1.2)); await r.feed(trace); await r.feed(rest(50, 1));
    return r.shakes.length;
  });
  assert.equal(await count(3.5, jolt(30)), 1, 'a single jolt at 3.5');
  assert.equal(await count(6, jolt(30)), 0);
  assert.equal(await count(3.5, shake(60, 3.5, 1.6, 50, [1, 0, 0])), 0, 'a shake along one axis only');
  assert.equal(await count(2.5, shake(60, 3.5, 1.6, 50, [0, 0, 1])), 0);
  assert.ok(await count(3.5, shake(26, 3.5, 1.6, 50, [1, 1, 0])) >= 1, 'two axes at once is enough');
});

// ---------------------------------------------------------------- the glue
test('shake.js is started with the first real reading: a computer\'s empty event does not reach it', async () => {
  await withShake({}, async ({ win, Shake }) => {
    let created = 0;
    class Counting extends Shake { constructor(o) { super(o); created++; } }
    const l = new ShakeListener({ Shake: Counting, now: () => Date.now() });
    await l.start();
    const empty = new Event('devicemotion'); empty.accelerationIncludingGravity = null;
    assert.doesNotThrow(() => win.dispatchEvent(empty));
    await Promise.resolve();
    assert.equal(created, 0);
    assert.equal(l.lib, null);
    const real = new Event('devicemotion'); real.accelerationIncludingGravity = { x: 0.1, y: 0.2, z: 9.8 };
    win.dispatchEvent(real);
    await Promise.resolve();
    assert.equal(created, 1);
    assert.equal(l.lib.options.timeout, 2500);
    l.stop();
    assert.equal(l.lib, null);
  });
});

test('stopping really stops: no more shakes, and the number can be changed while listening', async () => {
  await withShake({}, async ({ win, Shake }) => {
    const r = await rig(win, Shake, { threshold: 6 });
    await r.feed(rest(50, 1.2));
    r.l.setThreshold(2.5);
    assert.equal(r.l.threshold, scaledThreshold(2.5, r.l.rate()), `threshold ${r.l.threshold}`);
    assert.ok(Math.abs(r.l.threshold - 3) < 0.2, 'about 2.5 × 60 / 50');
    assert.equal(r.l.lib.options.threshold, r.l.threshold, 'the running shake.js got the new threshold');
    r.l.stop();
    await r.feed(shake(40, 3.5, 1.6, 50));
    assert.equal(r.shakes.length, 0);
  });
});

test('a page that was not opened over HTTPS gets no motion data from a phone: the settings screen says so', async () => {
  await withShake({ isSecureContext: false }, async () => {
    const statuses = [];
    const l = new ShakeListener({ onStatus: (s) => statuses.push(s) });
    assert.equal(await l.start(), 'insecure');
    assert.deepEqual(statuses, ['insecure']);
    assert.equal(l.active, false);
  });
  await withShake({ isSecureContext: true }, async ({ Shake }) => {
    const l = new ShakeListener({ Shake });
    assert.equal(await l.start(), 'waiting');
    l.stop();
  });
  await withShake({ isSecureContext: true }, async () => {
    delete globalThis.window.DeviceMotionEvent;
    assert.equal(await new ShakeListener().start(), 'unsupported');
  });
});

test('a browser that answers the permission request with "denied" but still delivers motion works; an iPhone that refused does not', async () => {
  class Asking { static requestPermission() { return Promise.resolve('denied'); } }
  await withShake({ isSecureContext: true, DeviceMotionEvent: Asking }, async ({ win, Shake }) => {
    const l = new ShakeListener({ Shake });
    const started = l.start({ askPermission: true });
    setTimeout(() => { const e = new Event('devicemotion'); e.accelerationIncludingGravity = { x: 0.1, y: 0.2, z: 9.8 }; win.dispatchEvent(e); }, 50);
    assert.equal(await started, 'waiting');
    assert.equal(l.active, true);
    l.stop();
  });
  await withShake({ isSecureContext: true, DeviceMotionEvent: Asking }, async ({ Shake }) => {
    const statuses = [];
    const l = new ShakeListener({ Shake, onStatus: (s) => statuses.push(s) });
    assert.equal(await l.start({ askPermission: true }), 'denied');
    assert.deepEqual(statuses, ['denied']);
    assert.equal(l.active, false);
  });
});

test('if shake.js cannot be loaded the settings screen says so, instead of failing silently', async () => {
  await withShake({}, async ({ win }) => {
    const statuses = [];
    class Broken { constructor() { throw new Error('no'); } }
    const l = new ShakeListener({ Shake: Broken, now: () => Date.now(), onStatus: (s) => statuses.push(s) });
    await l.start();
    const e = new Event('devicemotion'); e.accelerationIncludingGravity = { x: 0.1, y: 0.2, z: 9.8 };
    win.dispatchEvent(e);
    await Promise.resolve(); await Promise.resolve();
    assert.ok(statuses.includes('load-failed'), statuses.join());
  });
});

test('the meter: readings a second, how big the latest change is as shake.js sees it, and what a shake takes', async () => {
  await withShake({}, async ({ win, Shake }) => {
    const r = await rig(win, Shake, { threshold: 3.5 });
    await r.feed(rest(50, 1.5));
    let s = r.l.stats();
    assert.ok(s.hz >= 49 && s.hz <= 51, `hz ${s.hz}`);
    assert.ok(s.peak < 1, `peak at rest ${s.peak}`);
    assert.ok(Math.abs(s.need - 4.2) < 0.2, `need ${s.need}`); // 3.5 × 60 / 50
    await r.feed([[12, 9, 14], [0.1, 0.2, 9.8]]); // one hard jolt: three axes jump
    s = r.l.stats();
    assert.ok(s.peak > 8, `peak after a jolt ${s.peak}`); // the second-biggest change, which is what shake.js needs two axes for
    assert.equal(r.l.stats(Date.now() + 5000).peak, 0, 'the peak fades after a moment');
    r.l.stop();
  });
});

// ---------------------------------------------------------------- the number the listener sets (2–50)
test('the sensitivity is a number from 2 to 50: anything else is brought back into that range', () => {
  assert.equal(SHAKE_MIN, 2); assert.equal(SHAKE_MAX, 50); assert.equal(SHAKE_DEFAULT, 10);
  assert.equal(clampThreshold(1), 2); assert.equal(clampThreshold(0), 2); assert.equal(clampThreshold(-5), 2);
  assert.equal(clampThreshold(51), 50); assert.equal(clampThreshold(1e9), 50);
  assert.equal(clampThreshold(12.5), 12.5); assert.equal(clampThreshold('7'), 7);
  assert.equal(clampThreshold(undefined), 10); assert.equal(clampThreshold('x'), 10); assert.equal(clampThreshold(NaN), 10);
});

test('the slider is logarithmic so the useful low end (2–10) is easy to hit; the number shown is the number kept', () => {
  assert.equal(thresholdFromSlider(0), 2);
  assert.equal(thresholdFromSlider(1000), 50);
  assert.equal(sliderFromThreshold(2), 0);
  assert.equal(sliderFromThreshold(50), 1000);
  for (const v of [3.5, SHAKE_DEFAULT]) assert.equal(thresholdFromSlider(sliderFromThreshold(v)), v, `${v} survives a trip to the slider and back`);
  for (const v of [2, 2.5, 3, 4, 6, 8, 10, 15, 25, 40, 50]) assert.ok(Math.abs(thresholdFromSlider(sliderFromThreshold(v)) - v) <= (v < 10 ? 0.1 : 1), `${v}`);
  let last = 0;
  for (let pos = 0; pos <= 1000; pos++) { const v = thresholdFromSlider(pos); assert.ok(v >= last && v >= 2 && v <= 50, `position ${pos}`); last = v; }
  assert.ok(sliderFromThreshold(10) > 450 && sliderFromThreshold(10) < 550, 'between 2 and 10 lies half of the slider');
  assert.equal(formatThreshold(3.46), '3.5'); assert.equal(formatThreshold(12.4), '12'); assert.equal(formatThreshold(2), '2.0'); assert.equal(formatThreshold(50), '50');
  assert.equal(thresholdFromSlider('abc'), 2); assert.equal(thresholdFromSlider(5000), 50);
});

test('a bigger number needs a harder shake, all the way up: at 50 nothing a hand does gets there', async () => {
  const smallest = async (threshold) => {
    for (const amp of [6, 8, 10, 13, 17, 22, 28, 36, 46, 60, 80, 110, 160, 240]) if (await triggers({ threshold, amp, hz: 100 }) >= 1) return amp;
    return Infinity;
  };
  const needs = [];
  for (const th of [2, 3.5, 6, 12, 25]) needs.push(await smallest(th));
  for (let i = 1; i < needs.length; i++) assert.ok(needs[i] > needs[i - 1], `needs ${needs.join(' < ')}`);
  assert.ok(needs[0] <= 17, `at 2 an ordinary shake is enough (${needs[0]})`);
  assert.equal(await triggers({ threshold: 50, amp: 110, hz: 100 }), 0, 'a shake of 11 g at 50');
});

test('the stream stopping for a moment does not change the threshold: the rate is the usual gap between readings, not a count', async () => {
  await withShake({}, async ({ win, Shake }) => {
    const r = await rig(win, Shake, { threshold: 3.5 });
    await r.feed(rest(50, 1.5));
    const before = r.l.threshold;
    assert.equal(r.l.rate(), 50);
    mock.timers.tick(900); // nothing arrives for most of a second
    await r.feed(rest(50, 0.1));
    r.l.setThreshold(3.5); // forces a new calculation
    assert.equal(r.l.rate(), 50);
    assert.ok(Math.abs(r.l.threshold - before) < 0.3, `${r.l.threshold} vs ${before}`);
  });
});

test('the default (10) takes a very vigorous shake — about 5 g — and 3.5 or less is where an ordinary shake starts to count', async () => {
  assert.equal(await triggers({ threshold: SHAKE_DEFAULT, amp: 35 }), 0, 'a hard shake of 3.5 g does not reach 10');
  assert.ok(await triggers({ threshold: SHAKE_DEFAULT, amp: 70 }) >= 1, 'a shake of 7 g does');
  assert.ok(await triggers({ threshold: 3.5, amp: 30 }) >= 1);
});
