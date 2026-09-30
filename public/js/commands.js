// Turns the AI's tool calls into a plan for the player.
//
// The AI decides WHAT the listener meant (that is the point of using tool calling instead of keyword rules); this
// module only checks the arguments it produced and works out the consequences. It is pure — no DOM, no audio — so
// every case is unit-tested, and nothing it returns can reach past the listener's position: the only searching it
// does is over text they have already heard.
import { tokenize } from './retrieval.js';

export const CMD = { MAX_QUESTION: 300, MAX_CALLS: 4, MAX_COUNT: 500, MIN_RATE: 0.5, MAX_RATE: 2.5, MAX_MINUTES: 600, PASSAGE_LEAD: 8 };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** Models sometimes send numbers as strings ("3"); accept those, nothing else. */
const num = (v) => (isNum(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN);
const int = (v) => { const n = num(v); return Number.isFinite(n) ? Math.round(n) : NaN; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * The most likely place in the already-heard text for a few search words: the passage is found with the retrieval index
 * (chunks strictly before the listener), refined to the best sentence, then the reading restarts a little before it.
 * Returns a unit index <= pos, or -1.
 */
export function findHeardPassage(query, { book, retr, pos }) {
  const wanted = new Set(tokenize(String(query || '')));
  if (!wanted.size) return -1;
  const known = pos + 1;
  const ranges = retr.search(query, '', known, { limit: 3, minRatio: 0 }).map((h, rank) => ({ s: h.s, e: h.e, rank }));
  const next = retr.chunksBefore(known);
  if (next < retr.chunks.length) ranges.push({ s: retr.chunks[next][0], e: known, rank: 1.5 }); // the chunk being read now
  let best = null;
  for (const r of ranges) {
    for (let i = r.s; i < Math.min(r.e, known); i++) {
      let hit = 0;
      for (const w of new Set(tokenize(book.sents[i]))) if (wanted.has(w)) hit++;
      if (!hit) continue;
      // more matched words first, then the retrieval ranking, then the more recent sentence
      if (!best || hit > best.hit || (hit === best.hit && (r.rank < best.rank || (r.rank === best.rank && i > best.i)))) best = { i, hit, rank: r.rank };
    }
  }
  if (!best || best.hit < Math.max(1, Math.floor(wanted.size / 3))) return -1;
  return Math.max(book.paraStartOf(best.i), best.i - CMD.PASSAGE_LEAD, 0);
}

/**
 * @param {{name:string,input:object}[]} calls  tool calls in the order the AI made them
 * @param {{book, pos:number, rate:number, retr, answered?:boolean}} env  `pos` = unit being read when the listener spoke;
 *        `answered` = the AI also wrote a text reply, so a question passed to ask_listener need not be spoken again
 * @returns {{steps:{name,ok,msg:{key,params},title?}[], effect:{pos:number|null, play:boolean|null, rate:number|null, sleep:object|null, listen:boolean}}}
 *   `effect` is what the app should do once the confirmations have been spoken; null = leave as is.
 */
export function planCommands(calls, env) {
  const { book } = env;
  const effect = { pos: null, play: null, rate: null, sleep: null, listen: false };
  const steps = [];
  let cur = env.pos;
  const fail = (name, key, params = {}) => steps.push({ name, ok: false, msg: { key, params } });
  const ok = (name, key, params = {}, extra = {}) => steps.push({ name, ok: true, msg: { key, params }, ...extra });
  const moveTo = (i) => { cur = i; effect.pos = i; effect.play = true; };

  for (const call of (Array.isArray(calls) ? calls : []).slice(0, CMD.MAX_CALLS)) {
    const name = call?.name;
    const a = call?.input && typeof call.input === 'object' ? call.input : {};
    switch (name) {
      case 'rewind_sentences': {
        const n = int(a.count);
        if (!(n >= 1)) { fail(name, 'cmd.invalid'); break; }
        const before = cur;
        if (before === 0) { moveTo(0); ok(name, 'cmd.atStart'); break; }
        const to = Math.max(0, before - Math.min(n, CMD.MAX_COUNT));
        moveTo(to);
        ok(name, 'cmd.rewind', { n: before - to });
        break;
      }
      case 'skip_forward_sentences': {
        const n = int(a.count);
        if (!(n >= 1)) { fail(name, 'cmd.invalid'); break; }
        const last = book.length - 1;
        if (cur >= last) { fail(name, 'cmd.atEnd'); break; }
        moveTo(Math.min(last, cur + Math.min(n, CMD.MAX_COUNT)));
        ok(name, 'cmd.skip', { n: Math.min(n, CMD.MAX_COUNT) });
        break;
      }
      case 'go_to_chapter': {
        const n = int(a.chapter_number ?? a.chapter);
        if (!(n >= 1)) { fail(name, 'cmd.invalid'); break; }
        const count = book.chapters.length;
        if (n > count) { fail(name, 'cmd.noChapter', { n, count }); break; }
        moveTo(book.chapters[n - 1].start);
        ok(name, 'cmd.chapter', { n }, { title: book.chapters[n - 1].title });
        break;
      }
      case 'jump_to_earlier_passage': {
        if (typeof a.search_terms !== 'string' || !a.search_terms.trim()) { fail(name, 'cmd.invalid'); break; }
        // Bounded by where the listener was when they spoke, however far earlier commands in the same breath moved them.
        const found = findHeardPassage(a.search_terms, { book, retr: env.retr, pos: env.pos });
        if (found < 0) { fail(name, 'cmd.passageNone'); break; }
        moveTo(found);
        ok(name, 'cmd.passage');
        break;
      }
      case 'seek_to_percent': {
        const p = num(a.percent);
        if (!isNum(p)) { fail(name, 'cmd.invalid'); break; }
        const pct = clamp(Math.round(p), 0, 100);
        moveTo(book.unitAtFraction(pct / 100));
        ok(name, 'cmd.percent', { p: pct });
        break;
      }
      case 'stop_reading': effect.play = false; ok(name, 'cmd.stop'); break;
      case 'resume_reading': effect.play = true; ok(name, 'cmd.resume'); break;
      case 'set_reading_speed': {
        const r = num(a.rate);
        if (!isNum(r) || r <= 0) { fail(name, 'cmd.invalid'); break; }
        const rate = Math.round(clamp(r, CMD.MIN_RATE, CMD.MAX_RATE) * 20) / 20;
        effect.rate = rate;
        ok(name, 'cmd.speed', { rate: String(rate) });
        break;
      }
      case 'set_sleep_timer': {
        if (a.mode === 'off') { effect.sleep = { mode: 'off' }; ok(name, 'sleep.toastOff'); break; }
        if (a.mode === 'end_of_chapter') { effect.sleep = { mode: 'chapter' }; ok(name, 'sleep.toastChapter'); break; }
        const m = int(a.minutes);
        if (a.mode !== 'minutes' || !(m >= 1)) { fail(name, 'cmd.invalid'); break; }
        const minutes = Math.min(m, CMD.MAX_MINUTES);
        effect.sleep = { mode: 'minutes', minutes };
        ok(name, 'sleep.toastMinutes', { n: minutes });
        break;
      }
      case 'ask_listener': { // speak the AI's question, then open the microphone; never open it in silence
        effect.listen = true;
        const question = typeof a.question === 'string' ? a.question.trim().slice(0, CMD.MAX_QUESTION) : '';
        if (env.answered) break; // it also wrote the question as text, which is spoken already
        if (question) steps.push({ name, ok: true, msg: { text: question } });
        else ok(name, 'cmd.askAgain');
        break;
      }
      default: fail(String(name), 'cmd.unknown');
    }
  }
  return { steps, effect };
}
