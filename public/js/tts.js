// Text-to-speech built on the browser's Web Speech API.
//
// Design notes (all learned the hard way on mobile browsers):
//  • We speak one sentence-sized unit per utterance. Long utterances get cut off by Chrome, and
//    small units give us an exact "where am I" position for free.
//  • "Pause" is cancel + remember the unit index. speechSynthesis.pause() is unreliable on Android,
//    and restarting the interrupted unit from its beginning is what a listener expects anyway.
//  • Utterances are kept in a Set so they aren't garbage-collected before their events fire.
//  • A watchdog moves on if an engine never fires `end` (a well-known Chrome failure mode).
import { detectSpokenLang, normalizeTag } from './lang.js';
import { sleep, cjkRatio } from './util.js';
import { breakLong } from './segmenter.js';

const getSynth = () => globalThis.speechSynthesis || null;
export const ttsSupported = () => !!getSynth() && typeof SpeechSynthesisUtterance !== 'undefined';

// ---------------------------------------------------------------- voices
let voicesReady;
export function loadVoices(timeout = 2000) {
  const synth = getSynth();
  if (!synth) return Promise.resolve([]);
  voicesReady ??= new Promise((resolve) => {
    const have = synth.getVoices();
    if (have.length) return resolve(have);
    const done = () => { synth.removeEventListener('voiceschanged', done); resolve(synth.getVoices()); };
    synth.addEventListener('voiceschanged', done);
    setTimeout(done, timeout);
  });
  return voicesReady;
}

const normVoiceLang = (v) => String(v.lang || '').replace('_', '-');

function voiceScore(v, lang) {
  const vl = normVoiceLang(v).toLowerCase();
  const want = lang.toLowerCase();
  const wantPrimary = want.split('-')[0];
  if (vl.split('-')[0] !== wantPrimary) return -1;
  let s = 10;
  if (vl === want) s += 100;
  else if (wantPrimary === 'zh') {
    const trad = (x) => /tw|hk|hant/.test(x);
    if (trad(vl) === trad(want)) s += 60; // don't read Traditional text with a mainland voice if avoidable
    if (vl.startsWith('zh-cn') && !trad(want)) s += 20;
  } else if (vl.startsWith(want.slice(0, 2)) && vl.slice(3, 5) === want.slice(3, 5)) s += 50;
  if (/natural|neural|premium|enhanced|online|wavenet/i.test(v.name)) s += 25;
  if (/google/i.test(v.name)) s += 10;
  if (!v.localService) s += 5;
  if (v.default) s += 1;
  return s;
}

export function pickVoice(lang, preferredURI) {
  const synth = getSynth();
  if (!synth) return null;
  const voices = synth.getVoices();
  if (preferredURI) {
    const v = voices.find((x) => x.voiceURI === preferredURI);
    if (v) return v;
  }
  let best = null, bestScore = -1;
  for (const v of voices) {
    const s = voiceScore(v, lang);
    if (s > bestScore) { best = v; bestScore = s; }
  }
  return best;
}

export function voicesFor(lang) {
  const synth = getSynth();
  if (!synth) return [];
  const primary = lang.split('-')[0].toLowerCase();
  return synth.getVoices().filter((v) => normVoiceLang(v).toLowerCase().split('-')[0] === primary)
    .sort((a, b) => voiceScore(b, lang) - voiceScore(a, lang));
}

