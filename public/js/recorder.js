// Records one spoken question from the microphone and decides by itself when the speaker has finished
// (the browser's built-in recognizer used to do the endpointing for us; a plain recorder does not).
//
//   VadTracker     pure "voice activity" logic: feed it loudness samples, it says when to stop
//   VoiceRecorder  getUserMedia + MediaRecorder + a loudness meter feeding the tracker

/** Decides when an utterance is over from a stream of loudness (RMS) samples. */
export class VadTracker {
  constructor({ silenceMs = 1500, noSpeechMs = 9000, maxMs = 45000, minSpeechMs = 350, calibrateMs = 350 } = {}) {
    Object.assign(this, { silenceMs, noSpeechMs, maxMs, minSpeechMs, calibrateMs });
    this.t0 = null; this.last = null;
    this.speechMs = 0; this.lastSpeechAt = null; this.spoke = false;
    this.calib = []; this.floor = 0.006; this.threshold = 0.02;
    this.smooth = 0;
    this.blind = false; // set when there is no working loudness meter
  }

  /** @returns {'continue'|'end'|'no-speech'|'max'} */
  push(rms, now) {
    if (this.t0 === null) { this.t0 = now; this.last = now; }
    const dt = Math.max(0, now - this.last);
    this.last = now;
    this.smooth = this.smooth * 0.6 + rms * 0.4;

    if (now - this.t0 < this.calibrateMs) {
      this.calib.push(rms);
      // The speaker may already be talking: take the quiet end of the first samples as the noise floor.
      const sorted = [...this.calib].sort((a, b) => a - b);
      this.floor = Math.min(0.05, sorted[Math.floor(sorted.length * 0.25)] ?? 0.006);
      this.threshold = Math.min(0.08, Math.max(0.02, this.floor * 2.8));
      return 'continue';
    }
    if (!this.spoke) this.floor = Math.min(this.floor, this.smooth || this.floor); // ambient may be quieter than first thought
    this.threshold = Math.min(0.08, Math.max(0.02, this.floor * 2.8));

    // Raw (unsmoothed) samples decide what counts as speech, so a cough or a click, which is over in ~100 ms,
    // never adds up to minSpeechMs; the smoothed value only feeds the noise-floor tracking and the meter.
    if (rms >= this.threshold) {
      this.speechMs += dt;
      this.lastSpeechAt = now;
      if (this.speechMs >= this.minSpeechMs) this.spoke = true;
    }
    const elapsed = now - this.t0;
    if (elapsed >= this.maxMs) return 'max';
    if (this.spoke && now - this.lastSpeechAt >= this.silenceMs) return 'end';
    if (!this.spoke && elapsed >= this.noSpeechMs) return 'no-speech';
    return 'continue';
  }

  /** 0..1 loudness for the on-screen meter. */
  get level() { return Math.max(0, Math.min(1, (this.smooth - this.floor) / 0.15)); }
}

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];

export const recorderSupported = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

function pickMime() {
  return MIME_CANDIDATES.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
}

export class VoiceRecorder {
  constructor(getAudioContext = () => null) {
    this.getAudioContext = getAudioContext;
    this.finish = null;
    this.starting = false;
    this.cancelStart = false;
    this.heard = false; // something that sounds like speech has been picked up in the current recording
  }

  get active() { return !!this.finish; }

  /**
   * Records until the speaker stops (or stop()/abort() is called).
   * Resolves {blob, mime, ms, speech} or {error: 'not-allowed'|'no-mic'|'unsupported'|'aborted'}.
   */
  async record({ onLevel = () => {}, vad = {}, onReady = () => {}, ignoreMs = 0 } = {}) {
    if (!recorderSupported()) return { error: 'unsupported' };
    let stream;
    this.starting = true; this.cancelStart = false; this.heard = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      this.starting = false;
      return { error: err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'not-allowed' : 'no-mic' };
    }
    this.starting = false;
    if (this.cancelStart) { stream.getTracks().forEach((t) => t.stop()); return { error: 'aborted' }; } // cancelled while the permission prompt was open

