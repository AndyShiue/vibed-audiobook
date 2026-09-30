// Non-visual feedback for eyes-closed use: short tones (Web Audio) and vibration.
import { sleep } from './util.js';

export class Feedback {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.ctx = null;
  }

  /** Must be called from a user gesture at least once (iOS/Chrome autoplay rules). */
  unlock() {
    try {
      this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { /* no Web Audio */ }
  }

  tone(freq, at, dur, gain = 0.16, type = 'sine') {
    const c = this.ctx;
    if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq;
    const t0 = c.currentTime + at;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  vibrate(pattern) {
    if (this.getSettings().haptics && navigator.vibrate) { try { navigator.vibrate(pattern); } catch { /* unsupported */ } }
  }

  /** Play a named cue; resolves when it has finished so callers can start the mic after it. */
  async cue(name) {
    const enabled = this.getSettings().earcons;
    const cues = {
      listen: { v: 40, notes: [[660, 0, 0.11], [880, 0.1, 0.16]] },          // rising: "go ahead"
      sent: { v: [20, 40, 20], notes: [[880, 0, 0.09], [660, 0.09, 0.14]] },   // falling: "got it"
      answer: { v: 30, notes: [[523, 0, 0.12], [659, 0.08, 0.12], [784, 0.16, 0.22]] },
      cancel: { v: [30, 30, 30], notes: [[330, 0, 0.12], [247, 0.1, 0.18]] },
      error: { v: [80, 40, 80], notes: [[220, 0, 0.2], [185, 0.18, 0.28]] },
      play: { v: 15, notes: [[740, 0, 0.07]] },
      pause: { v: 15, notes: [[494, 0, 0.09]] },
      tick: { v: 0, notes: [[392, 0, 0.05, 0.05]] },
      chapter: { v: [20, 30, 20], notes: [[587, 0, 0.08], [784, 0.09, 0.12]] },
      sleep: { v: [50, 50, 50], notes: [[523, 0, 0.2], [392, 0.2, 0.2], [294, 0.4, 0.4]] },
    };
    const cue = cues[name];
    if (!cue) return;
    if (cue.v) this.vibrate(cue.v);
    if (!enabled) return;
    this.unlock();
    let end = 0;
    for (const [f, at, d, g] of cue.notes) { this.tone(f, at, d, g ?? 0.16); end = Math.max(end, at + d); }
    await sleep(end * 1000 + 40);
  }
}
