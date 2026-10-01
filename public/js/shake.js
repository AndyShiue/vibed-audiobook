// "Shake the phone to ask".
//
// The shake itself is detected by shake.js (Alex Gibson, MIT; the npm package "shake.js", copied to public/vendor by
// scripts/vendor.js). This module is the glue around it: the iOS permission prompt, the HTTPS check, a status for the settings
// screen, the sensitivity (a number the listener sets, 2–50), and a live meter.
//
// What shake.js does (read from its source): on every `devicemotion` reading it compares the acceleration with the previous
// reading, and when the change is bigger than `threshold` (m/s²) on at least TWO axes at once, it fires a "shake" event on window
// (at most once per `timeout`). Two things follow, and they shape the settings below:
//   • The change is between two consecutive readings, so it depends on how fast the phone reports. Its default threshold (15) was
//     meant for phones that reported a few times a second; at today's 60 readings a second a shake would have to reach about
//     7–8 g to get there. So the threshold is scaled by the phone's measured rate (PRESETS are for 60 Hz).
//   • One jolt is enough — a single flick, or putting the phone down hard, counts — and a shake along a single axis does not.
// What the number means was measured by feeding the real shake.js simulated shakes (see test/shake.test.js); for a usual 3.5 Hz
// shake: 2.5 reacts to about 12 m/s² (1.2 g), 3.5 to about 17, 6 to about 30, 10 to about 50 (5 g — the default, a very vigorous shake). A slower shake needs more than a quicker one, and
// near the top of the range (50) nothing a hand can do gets there, which is as good as switching the gesture off.
import { loadScript } from './parsers/common.js';

// The sensitivity is shake.js's threshold: how much the acceleration must change (m/s²) between two readings, at 60 readings a
// second — the smaller the number, the easier it triggers. The listener chooses it with a slider.
export const SHAKE_MIN = 2;
export const SHAKE_MAX = 50;
export const SHAKE_DEFAULT = 10;
export const REFERENCE_HZ = 60;

export const clampThreshold = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(SHAKE_MAX, Math.max(SHAKE_MIN, n)) : SHAKE_DEFAULT; };

// Almost everything useful lies between 2 and 10, so the slider is logarithmic: its position (0–1000) maps to 2…50 and back.
const SLIDER_STEPS = 1000;
export const thresholdFromSlider = (pos) => formatThreshold(SHAKE_MIN * (SHAKE_MAX / SHAKE_MIN) ** (Math.min(SLIDER_STEPS, Math.max(0, Number(pos) || 0)) / SLIDER_STEPS), true);
export const sliderFromThreshold = (v) => Math.round((SLIDER_STEPS * Math.log(clampThreshold(v) / SHAKE_MIN)) / Math.log(SHAKE_MAX / SHAKE_MIN));
/** The number as shown (and kept): one decimal below 10, whole above. With `asNumber` the rounded number instead of the text. */
export function formatThreshold(v, asNumber = false) {
  const c = clampThreshold(v);
  const r = c < 10 ? Math.round(c * 10) / 10 : Math.round(c);
  return asNumber ? r : r.toFixed(c < 10 ? 1 : 0);
}
const COOLDOWN_MS = 2500;     // shake.js's "timeout": after a shake nothing counts for this long, so one shake starts one question

/** The threshold for a phone that reports `hz` readings a second: the faster it reports, the smaller the change between two readings. */
export const scaledThreshold = (base, hz) => (base * REFERENCE_HZ) / Math.min(120, Math.max(15, hz || REFERENCE_HZ));

const hasMotion = () => typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
const needsPermission = () => hasMotion() && typeof window.DeviceMotionEvent.requestPermission === 'function'; // iOS 13+

async function loadShakeLib() {
  if (!window.Shake) await loadScript('/vendor/shake.js');
  return window.Shake;
}

export class ShakeListener {
  /**
   * @param onShake   ()=>void
   * @param onStatus  (status)=>void  status: ok | waiting | none | denied | unsupported | needs-permission | insecure | load-failed
   * @param Shake     the shake.js class (loaded from /vendor/shake.js when not given)
   * @param now       ()=>ms  the clock the meter uses
   */
  constructor({ onShake = () => {}, onStatus = () => {}, Shake = null, now = () => performance.now() } = {}) {
    this.onShake = onShake;
    this.onStatus = onStatus;
    this.Shake = Shake;
    this.now = now;
    this.base = SHAKE_DEFAULT;       // the threshold the listener chose (for 60 readings a second)
    this.threshold = SHAKE_DEFAULT;  // ...as it is for this phone's rate
    this.lib = null;                 // the shake.js instance, started with the first real reading
    this.handler = (e) => this.onMotion(e);
    this.shakeHandler = () => { if (this.active) this.onShake(); };
    this.active = false;
    this.gotData = false;
    this.timer = null;
    this.times = [];                 // when the readings of the last second arrived (the meter counts them)
    this.gaps = [];                  // the time between the latest readings (the phone's rate is their median, so a pause does not skew it)
    this.last = null;
    this.prev = null;                // the previous reading
    this.jolt = 0;                   // the latest change between readings, as shake.js sees it
    this.peak = 0; this.peakAt = -Infinity;
    this.tunedAt = -Infinity;
  }