// ---------------------------------------------------------------- text preparation
/** Make book text friendlier for speech engines (they read some symbols aloud). */
export function cleanForSpeech(text) {
  return String(text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[\d{1,3}\]|［\d{1,3}］/g, '')
    .replace(/[「」『』《》〈〉“”‘’"]/g, '')
    .replace(/[…⋯]+|\.{3,}/g, '，')
    .replace(/[—―─–]{1,}/g, '，')
    .replace(/[*#_~`|^<>{}\\]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[，,]\s*[，,]+/g, '，')
    .replace(/\s+/g, ' ')
    .trim();
}

const cleanMarkdown = (s) => cleanForSpeech(s.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '').replace(/^\s*>+\s*/gm, '').replace(/\[([^\]]+)]\([^)]*\)/g, '$1'));

/** Splits a streamed answer into speakable sentences as soon as they are complete. */
export class SentenceStream {
  constructor() { this.buf = ''; this.count = 0; }

  push(delta) { this.buf += delta; return this.drain(false); }
  end() { return this.drain(true); }

  cutIndex(final) {
    const b = this.buf;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      let end = false;
      if ('。！？!?；;\n'.includes(c)) end = true;
      else if (c === '.' && (i + 1 < b.length ? /\s/.test(b[i + 1]) : final)) end = true;
      if (end) {
        let j = i + 1;
        while (j < b.length && '」』”’）)"\'。！？!?'.includes(b[j])) j++;
        if (j === b.length && !final && c !== '\n' && /[」』”’）)"']/.test(b[j - 1] || '')) return -1;
        return j;
      }
    }
    if (!final && this.count === 0 && b.length >= 14) { // start talking early: first clause is enough
      const m = Math.max(b.lastIndexOf('，'), b.lastIndexOf('、'), b.lastIndexOf(','), b.lastIndexOf('：'), b.lastIndexOf(':'));
      if (m >= 8) return m + 1;
    }
    if (b.length > 140) {
      const sp = Math.max(b.lastIndexOf(' ', 120), b.lastIndexOf('，', 120), b.lastIndexOf(',', 120));
      return sp > 40 ? sp + 1 : 120;
    }
    return -1;
  }

  drain(final) {
    const out = [];
    // Long sentences are cut at commas: some engines (notably Chrome's online voices) stop after ~15 s of one utterance.
    const emit = (t) => {
      if (!t) return;
      const cjk = cjkRatio(t) > 0.3;
      const max = cjk ? 60 : 170;
      for (const part of t.length > max ? breakLong(t, max, cjk) : [t]) { out.push(part); this.count++; }
    };
    for (;;) {
      const cut = this.cutIndex(final);
      if (cut < 0) break;
      const t = cleanMarkdown(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
      emit(t);
    }
    if (final) {
      const t = cleanMarkdown(this.buf);
      this.buf = '';
      emit(t);
    }
    return out;
  }
}

// ---------------------------------------------------------------- audiobook narrator
export class Narrator extends EventTarget {
  /** @param getSettings () => {rate, voiceURI:{[lang]:uri}} */
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.sents = [];
    this.lang = 'en-US';
    this.idx = 0;
    this.state = 'paused'; // 'playing' | 'paused'
    this.gen = 0;
    this.queued = -1;
    this.startedIdx = -1;
    this.live = new Set();
    this.watchdog = null;
    this.startDog = null;
    this.errors = 0;
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
    clearTimeout(this.watchdog); clearTimeout(this.startDog);
    this.state = 'paused';
    getSynth()?.cancel();
    this.live.clear();
  }

  /** Start (or restart) speaking from unit `from`. */
  play(from = this.idx) {
    if (!ttsSupported() || !this.sents.length) return;
    this.gen++;
    const gen = this.gen;
    clearTimeout(this.watchdog); clearTimeout(this.startDog);
    getSynth().cancel();
    this.live.clear();
    this.state = 'playing';
    this.idx = Math.max(0, Math.min(from, this.sents.length - 1));
    this.queued = this.idx - 1;
    this.startedIdx = -1;
    this.errors = 0;
    this.emit('state');
    setTimeout(() => { if (gen === this.gen) this.enqueue(this.idx, gen); }, 70); // Chrome drops speak() issued right after cancel()
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

  enqueue(i, gen, attempt = 0) {
    const synth = getSynth();
    if (gen !== this.gen) return;
    if (i >= this.sents.length) return;
    const text = cleanForSpeech(this.sents[i]);
    const s = this.getSettings();
    if (!/[\p{L}\p{N}]/u.test(text)) { // nothing speakable: move on silently
      this.queued = i; this.idx = i; this.emit('index', i);
      if (i + 1 < this.sents.length) this.enqueue(i + 1, gen); else this.finish(gen);
      return;
    }
    const lang = this.unitLang(text);
    const u = new SpeechSynthesisUtterance(text);
    const voice = attempt > 0 ? null : pickVoice(lang, s.voiceURI?.[lang]);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = lang;
    u.rate = s.rate || 1;
    this.live.add(u);
    const ms = (n) => 5000 + (n * 450) / (s.rate || 1);

    u.onstart = () => {
      if (gen !== this.gen) return;
      clearTimeout(this.startDog);
      this.startedIdx = i;
      this.idx = i;
      this.errors = 0;
      this.emit('index', i);
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => { if (gen === this.gen && this.idx === i) this.advanceAfterStall(i, gen); }, ms(text.length));
      if (this.queued === i && i + 1 < this.sents.length) this.enqueue(i + 1, gen);
    };
    u.onend = () => {
      this.live.delete(u);
      if (gen !== this.gen) return;
      clearTimeout(this.watchdog);
      if (i >= this.sents.length - 1) this.finish(gen);
      else if (this.queued === i) this.enqueue(i + 1, gen);
    };
    u.onerror = (e) => {
      this.live.delete(u);
      if (gen !== this.gen) return;
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      if (e.error === 'not-allowed') { this.hardStop(); this.emit('state'); this.emit('blocked'); return; }
      this.errors++;
      if (attempt === 0) { synth.cancel(); this.queued = i - 1; setTimeout(() => this.enqueue(i, gen, 1), 80); return; }
      if (this.errors >= 4) { this.hardStop(); this.emit('state'); this.emit('error', e.error); return; }
      this.queued = i; this.enqueue(i + 1, gen);
    };

    this.queued = i;
    synth.speak(u);
    clearTimeout(this.startDog);
    this.startDog = setTimeout(() => { // the engine accepted the utterance but never started it
      if (gen !== this.gen || this.startedIdx >= i || synth.speaking) return;
      this.errors++;
      if (this.errors > 2) { this.hardStop(); this.emit('state'); this.emit('error', 'no-start'); }
      else { synth.cancel(); this.queued = i - 1; this.enqueue(i, gen, 1); }
    }, 6000);
  }

  advanceAfterStall(i, gen) {
    if (gen !== this.gen) return;
    if (i >= this.sents.length - 1) { this.finish(gen); return; }
    this.play(i + 1);
  }

  finish(gen) {
    if (gen !== this.gen) return;
    this.state = 'paused';
    this.emit('state');
    this.emit('end');
  }

  unitLang(text) {
    // A Chinese/Japanese book quoting a whole English sentence should not be read with a Chinese voice.
    if (/^(zh|ja|ko)/.test(this.lang)) {
      const d = detectSpokenLang(text, this.lang);
      return /^(zh|ja|ko)/.test(d) ? this.lang : d;
    }
    return this.lang;
  }
}

// ---------------------------------------------------------------- spoken answers
/**
 * Speaks the AI's answer sentence by sentence while it is still streaming in.
 *
 * At most two utterances are handed to the engine at a time (the one being spoken plus one queued behind it,
 * so there is no audible gap). Every time-out is measured from the moment an utterance actually *starts*;
 * `done` resolves only when the engine has really finished the last sentence, because the caller resumes the
 * audiobook (which cancels all speech) as soon as it resolves.
 */
export class AnswerSpeaker {
  constructor(getSettings, getFallbackLang) {
    this.getSettings = getSettings;
    this.getFallbackLang = getFallbackLang;
    this.gen = 0;
    this.queue = [];      // utterances waiting for a slot
    this.inEngine = [];   // utterances currently handed to speechSynthesis (head = speaking or about to)
    this.finished = true;
    this.resolveDone = null;
    this.spoken = 0;
    this.headTimer = null;
  }

  begin() {
    this.cancel();
    this.gen++;
    this.queue = []; this.inEngine = [];
    this.finished = false; this.spoken = 0;
    return new Promise((resolve) => { this.resolveDone = resolve; });
  }

  push(text) {
    if (this.finished || !ttsSupported()) return;
    const clean = cleanForSpeech(text);
    if (!/[\p{L}\p{N}]/u.test(clean)) return;
    const s = this.getSettings();
    const lang = detectSpokenLang(clean, this.getFallbackLang());
    const u = new SpeechSynthesisUtterance(clean);
    const voice = pickVoice(lang, s.answerVoiceURI?.[lang] || s.voiceURI?.[lang]);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = lang;
    u.rate = Math.min(2, (s.rate || 1) * 1.02);
    u.pitch = s.answerPitch || 1;
    const gen = this.gen;
    const rec = { u, len: clean.length, rate: u.rate, started: false, settled: false, endTimer: null };
    const settle = () => {
      if (rec.settled) return;
      rec.settled = true;
      clearTimeout(rec.endTimer);
      if (gen !== this.gen) return;
      this.inEngine = this.inEngine.filter((r) => r !== rec);
      this.pump();
    };
    u.onstart = () => {
      if (gen !== this.gen || rec.settled) return;
      rec.started = true;
      // Generous limit for engines that never fire `end`; counted from the real start of this sentence.
      rec.endTimer = setTimeout(settle, 5000 + (rec.len * 450) / rec.rate);
    };
    u.onend = settle;
    u.onerror = settle;
    this.spoken++;
    this.queue.push(rec);
    this.pump();
  }

  pump() {
    const synth = getSynth();
    while (synth && this.inEngine.length < 2 && this.queue.length) {
      const rec = this.queue.shift();
      this.inEngine.push(rec);
      synth.speak(rec.u);
    }
    this.armHeadWatch();
    this.check();
  }

  /** If the utterance at the head never starts (engine stuck), drop it so the answer cannot hang forever. */
  armHeadWatch() {
    clearTimeout(this.headTimer);
    const head = this.inEngine[0];
    if (!head || head.started) return;
    const gen = this.gen;
    this.headTimer = setTimeout(() => {
      if (gen !== this.gen || head.started || head.settled) return;
      if (getSynth()?.speaking) { this.armHeadWatch(); return; }
      head.u.onend?.();
    }, 8000);
  }

  finish() { this.finished = true; this.check(); }

  check() {
    if (this.finished && !this.queue.length && !this.inEngine.length && this.resolveDone) {
      const r = this.resolveDone; this.resolveDone = null;
      r(true);
    }
  }

  cancel() {
    this.gen++;
    clearTimeout(this.headTimer);
    for (const r of this.inEngine) clearTimeout(r.endTimer);
    getSynth()?.cancel();
    this.queue = []; this.inEngine = [];
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
