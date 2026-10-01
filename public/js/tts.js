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
import { breakLong, scanSentences } from './segmenter.js';
import { planSpeech, cleanForSpeech, MIXED_MODES, DEFAULT_MIXED_MODE } from './speech-plan.js';

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

// Voices that ship with macOS / iOS as novelties or in an old, thin synthesis — never the right choice for a book.
const NOVELTY_VOICE = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox)\b/i;
const OLD_VOICE = /^(fred|ralph|kathy|junior|princess|agnes|victoria|bruce|vicki)\b/i;

export function voiceScore(v, lang) {
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
  const label = `${v.name} ${v.voiceURI || ''}`; // iOS puts "compact" / "enhanced" / "premium" in the URI, not the name
  if (/natural|neural|premium|enhanced|online|wavenet|siri/i.test(label)) s += 25;
  if (/compact/i.test(label)) s -= 15;
  if (NOVELTY_VOICE.test(v.name)) s -= 80;
  else if (OLD_VOICE.test(v.name)) s -= 20;
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

// ---------------------------------------------------------------- one text, several voices
/** Setting "mixed languages": 'words' (default) | 'phrases' | 'off' — see speech-plan.js. */
export const mixedMode = (settings) => (MIXED_MODES.includes(settings?.mixedVoice) ? settings.mixedVoice : DEFAULT_MIXED_MODE);

const speakable = (s) => /[\p{L}\p{N}]/u.test(s);

/**
 * Parts to speak one after the other for a piece of text: one per run of one language, each with the language whose voice
 * should read it. `lang` is the language of the book — or, for an answer, of the question, which is the language the AI
 * answers in. `fallback(text)` gives the single language to use when the text is not split ("off", or nothing to split).
 */
export function speechParts(raw, { lang, settings, fallback }) {
  const clean = cleanForSpeech(raw);
  const mode = mixedMode(settings);
  if (mode === 'off') return [{ text: clean, lang: fallback(clean) }];
  const parts = planSpeech(raw, { lang, mode, hasVoice: (l) => Boolean(pickVoice(l)) })
    .map((p) => ({ lang: p.lang, text: cleanForSpeech(p.text) })) // after planning: quotation marks were clues for it
    .filter((p) => speakable(p.text));
  return parts.length ? parts : [{ text: clean, lang: fallback(clean) }];
}

/** An utterance for one part, with the best voice the phone has for its language (or the one the listener chose). */
function utteranceFor(part, { uri, rate, pitch = 1, plainVoice = false }) {
  const u = new SpeechSynthesisUtterance(part.text);
  const voice = plainVoice ? null : pickVoice(part.lang, uri(part.lang));
  if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = part.lang;
  u.rate = rate;
  u.pitch = pitch;
  return u;
}

/** Speaks text with a voice per language (the settings screen's "preview mixed"). */
export function speakMixed(text, { lang, settings, pitch = 1 }) {
  const synth = getSynth();
  if (!synth) return [];
  synth.cancel();
  const parts = speechParts(text, { lang, settings, fallback: (t) => detectSpokenLang(t, lang) });
  const us = parts.map((p) => utteranceFor(p, { uri: (l) => settings.voiceURI?.[l], rate: settings.rate || 1, pitch }));
  setTimeout(() => us.forEach((u) => synth.speak(u)), 60); // Chrome drops speak() issued right after cancel()
  return us;
}

/**
 * Speaks a short text with the phone's own voices, one utterance per language, and resolves when it is done (or cancelled).
 * The fallback when a server voice fails.
 */
export function speakOnDevice(text, { lang, settings, rate = settings.rate || 1, pitch = 1 }) {
  const synth = getSynth();
  if (!synth) return { done: Promise.resolve(), cancel() {} };
  const parts = speechParts(text, { lang, settings, fallback: (t) => detectSpokenLang(t, lang) });
  const us = parts.map((p) => utteranceFor(p, { uri: (l) => settings.answerVoiceURI?.[l] || settings.voiceURI?.[l], rate, pitch }));
  let finished = false, resolveDone, timer;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const finish = () => { if (finished) return; finished = true; clearTimeout(timer); resolveDone(); };
  us.forEach((u, i) => {
    u.onerror = finish;
    if (i === us.length - 1) u.onend = finish;
  });
  timer = setTimeout(finish, 8000 + (parts.reduce((n, p) => n + p.text.length, 0) * 450) / rate);
  us.forEach((u) => synth.speak(u));
  return { done, cancel() { if (!finished) { synth.cancel(); finish(); } } };
}

// ---------------------------------------------------------------- text preparation
// cleanForSpeech (make text friendlier for speech engines: they read some symbols aloud) lives in speech-plan.js, which the
// server uses too; it is exported from here as well because this is where the rest of the app expects it.
export { cleanForSpeech };

const cleanMarkdown = (s) => cleanForSpeech(s.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '').replace(/^\s*>+\s*/gm, '').replace(/\[([^\]]+)]\([^)]*\)/g, '$1'));

