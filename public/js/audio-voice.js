// The second voice engine: audio made by the server (tts-providers.js), played through an <audio> element.
//
// The phone's own engine (tts.js) is the default. This one trades that for better voices and for playback that keeps going
// when the screen locks (it is real audio, not speech synthesis). The classes here have the same interface as Narrator and
// AnswerSpeaker in tts.js, so the app can use either one (voice-hub.js switches between them).
//
//   AudioOut            the one <audio> element everything is played through
//   AudioNarrator       reads the book: one clip per speech unit, the next ones fetched while the current one plays
//   AudioAnswerSpeaker  speaks an AI answer sentence by sentence while it is still streaming in
import * as ai from './ai.js';
import { normalizeTag, detectSpokenLang } from './lang.js';
import { cleanForSpeech, unitLang, mixedMode } from './tts.js';
import { sleep } from './util.js';
import { silentWavUrl } from './session.js';

const speakable = (s) => /[\p{L}\p{N}]/u.test(s);
const abortLike = (err) => err?.name === 'AbortError';
/** Errors that retrying cannot fix (bad key, bad request, no credit…): the server answered, and said no. */
const permanent = (err) => Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;

/** A clip is fetched, and fetched once more after a short wait when the failure may be a passing one. */
async function fetchWithRetry(fetchClip, request, retryDelay) {
  try { return await fetchClip(request); }
  catch (err) {
    if (permanent(err) || abortLike(err)) throw err;
    await sleep(retryDelay);
    return fetchClip(request);
  }
}

/**
 * The request for one piece of text, as written. With the mixed-language setting on ('words' or 'phrases') the server cuts the
 * text by language and reads each piece with the voice chosen for that language (`voices`: {language: voice id}) or its own
 * pick; with 'off' the whole text is read in one voice, in the language it is in (`detect`).
 */
export function clipRequest(raw, { lang, voices, mixed, detect }) {
  if (mixed === 'off') { const l = detect(raw); return { text: raw, lang: l, voice: voices?.[l] || '', mixed }; }
  return { text: raw, lang, voice: '', voices: voices || {}, mixed };
}

// ---------------------------------------------------------------- the <audio> element
export class AudioOut {
  constructor() { this.el = null; this.cancelCurrent = null; this.unlocked = false; this.token = 0; }

  element() {
    if (!this.el) {
      this.el = new Audio();
      this.el.setAttribute?.('playsinline', '');
      this.el.preload = 'auto';
    }
    return this.el;
  }