  setThreshold(value) {
    this.base = clampThreshold(value);
    this.tune(true);
  }

  /** Sets the threshold from the listener's choice and the phone's rate (the rate is only known after a second or so of readings). */
  tune(force = false) {
    const now = this.now();
    if (!force && now - this.tunedAt < 500) return;
    this.tunedAt = now;
    this.threshold = scaledThreshold(this.base, this.rate());
    if (this.lib) this.lib.options.threshold = this.threshold;
  }

  /** The phone's rate in readings a second: from the usual gap between readings, so the stream stopping for a moment does not change it. 0 until known. */
  rate() {
    if (this.gaps.length < 10) return 0;
    const sorted = [...this.gaps].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    return median > 0 ? Math.round(1000 / median) : 0;
  }

  /** Readings that arrived in the last second. */
  hz(now = this.now()) {
    while (this.times.length && now - this.times[0] > 1000) this.times.shift();
    return this.times.length;
  }

  /** What the settings screen shows live: readings a second, the latest and the recent biggest change, and what a shake takes. */
  stats(now = this.now()) {
    const hz = this.hz(now);
    return { hz, now: this.active && hz ? this.jolt : 0, peak: now - this.peakAt < 1500 ? this.peak : 0, need: this.threshold, rate: this.rate() };
  }

  /**
   * Start listening. On iOS the permission prompt may only be shown from a tap, so pass askPermission:true only
   * from a click handler; at page load call it without and, if it reports 'needs-permission', ask on the next tap.
   */
  async start({ threshold = SHAKE_DEFAULT, askPermission = false } = {}) {
    this.setThreshold(threshold);
    if (!hasMotion()) { this.onStatus('unsupported'); return 'unsupported'; }
    // phones give a page no motion data unless it was opened over HTTPS (localhost counts as secure)
    if (typeof window !== 'undefined' && window.isSecureContext === false) { this.onStatus('insecure'); return 'insecure'; }
    if (needsPermission() && askPermission) {
      let result = 'denied';
      try { result = await window.DeviceMotionEvent.requestPermission(); } catch { /* not from a gesture, or refused */ }
      // Chrome has no such permission, yet newer versions (and embedded browsers) define the function and may answer "denied" while
      // the sensor works all the same: only an iPhone that really refused stays silent, so listen for a moment before giving up.
      if (result !== 'granted' && !(await this.probe(1200))) { this.onStatus('denied'); return 'denied'; }
    }
    if (this.active) return 'ok';
    this.active = true; this.gotData = false;
    window.addEventListener('devicemotion', this.handler);
    window.addEventListener('shake', this.shakeHandler);
    this.onStatus('waiting');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.gotData && this.active) this.onStatus(needsPermission() && !askPermission ? 'needs-permission' : 'none');
    }, 2200);
    return 'waiting';
  }

  /** Resolves true when a motion reading arrives within `ms`. */
  probe(ms) {
    return new Promise((resolve) => {
      const done = (got) => { clearTimeout(timer); window.removeEventListener('devicemotion', onData); resolve(got); };
      const onData = (e) => { if (e.accelerationIncludingGravity?.x != null) done(true); };
      const timer = setTimeout(() => done(false), ms);
      window.addEventListener('devicemotion', onData);
    });
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('devicemotion', this.handler);
      window.removeEventListener('shake', this.shakeHandler);
    }
    this.lib?.stop();
    this.lib = null;
    this.prev = null; this.last = null; this.gaps = []; this.times = [];
  }

  /** shake.js is only started once real readings arrive: on a computer the event comes once with no values, which it cannot read. */
  async startLibrary() {
    try {
      const Shake = this.Shake || await loadShakeLib();
      if (!this.active || this.lib) return;
      this.lib = new Shake({ threshold: this.threshold, timeout: COOLDOWN_MS });
      this.lib.start();
      // shake.js starts its "no shake for `timeout`" clock when it is started, so a shake in the first seconds after turning the
      // setting on would be ignored: begin with the clock already run out
      this.lib.lastTime = new Date(Date.now() - COOLDOWN_MS - 1);
    } catch { this.onStatus('load-failed'); }
  }

  onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    const now = this.now();
    if (!this.gotData) { this.gotData = true; this.onStatus('ok'); this.startLibrary(); }
    this.times.push(now);
    if (this.last !== null) { this.gaps.push(now - this.last); if (this.gaps.length > 40) this.gaps.shift(); }
    this.last = now;
    if (this.prev) { // what shake.js compares: the change on each axis since the previous reading; it needs two axes to be over the threshold
      const d = [Math.abs(a.x - this.prev[0]), Math.abs(a.y - this.prev[1]), Math.abs(a.z - this.prev[2])].sort((p, q) => q - p);
      this.jolt = d[1];
      if (this.jolt >= this.peak || now - this.peakAt > 1500) { this.peak = this.jolt; this.peakAt = now; }
    }
    this.prev = [a.x, a.y, a.z];
    this.tune();
  }
}