/**
 * Splits a streamed answer into speakable sentences as soon as they are complete. The same sentence rules as for the
 * book are used (segmenter.js), so "Dr. Chen", « French quotations », "he said" after a quote and the full stops of
 * Arabic, Hindi, Thai-script and other languages are all handled; a sentence is released once the character after its
 * full stop has arrived, because that character decides whether it really ended there.
 */
export class SentenceStream {
  constructor(lang = '') { this.buf = ''; this.count = 0; this.lang = lang; }

  push(delta) { this.buf += delta; return this.drain(false); }
  end() { return this.drain(true); }

  drain(final) {
    const out = [];
    // Long sentences are cut at commas: some engines (notably Chrome's online voices) stop after ~15 s of one utterance.
    const emit = (raw) => {
      const t = cleanMarkdown(raw);
      if (!t) return;
      const cjk = cjkRatio(t) > 0.3;
      const max = cjk ? 60 : 170;
      for (const part of t.length > max ? breakLong(t, max, { lang: this.lang }) : [t]) { out.push(part); this.count++; }
    };
    const { sentences, rest } = scanSentences(this.buf, { final, newlineEnds: true, lang: this.lang });
    this.buf = rest;
    for (const sentence of sentences) emit(sentence);
    if (!final) {
      if (this.count === 0 && this.buf.length >= 14) { // start talking early: the first clause is enough
        const b = this.buf;
        const m = Math.max(b.lastIndexOf('，'), b.lastIndexOf('、'), b.lastIndexOf(','), b.lastIndexOf('：'), b.lastIndexOf(':'));
        if (m >= 8) { this.buf = b.slice(m + 1); emit(b.slice(0, m + 1)); }
      }
      while (this.buf.length > 140) { // a sentence that never ends: cut it at a space or comma
        const b = this.buf;
        const sp = Math.max(b.lastIndexOf(' ', 120), b.lastIndexOf('，', 120), b.lastIndexOf(',', 120));
        const cut = sp > 40 ? sp + 1 : 120;
        this.buf = b.slice(cut);
        emit(b.slice(0, cut));
      }
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
    // One utterance per run of one language ("我昨天在 | Apple Store | 買了…"), spoken back to back; the unit is still ONE
    // position: it starts when its first part starts and ends when its last part ends. A retry speaks it plainly, as one part.
    const parts = attempt > 0 ? [{ text, lang: this.unitLang(text) }] : speechParts(this.sents[i], { lang: this.lang, settings: s, fallback: (t) => this.unitLang(t) });
    const us = parts.map((p) => utteranceFor(p, { uri: (l) => s.voiceURI?.[l], rate: s.rate || 1, plainVoice: attempt > 0 }));
    const first = us[0], last = us[us.length - 1];
    for (const u of us) this.live.add(u);
    const ms = (n) => 5000 + (n * 450) / (s.rate || 1);

    first.onstart = () => {
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
    for (const u of us) u.onend = () => { this.live.delete(u); };
    last.onend = () => {
      this.live.delete(last);
      if (gen !== this.gen) return;
      clearTimeout(this.watchdog);
      if (i >= this.sents.length - 1) this.finish(gen);
      else if (this.queued === i) this.enqueue(i + 1, gen);
    };
    const onError = (u) => (e) => {
      this.live.delete(u);
      if (gen !== this.gen) return;
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      if (e.error === 'not-allowed') { this.hardStop(); this.emit('state'); this.emit('blocked'); return; }
      this.errors++;
      if (attempt === 0) { synth.cancel(); this.queued = i - 1; setTimeout(() => this.enqueue(i, gen, 1), 80); return; }
      if (this.errors >= 4) { this.hardStop(); this.emit('state'); this.emit('error', e.error); return; }
      this.queued = i; this.enqueue(i + 1, gen);
    };
    for (const u of us) u.onerror = onError(u); // a part that fails restarts the whole unit, plainly (attempt 1)

    this.queued = i;
    for (const u of us) synth.speak(u);
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

  unitLang(text) { return unitLang(this.lang, text); }
}

/** The language a speech unit is read in: the book's, unless a Chinese/Japanese/Korean book quotes a whole sentence in another language. */
export function unitLang(bookLang, text) {
  if (/^(zh|ja|ko)/.test(bookLang)) {
    const d = detectSpokenLang(text, bookLang);
    return /^(zh|ja|ko)/.test(d) ? bookLang : d;
  }
  return bookLang;
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
    if (!speakable(cleanForSpeech(text))) return;
    const s = this.getSettings();
    // The answer is in the language of the question (that is what the AI is told to use), which is not necessarily the book's
    // or the interface's: so that is the language the voices are planned around. Words in other scripts get their own voice.
    const lang = this.getFallbackLang();
    const parts = speechParts(text, { lang, settings: s, fallback: (t) => detectSpokenLang(t, lang) });
    for (const part of parts) this.pushPart(part, s);
  }

  pushPart(part, s) {
    const clean = part.text;
    const u = utteranceFor(part, { uri: (l) => s.answerVoiceURI?.[l] || s.voiceURI?.[l], rate: Math.min(2, (s.rate || 1) * 1.02), pitch: s.answerPitch || 1 });
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