  /**
   * iOS only lets an <audio> element start playing from a tap, but once it has, the same element may be given new audio later
   * without one. So the first tap plays a moment of silence through it.
   */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      const el = this.element();
      el.src = silentWavUrl();
      // (an AbortError only means the real audio took over, which is fine; NotAllowedError means this was not a tap)
      el.play()?.catch?.((err) => { if (err?.name === 'NotAllowedError') this.unlocked = false; });
    } catch { this.unlocked = false; }
  }

  /**
   * Plays a clip. Resolves 'ended' (or 'timeout' when it never ends within `maxMs`), or 'stopped' when stop() or another play()
   * took over; rejects when the browser refuses (NotAllowedError) or cannot decode the audio.
   */
  play(url, { rate = 1, onstart, maxMs = 60_000 } = {}) {
    this.stop();
    const el = this.element();
    const mine = ++this.token;
    return new Promise((resolve, reject) => {
      let timer;
      const detach = () => { clearTimeout(timer); el.onended = el.onerror = el.onplaying = null; if (this.token === mine) this.cancelCurrent = null; };
      this.cancelCurrent = () => { detach(); resolve('stopped'); };
      el.onplaying = () => { el.onplaying = null; onstart?.(); };
      el.onended = () => { detach(); resolve('ended'); };
      el.onerror = () => { detach(); reject(Object.assign(new Error('the audio could not be played'), { name: 'MediaError' })); };
      timer = setTimeout(() => { detach(); try { el.pause(); } catch { /* ignore */ } resolve('timeout'); }, maxMs);
      try {
        el.defaultPlaybackRate = rate; // a new src resets playbackRate to this
        el.src = url;
        el.playbackRate = rate;
        if ('preservesPitch' in el) el.preservesPitch = true;
        const p = el.play();
        p?.catch?.((err) => { detach(); reject(err); });
      } catch (err) { detach(); reject(err); }
    });
  }

  stop() {
    this.token++;
    this.cancelCurrent?.();
    try { this.el?.pause(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- reading the book
export class AudioNarrator extends EventTarget {
  /**
   * @param getSettings () => {rate, serverVoice:{[lang]:voiceId}}
   * @param o.out        the AudioOut to play through
   * @param o.fetchClip  ({text, lang, voice}) => Promise<Blob>   (the server, unless a test says otherwise)
   * @param o.ahead      how many following units are fetched while one plays
   */
  constructor(getSettings, { out = new AudioOut(), fetchClip = ai.ttsClip, ahead = 2, retryDelay = 400 } = {}) {
    super();
    this.getSettings = getSettings;
    this.out = out; this.fetchClip = fetchClip; this.ahead = ahead; this.retryDelay = retryDelay;
    this.sents = [];
    this.lang = 'en-US';
    this.idx = 0;
    this.state = 'paused'; // 'playing' | 'paused'
    this.gen = 0;
    this.clips = new Map(); // request key → { i, promise, url }
  }

  load(sents, lang, idx = 0) {
    this.hardStop();
    this.sents = sents;
    this.lang = normalizeTag(lang) || 'en-US';
    this.idx = Math.max(0, Math.min(idx, sents.length - 1));
  }

  get playing() { return this.state === 'playing'; }

  hardStop() {
    this.gen++;
    this.state = 'paused';
    this.out.stop();
    this.sweep(Infinity);
  }

  /** Start (or restart) reading from unit `from`. */
  play(from = this.idx) {
    if (!this.sents.length) return;
    this.gen++;
    this.out.stop();
    this.out.unlock(); // still inside the tap that asked for this, which is what iOS needs
    this.state = 'playing';
    this.idx = Math.max(0, Math.min(from, this.sents.length - 1));
    this.sweep(this.idx);
    for (const [key, e] of this.clips) if (e.failed) this.clips.delete(key); // pressing play is a new try
    this.emit('state');
    this.run(this.gen, this.idx);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.hardStop();
    this.emit('state');
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(i) {
    i = Math.max(0, Math.min(i, this.sents.length - 1));
    if (this.playing) this.play(i);
    else { this.idx = i; this.emit('index', i); }
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async run(gen, start) {
    for (let i = start; i < this.sents.length; i++) {
      if (gen !== this.gen) return;
      const text = cleanForSpeech(this.sents[i]);
      if (!speakable(text)) { this.idx = i; this.emit('index', i); continue; } // nothing to say: move on silently
      const wanted = this.clip(i, this.sents[i]); // this unit first, then the ones after it
      this.prefetch(i + 1);
      let url;
      try { url = await wanted; }
      catch (err) { if (gen === this.gen) { this.idx = i; this.fail(err); } return; } // the position stays on this unit, so whatever takes over starts here
      if (gen !== this.gen) return;
      const rate = this.getSettings().rate || 1;
      try {
        await this.out.play(url, {
          rate, maxMs: 8000 + (text.length * 450) / rate,
          onstart: () => { if (gen !== this.gen) return; this.idx = i; this.emit('index', i); },
        });
      } catch (err) {
        if (gen !== this.gen) return;
        this.idx = i;
        if (err?.name === 'NotAllowedError') { this.hardStop(); this.emit('state'); this.emit('blocked'); } else this.fail(err);
        return;
      }
      if (gen !== this.gen) return;
      this.sweep(i + 1); // this unit's audio is done with
    }
    if (gen === this.gen) this.finish();
  }

  finish() {
    this.state = 'paused';
    this.sweep(Infinity);
    this.emit('state');
    this.emit('end');
  }

  fail(err) {
    this.hardStop();
    this.emit('state');
    this.emit('error', err?.message || String(err));
  }

  // ---- clips: fetched ahead of time, one object URL each, released once played
  requestFor(raw) {
    const s = this.getSettings();
    return clipRequest(raw, { lang: this.lang, voices: s.serverVoice, mixed: mixedMode(s), detect: (t) => unitLang(this.lang, t) });
  }

  clip(i, raw) {
    const req = this.requestFor(raw);
    const key = `${i}\u0000${JSON.stringify(req)}`;
    let entry = this.clips.get(key);
    if (!entry) {
      entry = { i, url: null };
      entry.promise = fetchWithRetry(this.fetchClip, req, this.retryDelay).then((blob) => {
        if (this.clips.get(key) !== entry) return null; // dropped while it was being fetched
        entry.url = URL.createObjectURL(blob);
        return entry.url;
      });
      // A passing failure is forgotten, so that the next try fetches again. A refusal (wrong key, no credit…) is remembered until the
      // listener presses play again, so that the prefetch and the real request do not both ask a server that has said no.
      entry.promise.catch((err) => { if (this.clips.get(key) !== entry) return; if (permanent(err)) entry.failed = true; else this.clips.delete(key); });
      this.clips.set(key, entry);
    }
    return entry.promise.then((url) => { if (!url) throw Object.assign(new Error('clip dropped'), { name: 'AbortError' }); return url; });
  }

  prefetch(from) {
    for (let j = from; j < Math.min(this.sents.length, from + this.ahead); j++) {
      if (speakable(cleanForSpeech(this.sents[j]))) this.clip(j, this.sents[j]).catch(() => {}); // a failure here is retried when the unit is really needed
    }
  }

  /** Forgets the clips of the units before `keepFrom` (all of them for Infinity) and releases their audio. */
  sweep(keepFrom) {
    for (const [key, e] of this.clips) {
      if (e.i >= keepFrom) continue;
      this.clips.delete(key);
      if (e.url) URL.revokeObjectURL(e.url);
    }
  }
}

// ---------------------------------------------------------------- speaking an AI answer
export class AudioAnswerSpeaker {
  /**
   * @param getSettings       () => settings
   * @param getFallbackLang   () => the language of the question (= the language the AI answers in)
   * @param o.speakDevice     (text, {lang, settings}) => {done, cancel} — the phone's voices, used for a sentence the server cannot make
   * @param o.onFail          (error) => void — told once per failed clip, so the app can switch to the phone's voices for good
   */
  constructor(getSettings, getFallbackLang, { out = new AudioOut(), fetchClip = ai.ttsClip, speakDevice = null, onFail = null, retryDelay = 400 } = {}) {
    this.getSettings = getSettings; this.getFallbackLang = getFallbackLang;
    this.out = out; this.fetchClip = fetchClip; this.speakDevice = speakDevice; this.onFail = onFail; this.retryDelay = retryDelay;
    this.gen = 0;
    this.items = [];
    this.finished = true;
    this.running = false;
    this.resolveDone = null;
    this.spoken = 0;
    this.deviceHandle = null;
  }

  begin() {
    this.cancel();
    this.gen++;
    this.items = [];
    this.finished = false; this.spoken = 0;
    return new Promise((resolve) => { this.resolveDone = resolve; });
  }

  push(text) {
    if (this.finished) return;
    const clean = cleanForSpeech(text);
    if (!speakable(clean)) return;
    const s = this.getSettings();
    const fallback = this.getFallbackLang(); // the question's language, which is the language the answer is in
    const request = clipRequest(text, { lang: fallback, voices: { ...s.serverVoice, ...s.serverAnswerVoice }, mixed: mixedMode(s), detect: (t) => detectSpokenLang(cleanForSpeech(t), fallback) });
    const item = { text: clean, raw: text, lang: request.lang, url: null, settled: null };
    // fetched right away, so that the next sentences are ready while the first one is spoken
    item.settled = fetchWithRetry(this.fetchClip, request, this.retryDelay)
      .then((blob) => { item.blob = blob; }, (err) => { item.error = err; });
    this.items.push(item);
    this.spoken++;
    this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    const gen = this.gen;
    try {
      while (gen === this.gen && this.items.length) {
        const item = this.items.shift();
        await item.settled;
        if (gen !== this.gen) return;
        const s = this.getSettings();
        let ok = false;
        if (item.blob) {
          const url = URL.createObjectURL(item.blob);
          try {
            const rate = s.rate || 1;
            await this.out.play(url, { rate, maxMs: 8000 + (item.text.length * 450) / rate });
            ok = true;
          } catch (err) { item.error = err; }
          finally { URL.revokeObjectURL(url); }
        }
        if (gen !== this.gen) return;
        if (!ok) await this.fallback(item, gen);
      }
    } finally {
      if (gen === this.gen) { this.running = false; this.check(); }
    }
  }

  /** The server could not make (or the browser could not play) this sentence: the phone says it instead, and the app is told. */
  async fallback(item, gen) {
    this.onFail?.(item.error);
    if (!this.speakDevice) return;
    this.deviceHandle = this.speakDevice(item.raw, { lang: item.lang, settings: this.getSettings(), rate: Math.min(2, (this.getSettings().rate || 1) * 1.02), pitch: this.getSettings().answerPitch || 1 });
    try { await this.deviceHandle.done; } finally { if (gen === this.gen) this.deviceHandle = null; }
  }

  finish() { this.finished = true; this.check(); }

  check() {
    if (this.finished && !this.items.length && !this.running && this.resolveDone) {
      const r = this.resolveDone; this.resolveDone = null;
      r(true);
    }
  }

  cancel() {
    this.gen++;
    this.running = false;
    this.items = [];
    this.out.stop();
    this.deviceHandle?.cancel(); this.deviceHandle = null;
    this.finished = true;
    if (this.resolveDone) { const r = this.resolveDone; this.resolveDone = null; r(false); }
  }

  /** Speak a short standalone message (errors, status). Resolves when finished. */
  async say(text) {
    const done = this.begin();
    this.push(text);
    this.finish();
    if (!this.spoken) return;
    await Promise.race([done, sleep(30000)]);
  }
}
