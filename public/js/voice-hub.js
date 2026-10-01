// Chooses between the two voice engines — the phone's own (tts.js) and the server's (audio-voice.js) — and presents them to the
// app as ONE narrator and ONE answer speaker, so the rest of the app does not care which is in use.
//
// The listener's choice (Settings → Voice engine) is the first thing that decides; the second is whether the server voices keep
// working: when a clip cannot be had (server down, wrong key, offline…) the engine falls back to the phone's voices right where it
// was, tells the app once, and stays there until the listener chooses an engine again.
import { ttsSupported } from './tts.js';

export class VoiceEngine extends EventTarget {
  /** @param wantServer () => whether the listener chose the server voices and they are usable */
  constructor(wantServer, { canFallBack = ttsSupported } = {}) {
    super();
    this.wantServer = wantServer;
    this.canFallBack = canFallBack;
    this.failed = false;
  }

  /** 'server' or 'device' — the engine to use right now. */
  get kind() { return this.wantServer() && !this.failed ? 'server' : 'device'; }

  /** The server voices failed. Returns whether the phone's voices take over (they cannot when the phone has none). */
  fail(detail) {
    if (this.failed || !this.canFallBack()) return false;
    this.failed = true;
    this.dispatchEvent(new CustomEvent('fallback', { detail }));
    return true;
  }

  /** Try the server voices again (the listener chose an engine). */
  retry() { this.failed = false; }
}

const NARRATOR_EVENTS = ['index', 'state', 'end', 'blocked', 'error'];

export class NarratorHub extends EventTarget {
  constructor(device, server, engine) {
    super();
    this.device = device; this.server = server; this.engine = engine;
    this.kind = 'device';
    this.sents = []; this.lang = 'en-US';
    for (const name of ['device', 'server']) {
      for (const type of NARRATOR_EVENTS) this[name].addEventListener(type, (e) => this.relay(name, type, e.detail));
    }
  }

  get cur() { return this[this.kind]; }
  get idx() { return this.cur.idx; }
  get playing() { return this.cur.playing; }

  /** Only the engine in use speaks to the app; the server's errors are handled here. */
  relay(name, type, detail) {
    if (name !== this.kind) return;
    if (type === 'error' && name === 'server' && this.recover(detail)) return;
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** The server voices failed while reading: carry on with the phone's voices from the same unit. */
  recover(detail) {
    const idx = this.server.idx;
    if (!this.engine.fail(detail)) return false;
    this.sync();
    this.device.play(idx);
    return true;
  }

  /** Moves to the engine the listener wants, keeping the position. Returns whether it changed. */
  sync() {
    const want = this.engine.kind;
    if (want === this.kind) return false;
    const idx = this.cur.idx;
    this.cur.hardStop();
    this.kind = want;
    this.cur.load(this.sents, this.lang, idx);
    return true;
  }

  load(sents, lang, idx = 0) {
    this.sents = sents; this.lang = lang;
    this.cur.hardStop();
    this.kind = this.engine.kind;
    this.cur.load(sents, lang, idx);
  }

  /** The engine setting changed: switch, and carry on reading if it was reading. */
  refresh() {
    const was = this.playing, idx = this.idx;
    this.sync();
    if (was) this.cur.play(idx);
  }

  play(from = this.idx) { this.sync(); this.cur.play(from); }
  pause() { this.cur.pause(); }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(i) { this.sync(); this.cur.seek(i); }
  hardStop() { this.cur.hardStop(); }
}

export class AnswerHub {
  constructor(device, server, engine) {
    this.device = device; this.server = server; this.engine = engine;
    this.kind = 'device';
  }

  get cur() { return this[this.kind]; }
  get spoken() { return this.cur.spoken; }

  begin() { this.kind = this.engine.kind; return this.cur.begin(); }
  push(text) { this.cur.push(text); }
  finish() { this.cur.finish(); }
  cancel() { this.device.cancel(); this.server.cancel(); }
  async say(text) { this.kind = this.engine.kind; return this.cur.say(text); }
}
