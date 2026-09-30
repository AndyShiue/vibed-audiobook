// "Shake the phone to ask".
//
//   ShakeDetector  pure logic: accelerometer samples in, "that was a shake" out
//   ShakeListener  glue: devicemotion events, the iOS permission prompt, and a status for the settings screen
//
// A phone in a pocket jolts all the time, so a shake is not "the phone moved" but several hard strokes in
// ALTERNATING directions within a short window: back-and-forth, like shaking a bottle. Walking produces one spike
// per step, always in the same direction, so it never adds up.

export const SHAKE_PRESETS = {
  low: { minPeak: 24, peaks: 5 },     // needs a vigorous shake
  normal: { minPeak: 17, peaks: 4 },
  high: { minPeak: 11, peaks: 3 },    // a light shake is enough (may also fire when jogging)
};

export class ShakeDetector {
  /**
   * @param {number} minPeak    linear acceleration (m/s², gravity removed) a stroke must reach
   * @param {number} peaks      alternating strokes required
   * @param {number} windowMs   ...within this time
   */
  constructor({ minPeak = 17, peaks = 4, windowMs = 1000, refractoryMs = 70, cooldownMs = 2500 } = {}) {
    Object.assign(this, { minPeak, peaks, windowMs, refractoryMs, cooldownMs });
    this.g = null;            // running estimate of gravity
    this.above = false;
    this.lastPeakAt = -Infinity;
    this.cooldownUntil = -Infinity;
    this.strokes = [];        // [{t, sign}]
  }

  /** Feed one accelerometer sample (including gravity). Returns true when a shake has just been completed. */
  push(x, y, z, now) {
    if (!this.g) { this.g = [x, y, z]; return false; }
    // gravity = slow moving average; what is left is the motion of the hand
    for (let i = 0; i < 3; i++) this.g[i] = this.g[i] * 0.92 + [x, y, z][i] * 0.08;
    const lin = [x - this.g[0], y - this.g[1], z - this.g[2]];
    const mag = Math.hypot(lin[0], lin[1], lin[2]);

    if (now < this.cooldownUntil) { this.above = mag >= this.minPeak * 0.5; return false; }

    if (mag < this.minPeak * 0.5) this.above = false;
    else if (mag >= this.minPeak && !this.above && now - this.lastPeakAt >= this.refractoryMs) {
      this.above = true;
      this.lastPeakAt = now;
      const dominant = lin.reduce((best, v, i) => (Math.abs(v) > Math.abs(lin[best]) ? i : best), 0);
      const sign = Math.sign(lin[dominant]);
      const last = this.strokes[this.strokes.length - 1];
      if (last && last.sign === sign) last.t = now;      // same direction again = the same stroke, not a new one
      else this.strokes.push({ t: now, sign });
    }
    this.strokes = this.strokes.filter((s) => now - s.t <= this.windowMs);
    if (this.strokes.length >= this.peaks) {
      this.strokes = [];
      this.cooldownUntil = now + this.cooldownMs;
      return true;
    }
    return false;
  }
}

const hasMotion = () => typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
const needsPermission = () => hasMotion() && typeof window.DeviceMotionEvent.requestPermission === 'function'; // iOS 13+

export class ShakeListener {
  /** @param onShake ()=>void   @param onStatus (status)=>void  status: ok | waiting | none | denied | unsupported | needs-permission */
  constructor({ onShake = () => {}, onStatus = () => {} } = {}) {
    this.onShake = onShake;
    this.onStatus = onStatus;
    this.detector = new ShakeDetector(SHAKE_PRESETS.normal);
    this.handler = (e) => this.onMotion(e);
    this.active = false;
    this.gotData = false;
    this.timer = null;
  }

  setSensitivity(name) {
    this.detector = new ShakeDetector(SHAKE_PRESETS[name] || SHAKE_PRESETS.normal);
  }

  /**
   * Start listening. On iOS the permission prompt may only be shown from a tap, so pass askPermission:true only
   * from a click handler; at page load call it without and, if it reports 'needs-permission', ask on the next tap.
   */
  async start({ sensitivity = 'normal', askPermission = false } = {}) {
    this.setSensitivity(sensitivity);
    if (!hasMotion()) { this.onStatus('unsupported'); return 'unsupported'; }
    if (needsPermission() && askPermission) {
      let result = 'denied';
      try { result = await window.DeviceMotionEvent.requestPermission(); } catch { /* not from a gesture, or refused */ }
      if (result !== 'granted') { this.onStatus('denied'); return 'denied'; }
    }
    if (this.active) return 'ok';
    this.active = true; this.gotData = false;
    window.addEventListener('devicemotion', this.handler);
    this.onStatus('waiting');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.gotData && this.active) this.onStatus(needsPermission() && !askPermission ? 'needs-permission' : 'none');
    }, 2200);
    return 'waiting';
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    if (typeof window !== 'undefined') window.removeEventListener('devicemotion', this.handler);
  }

  onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    if (!this.gotData) { this.gotData = true; this.onStatus('ok'); }
    if (this.detector.push(a.x, a.y, a.z, performance.now())) this.onShake();
  }
}