    return new Promise((resolve) => {
      const mimeType = pickMime();
      let rec;
      try { rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined); } catch { stream.getTracks().forEach((t) => t.stop()); resolve({ error: 'unsupported' }); return; }
      const chunks = [];
      const tracker = new VadTracker(vad);
      const startedAt = performance.now();
      let settled = false, reason = 'end', timer = null, ctx = null, ownCtx = false, source = null, aborted = false;
      let sawSignal = false;
      let readyAt = 0, ignoreUntil = 0; // the meter/auto-stop start listening only once the mic is live (and the ready beep is over)
      const ready = () => {
        if (readyAt) return;
        readyAt = performance.now(); ignoreUntil = readyAt + ignoreMs;
        try { onReady(); } catch { /* a failing callback must not break recording */ }
      };

      const cleanup = () => {
        clearInterval(timer);
        try { source?.disconnect(); } catch { /* ignore */ }
        if (ownCtx) { try { ctx.close(); } catch { /* ignore */ } }
        stream.getTracks().forEach((t) => t.stop());
        this.finish = null;
        onLevel(0);
      };
      const done = (why, isAbort = false) => {
        if (settled) return;
        settled = true; reason = why; aborted = isAbort;
        try { if (rec.state !== 'inactive') rec.stop(); else rec.onstop(); } catch { rec.onstop?.(); }
      };
      this.finish = (isAbort) => done(isAbort ? 'aborted' : 'manual', isAbort);

      rec.ondataavailable = (e) => { if (e.data && e.data.size) { chunks.push(e.data); ready(); } };
      rec.onerror = () => done('error');
      rec.onstop = () => {
        cleanup();
        if (aborted) { resolve({ error: 'aborted' }); return; }
        const type = rec.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type });
        resolve({ blob, mime: type, ms: Math.round(performance.now() - startedAt), speech: tracker.spoke || ((reason === 'manual' || reason === 'max') && (tracker.blind || tracker.speechMs > 0)), reason });
      };

      // Loudness meter (drives auto-stop and the on-screen level).
      try {
        ctx = this.getAudioContext();
        if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); ownCtx = true; }
        if (ctx.state === 'suspended') ctx.resume();
        source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          if (rms > 0) { sawSignal = true; ready(); } // a live microphone always carries at least a little noise
          if (!readyAt || performance.now() < ignoreUntil) { onLevel(0); return; }
          const verdict = tracker.push(rms, performance.now());
          if (tracker.spoke || tracker.speechMs >= 200 || tracker.blind) this.heard = true; // (a meter that does not work cannot tell: assume yes)
          onLevel(tracker.level);
          if (verdict === 'end') done('end');
          else if (verdict === 'no-speech') done('no-speech');
          else if (verdict === 'max') done('max');
          // A meter that never moves means the audio graph is not running (e.g. a suspended context on iOS):
          // stop guessing and let the listener finish by tapping, with a shorter safety limit.
          else if (!sawSignal && ctx.state !== 'running') { // (a running graph that hears pure silence is just a quiet room)
            ctx.resume?.();
            if (performance.now() - readyAt > 2500) { tracker.noSpeechMs = Infinity; tracker.maxMs = Math.min(tracker.maxMs, 20000); tracker.blind = true; }
          }
        }, 50);
      } catch {
        // No meter available: record until tapped (or 20 s).
        timer = setTimeout(() => done('max'), 20000);
        tracker.blind = true; this.heard = true;
      }

      rec.onstart = ready;
      setTimeout(ready, 800); // whichever signal comes first counts; never leave the listener waiting long
      rec.start(250);
    });
  }

  /** Finish now and deliver what was recorded. */
  stop() { if (this.starting) this.cancelStart = true; this.finish?.(false); }
  /** Throw the recording away. */
  abort() { if (this.starting) this.cancelStart = true; this.finish?.(true); }
}
