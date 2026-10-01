// UI + orchestration. The interesting logic lives in small modules; this file wires them to the screen:
//   library / import  →  Book  →  Narrator (TTS)  ⇄  ask flow (STT → context builder → AI → spoken answer → resume)
import * as lib from './library.js';
import * as ai from './ai.js';
import { Book, buildBookData, resegmentBook } from './book.js';
import { SEG_VERSION } from './segmenter.js';
import { parseBookFile, parsePastedText, ACCEPT } from './parsers/index.js';
import { Narrator, AnswerSpeaker, SentenceStream, loadVoices, voicesFor, pickVoice, ttsSupported, cleanForSpeech, speakMixed, speakOnDevice, mixedMode } from './tts.js';
import { AudioOut, AudioNarrator, AudioAnswerSpeaker } from './audio-voice.js';
import { VoiceEngine, NarratorHub, AnswerHub } from './voice-hub.js';
import { Listener, sttSupported } from './stt.js';
import { VoiceRecorder, recorderSupported } from './recorder.js';
import { ShakeListener, thresholdFromSlider, sliderFromThreshold, formatThreshold } from './shake.js';
import { Feedback } from './feedback.js';
import { Session } from './session.js';
import { MemoryTree, MemoryBuilder } from './memory.js';
import { RetrievalIndex } from './retrieval.js';
import { buildAskContext } from './context.js';
import { planCommands } from './commands.js';
import { normalizeTag, detectSpokenLang } from './lang.js';
import { sleep, gapBetween } from './util.js';
import { t, tIn, setLang, applyI18n, isLang, resolveLang, LANG_AUTO } from './i18n.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ state
const S = {
  settings: lib.loadSettings(),
  config: { ai: false },
  book: null, tree: null, builder: null, retr: null, qa: [],
  mode: 'idle',          // idle | listening | thinking | answering
  resumeAfter: false,    // was the book playing when the listener interrupted?
  askPos: 0,             // unit being read at the moment of interruption
  askSeq: 0,             // bumped to invalidate any in-flight ask
  followUps: 0,          // how many times in a row the AI has reopened the microphone for a reply
  askAbort: null,
  interim: '',
  shakeStatus: '',       // motion sensor state for the settings screen
  shakeSeenAt: 0,        // last time a shake was detected (shown in settings as feedback)
  micReady: false,       // the microphone is really recording (the ready beep has played)
  questionLang: '',      // language of the current question (detected from the cloud transcript)
  thinkingNote: '',      // 'recognising…' vs 'thinking…' label while waiting
  answerText: '',
  ticks: null,
  ceiling: 0,            // summaries are only produced up to what has been listened to (cost control)
  sleep: { mode: 0, end: 0, chapter: -1, timer: null, due: false },
  saveTimer: null, memTimer: null, lastSaved: -1,
  scrubbing: false,
};

const getSettings = () => S.settings;
// Two voice engines — the phone's own (default) and the server's, played as audio — behind one narrator and one answer speaker.
// The server's is used when the listener chose it in Settings and the server has it; if it fails the phone's voices take over.
const serverVoicesUsable = () => Boolean(S.config.tts?.available) && !S.config.offline;
const engine = new VoiceEngine(() => S.settings.engine === 'server' && serverVoicesUsable());
const audioOut = new AudioOut();
const answerLang = () => S.questionLang || askLang();
const narrator = new NarratorHub(new Narrator(getSettings), new AudioNarrator(getSettings, { out: audioOut }), engine);
const answerer = new AnswerHub(
  new AnswerSpeaker(getSettings, answerLang),
  new AudioAnswerSpeaker(getSettings, answerLang, { out: audioOut, speakDevice: speakOnDevice, onFail: (err) => engine.fail(err?.message || '') }),
  engine,
);
const listener = new Listener();
const feedback = new Feedback(getSettings);
const recorder = new VoiceRecorder(() => feedback.ctx);
const shake = new ShakeListener({ onShake: () => onShake(), onStatus: (st) => { S.shakeStatus = st; renderShakeInfo(); } });
const session = new Session({
  play: () => { if (!narrator.playing) togglePlay(); },
  pause: () => { if (narrator.playing) togglePlay(); },
  prev: () => jump(-1),
  next: () => jump(1),
}, getSettings);

// ------------------------------------------------------------------ small helpers
function toast(msg, kind = '', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
const announce = (msg) => { $('liveStatus').textContent = ''; setTimeout(() => { $('liveStatus').textContent = msg; }, 30); };

function askLang() {
  const v = S.settings.askLang;
  if (v === 'book') return S.book?.lang || 'en-US';
  if (v === 'auto') return normalizeTag(navigator.language) || 'zh-TW';
  return v;
}

/** Which recognizer handles a spoken question: 'cloud' (uploaded recording), 'device' (browser built-in) or 'typed'. */
function sttPlan() {
  const cloud = Boolean(S.config.stt?.available) && recorderSupported();
  const device = sttSupported();
  if (S.settings.sttMode === 'device') return device ? 'device' : cloud ? 'cloud' : 'typed';
  if (cloud) return 'cloud';
  return device ? 'device' : 'typed';
}
const cloudLangCode = () => (S.settings.cloudLang && S.settings.cloudLang !== 'auto' ? S.settings.cloudLang : '');

function fmtDuration(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  const m = Math.round(sec / 60);
  if (m < 1) return t('dur.lt1');
  if (m < 60) return t('dur.min', { m });
  const h = Math.floor(m / 60);
  return t('dur.hour', { h, rem: m % 60 });
}

let speechUnlocked = false;
function unlockSpeech() { // iOS only lets speechSynthesis (and a fresh <audio> element) start from a user gesture; prime them once
  if (engine.kind === 'server') audioOut.unlock();
  if (speechUnlocked || !ttsSupported()) return;
  speechUnlocked = true;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ screens & sheets
function showScreen(name) {
  $('player').hidden = name !== 'player';
  $('library').hidden = name !== 'library';
  if (name === 'library') refreshLibrary();
}
const openLibrary = () => showScreen('library');

let openSheetId = null;
function openSheet(id) {
  closeSheets();
  openSheetId = id;
  $(id).hidden = false;
  $('sheetBackdrop').hidden = false;
}
/** Close the open sheet as the user's "never mind" (a typed question in progress is cancelled and the book resumes). */
function dismissSheet() {
  if (openSheetId === 'askSheet') cancelAsk({ resume: true });
  closeSheets();
}
function closeSheets() {
  if (!openSheetId) return;
  $(openSheetId).hidden = true;
  $('sheetBackdrop').hidden = true;
  openSheetId = null;
}

// ------------------------------------------------------------------ rendering
function setMode(mode) {
  S.mode = mode;
  renderAsk();
  renderPlay();
  const said = { listening: t('status.listening'), thinking: t('status.thinking'), answering: t('status.answering'), idle: '' }[mode];
  if (said) announce(said);
}

function renderAsk() {
  const btn = $('askBtn');
  btn.className = `ask ${S.mode}${S.book ? '' : ' disabled'}`;
  const typed = sttPlan() === 'typed';
  let label = t('ask.idle.label'), sub = S.settings.shake ? t('ask.idle.subShake') : t('ask.idle.sub'), aria = t('ask.idle.aria');
  if (typed) { label = t('ask.typed.label'); sub = t('ask.typed.sub'); }
  if (S.mode === 'listening') { label = S.micReady ? t('ask.listen.label') : t('ask.listen.prep'); sub = t('ask.listen.sub'); aria = t('ask.listen.aria'); }
  if (S.mode === 'thinking') { label = S.thinkingNote || t('ask.think.label'); sub = t('ask.think.sub'); aria = t('ask.think.aria', { label }); }
  if (S.mode === 'answering') { label = t('ask.answer.label'); sub = t('ask.answer.sub'); aria = t('ask.answer.aria'); }
  $('askLabel').textContent = label;
  $('askSub').textContent = sub;
  btn.setAttribute('aria-label', aria);
  renderCaption();
}

/**
 * The scrollable text area under the big button: the sentence being read, the question being heard, or the AI's
 * answer as it streams in. Long text scrolls instead of being cut off. The view stays at the START of the text
 * (new text never drags it down); the reader scrolls down themselves. A streaming answer only grows at its end,
 * so a position the reader scrolled to is kept; anything else (a new sentence, a new answer) starts from the top.
 */
function renderCaption() {
  const box = $('caption'), p = $('captionText');
  let text = '';
  if (!S.book) text = '';
  else if (S.mode === 'listening' || S.mode === 'thinking') text = S.interim ? t('quote', { s: S.interim }) : '';
  else if (S.mode === 'answering') text = S.answerText;
  else text = S.book.sents[narrator.idx] || '';
  const previous = p.textContent;
  if (previous === text && box.dataset.mode === S.mode) return;
  const growing = box.dataset.mode === S.mode && previous && text.startsWith(previous);
  box.dataset.mode = S.mode;
  p.textContent = text;
  p.classList.toggle('long', text.length > 70);
  box.classList.toggle('bright', S.mode !== 'idle');
  if (!growing) box.scrollTop = 0;
  box.classList.toggle('scrolls', box.scrollHeight > box.clientHeight + 2);
}

function renderPlay() {
  const playing = narrator.playing && S.mode === 'idle';
  $('iconPlay').hidden = playing;
  $('iconPause').hidden = !playing;
  const label = S.mode !== 'idle' ? t('play.resume') : playing ? t('play.pause') : t('play.play');
  $('playLabel').textContent = label;
  $('btnPlay').setAttribute('aria-label', label);
}

function renderProgress() {
  const b = S.book;
  if (!b) return;
  const i = narrator.idx;
  const frac = b.fractionBefore(i);
  if (!S.scrubbing) {
    const v = Math.round(frac * 1000);
    $('seek').value = v;
    $('seek').style.setProperty('--fill', `${v / 10}%`);
  }
  $('pctText').textContent = `${Math.round(frac * 100)}%`;
  const remainingChars = b.cumChars[b.length] - b.cumChars[i];
  const cps = (b.cjk ? 4.6 : 14) * (S.settings.rate || 1);
  $('leftText').textContent = remainingChars > 0 ? t('time.left', { t: fmtDuration(remainingChars / cps) }) : t('time.done');
  const ci = b.chapterIndexOf(i);
  $('chapterLine').textContent = b.chapters.length > 1 ? `${b.chapters[ci].title} · ${ci + 1}/${b.chapters.length}` : b.chapters[ci]?.title || '';
  $('btnChapterPicker').setAttribute('aria-label', t('picker.ariaCurrent', { title: b.chapters[ci]?.title || '' }));
}

function renderChips() {
  $('chipSpeed').textContent = `${(S.settings.rate || 1).toFixed(2).replace(/0$/, '')}×`;
  const sl = S.sleep;
  let text = t('sleep.off');
  if (sl.mode > 0) text = t('sleep.minutes', { n: Math.max(1, Math.ceil((sl.end - Date.now()) / 60000)) });
  if (sl.mode === -1) text = t('sleep.chapter');
  $('chipSleep').textContent = text;
  $('chipSleep').classList.toggle('on', sl.mode !== 0);
}

function renderBanner() {
  const el = $('banner');
  let msg = '', kind = '';
  if (!ttsSupported() && engine.kind !== 'server') msg = t('banner.noTts');
  else if (S.config.offline) { msg = t('banner.offline'); kind = 'info'; }
  else if (!S.config.ai) msg = t('banner.noAi');
  else if (S.config.needsToken && !S.settings.accessToken) msg = t('banner.needToken');
  el.hidden = !msg;
  el.textContent = msg;
  el.className = `banner ${kind}`;
}

function renderAll() {
  const b = S.book;
  $('bookTitle').textContent = b ? b.title : t('book.none');
  renderAsk(); renderPlay(); renderProgress(); renderChips(); renderBanner();
}

// ------------------------------------------------------------------ opening a book
/** A book imported with older sentence rules is cut again, keeping the listener's place (see resegmentBook). */
async function upgradeSegmentation(rec) {
  try {
    const { data, mapIndex } = resegmentBook(rec);
    const idx = mapIndex(await lib.getProgress(rec.id));
    const qa = (await lib.getQA(rec.id)).map((item) => ({ ...item, pos: mapIndex(item.pos) }));
    await lib.upgradeBook(rec.id, data, { idx, qa });
    toast(t('book.resegmented'), '', 7000);
    return { ...rec, ...data };
  } catch (err) {
    console.error('[segmentation] could not re-cut the book; keeping the old cuts', err);
    return rec;
  }
}

async function openBook(id) {
  let rec = await lib.loadBookRecord(id);
  if (!rec) { toast(t('book.missing'), 'error'); return; }
  if ((rec.seg ?? 1) < SEG_VERSION) rec = await upgradeSegmentation(rec);
  saveProgressNow(); saveMemoryNow();
  cancelAsk({ resume: false, silent: true });
  narrator.hardStop();
  S.builder?.stop();
  session.release();

  const book = new Book(rec);
  const idx = Math.max(0, Math.min(await lib.getProgress(id), book.length - 1));
  S.book = book;
  S.tree = new MemoryTree(book);
  const mem = await lib.getMemory(id);
  S.ceiling = 0;
  if (mem && S.tree.load(mem)) S.ceiling = mem.ceiling ?? 0;
  else if (idx === 0) S.ceiling = 0;
  S.retr = new RetrievalIndex(book);
  S.qa = await lib.getQA(id);
  S.builder = new MemoryBuilder({
    book, tree: S.tree, summarize: ai.summarize, concurrency: 2,
    onChange: saveMemorySoon, onStatus: () => { if (openSheetId === 'settingsSheet') renderMemInfo(); },
  });
  narrator.load(book.sents, book.lang, idx);
  S.lastSaved = idx;
  try { localStorage.setItem(lib.LAST_BOOK_KEY, id); } catch { /* ignore */ }
  lib.touchBook(id);
  updateMediaMetadata();
  showScreen('player');
  renderAll();
  updateBuilder();
  scheduleIndexing();
}

function updateMediaMetadata() {
  const b = S.book;
  if (!b) return;
  session.setMetadata({ title: b.title, artist: b.author || t('app.title'), album: b.chapterOf(narrator.idx)?.title || '' });
}

// ------------------------------------------------------------------ progress, memory & indexing
function saveProgressSoon() {
  if (S.saveTimer) return;
  S.saveTimer = setTimeout(() => { S.saveTimer = null; saveProgressNow(); }, 4000);
}
function saveProgressNow() {
  clearTimeout(S.saveTimer); S.saveTimer = null;
  if (!S.book || S.lastSaved === narrator.idx) return;
  S.lastSaved = narrator.idx;
  lib.saveProgress(S.book.id, narrator.idx).catch(() => {});
}

function saveMemoryNow() {
  clearTimeout(S.memTimer); S.memTimer = null;
  if (S.book && S.tree) lib.saveMemory(S.book.id, { ...S.tree.dump(), ceiling: S.ceiling }).catch(() => {});
}
function saveMemorySoon() {
  clearTimeout(S.memTimer);
  S.memTimer = setTimeout(saveMemoryNow, 1500);
}

/** The summariser may work up to the listener's position, but never beyond what they have actually listened to. */
function updateBuilder() {
  if (!S.builder || !S.config.ai) return;
  S.builder.setKnown(Math.min(S.ceiling, narrator.idx + 1));
}

let indexing = false;
function scheduleIndexing() {
  if (indexing || !S.retr) return;
  indexing = true;
  const step = () => {
    const retr = S.retr;
    if (!retr) { indexing = false; return; }
    const limit = narrator.idx + 1;
    const before = retr.indexedChunks;
    retr.ensure(limit, 8);
    const more = retr.indexedChunks < retr.chunks.length && retr.chunks[retr.indexedChunks][1] <= limit;
    if (more && retr.indexedChunks !== before) setTimeout(step, 20); else indexing = false;
  };
  setTimeout(step, 0);
}

// ------------------------------------------------------------------ narration events
narrator.addEventListener('index', (e) => {
  const i = e.detail;
  if (!S.book) return;
  const d = i + 1 - S.ceiling;
  if (d > 0 && d <= 4) S.ceiling = i + 1;
  updateBuilder();
  saveProgressSoon();
  if (i % 8 === 0 || i === S.book.length - 1) scheduleIndexing();
  const sl = S.sleep;
  if (sl.mode === -1 && S.book.chapterIndexOf(i) !== sl.chapter && narrator.playing) { narrator.pause(); doSleep(); }
  renderProgress();
  if (S.mode === 'idle') renderCaption();
  if (i === S.book.chapters[S.book.chapterIndexOf(i)].start) updateMediaMetadata();
  if (openSheetId === 'textSheet') updateTextSheet();
});
narrator.addEventListener('state', () => { renderPlay(); });
narrator.addEventListener('end', () => {
  saveProgressNow();
  session.release();
  feedback.cue('sleep');
  toast(t('book.finished'));
  renderPlay();
});
engine.addEventListener('fallback', (e) => {
  toast(t('toast.engineFallback', { detail: e.detail || '?' }), 'error', 9000);
  renderBanner();
  if (openSheetId === 'settingsSheet') renderVoiceRows();
});
narrator.addEventListener('blocked', () => { toast(t('toast.blocked')); session.release(); });
narrator.addEventListener('error', (e) => { toast(t('toast.ttsError', { detail: e.detail }), 'error', 8000); session.release(); });

// ------------------------------------------------------------------ transport
async function togglePlay() {
  feedback.unlock(); unlockSpeech();
  if (!S.book) { openLibrary(); return; }
  if (S.mode !== 'idle') { cancelAsk({ resume: true }); return; }
  if (narrator.playing) {
    narrator.pause(); session.release(); saveProgressNow(); saveMemoryNow(); feedback.vibrate(15);
  } else {
    narrator.play(); session.engage(); feedback.vibrate(15);
  }
  renderPlay();
}

function jump(dir) {
  const b = S.book;
  if (!b) return;
  unlockSpeech(); feedback.unlock();
  if (S.mode !== 'idle') cancelAsk({ resume: false, silent: true });
  const i = narrator.idx;
  let target;
  if (dir < 0) {
    const ps = b.paraStartOf(i);
    target = i - ps > 1 ? ps : b.paraStartOf(Math.max(0, ps - 1));
    target = Math.max(target, i - 8, 0);
  } else {
    target = Math.min(b.nextParaStart(i), i + 8, b.length - 1);
  }
  feedback.vibrate(20);
  narrator.seek(target);
  if (narrator.playing) session.engage();
}

function jumpChapter(dir) {
  const b = S.book;
  if (!b) return;
  if (S.mode !== 'idle') cancelAsk({ resume: false, silent: true });
  const ci = b.chapterIndexOf(narrator.idx);
  const atStart = narrator.idx === b.chapters[ci].start;
  const target = dir < 0 ? (atStart ? Math.max(0, ci - 1) : ci) : Math.min(b.chapters.length - 1, ci + 1);
  feedback.cue('chapter');
  narrator.seek(b.chapters[target].start);
  toast(b.chapters[target].title, '', 2500);
  if (narrator.playing) session.engage();
}

function bindTapHold(el, onTap, onHold, ms = 550) {
  let timer = null, held = false;
  const end = () => { clearTimeout(timer); el.classList.remove('holding'); };
  el.addEventListener('pointerdown', () => {
    held = false;
    timer = setTimeout(() => { held = true; el.classList.add('holding'); feedback.vibrate(40); onHold(); }, ms);
  });
  el.addEventListener('pointerup', () => { const was = held; end(); if (!was) onTap(); });
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', end);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('click', (e) => { if (e.detail === 0) onTap(); }); // keyboard / assistive tech
}

const SPEEDS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];
function cycleSpeed() {
  const cur = S.settings.rate || 1;
  const next = SPEEDS.find((s) => s > cur + 0.001) ?? SPEEDS[0];
  setRate(next);
}
function setRate(r) {
  S.settings.rate = r;
  lib.saveSettings(S.settings);
  renderChips(); renderProgress();
  if (narrator.playing && S.mode === 'idle') narrator.play(narrator.idx);
  if ($('setRate')) { $('setRate').value = r; $('rateVal').textContent = `${r.toFixed(2).replace(/0$/, '')}×`; }
}

/** mode: 0 = off, -1 = end of the chapter containing `atUnit`, n > 0 = n minutes from now. */
function applySleep(mode, atUnit = narrator.idx) {
  clearTimeout(S.sleep.timer);
  S.sleep = { mode, end: mode > 0 ? Date.now() + mode * 60000 : 0, chapter: mode === -1 && S.book ? S.book.chapterIndexOf(atUnit) : -1, timer: null, due: false };
  if (mode > 0) S.sleep.timer = setTimeout(onSleepDue, mode * 60000);
  renderChips();
}
function cycleSleep() {
  const steps = [0, 15, 30, 60, -1];
  const next = steps[(steps.indexOf(S.sleep.mode) + 1) % steps.length];
  applySleep(next);
  feedback.vibrate(15);
  toast(next === 0 ? t('sleep.toastOff') : next === -1 ? t('sleep.toastChapter') : t('sleep.toastMinutes', { n: next }), '', 2200);
}
/** The player's controls as the AI needs to know them ("a bit faster" and "the next chapter" are relative to this). */
function playerState() {
  const sl = S.sleep;
  return {
    rate: S.settings.rate || 1,
    sleep: sl.mode > 0 ? `minutes:${Math.max(1, Math.ceil((sl.end - Date.now()) / 60000))}` : sl.mode === -1 ? 'chapter_end' : 'off',
    wasPlaying: S.resumeAfter,
  };
}
function onSleepDue() { if (S.mode !== 'idle') S.sleep.due = true; else doSleep(); }
function doSleep() {
  clearTimeout(S.sleep.timer);
  S.sleep = { mode: 0, end: 0, chapter: -1, timer: null, due: false };
  if (narrator.playing) narrator.pause();
  session.release(); saveProgressNow();
  feedback.cue('sleep');
  renderChips(); renderPlay();
}

// ------------------------------------------------------------------ the ask flow
async function onAskPress() {
  feedback.unlock(); unlockSpeech();
  if (!S.book) { openLibrary(); return; }
  switch (S.mode) {
    case 'listening':                                                  // "I'm done talking" — or, when nothing has been said yet, "never mind"
      if (recorder.heard || S.interim.trim()) { listener.stop(); recorder.stop(); } else stopAsking();
      return;
    case 'thinking': cancelAsk({ resume: true }); return;              // changed my mind
    case 'answering': interruptAnswer(); return;                       // follow-up question
    default: beginAsk();
  }
}

function beginAsk({ typed = false } = {}) {
  const seq = ++S.askSeq;
  S.resumeAfter = narrator.playing;
  S.askPos = narrator.idx;
  S.followUps = 0;
  if (narrator.playing) narrator.pause();
  S.interim = ''; S.answerText = ''; S.questionLang = ''; S.thinkingNote = ''; S.micReady = false;
  session.engage();
  setMode('listening');
  listenThenSubmit(seq, typed);
}

async function listenThenSubmit(seq, typed = false) {
  S.interim = ''; S.answerText = ''; S.thinkingNote = ''; S.questionLang = ''; S.micReady = false;
  const plan = typed ? 'typed' : sttPlan();
  if (plan === 'typed') {
    await feedback.cue('listen');
    if (seq === S.askSeq) openTypedAsk(seq);
    return;
  }
  if (S.settings.sttMode === 'cloud' && plan !== 'cloud') toast(t('toast.cloudFallback'), '', 3500);
  // The microphone is opened FIRST; the "go ahead" beep is played only once it is really recording. (Opening a
  // microphone takes 0.2-1 s on phones, longer on Bluetooth headsets. Beeping first and opening it afterwards
  // meant the first words spoken right after the beep were never recorded.)
  const onReady = () => { if (seq === S.askSeq) { S.micReady = true; renderAsk(); feedback.cue('listen'); } };
  const res = plan === 'cloud' ? await listenCloud(seq, onReady) : await listener.listen({
    lang: askLang(), onReady,
    onInterim: (t) => { if (seq === S.askSeq) { S.interim = t; renderAsk(); } },
  });
  if (seq !== S.askSeq || res.handled) return;
  if (res.text) { submitQuestion(res.text, seq, { quiet: res.quiet }); return; }
  // Nothing usable heard.
  if (res.error === 'not-allowed') {
    toast(t('toast.micDenied'), 'error', 9000);
    await failAsk(t('say.micDenied'), seq);
  } else if (res.error === 'aborted') {
    return;
  } else if (res.error === 'no-speech') {
    await feedback.cue('cancel');
    if (seq === S.askSeq) finishAsk(seq);
  } else {
    toast(t('toast.sttFailed', { err: res.error }), 'error', 7000);
    await failAsk(t('say.sttFailed'), seq, true);
  }
}

/** Record the whole question, upload it to the cloud recognizer (handles mixed languages) and return its text. */
async function listenCloud(seq, onReady) {
  const btn = $('askBtn');
  const rec = await recorder.record({ onReady, ignoreMs: 450, onLevel: (v) => { if (seq === S.askSeq) btn.style.setProperty('--level', v.toFixed(2)); } });
  btn.style.setProperty('--level', '0');
  if (seq !== S.askSeq) return { handled: true };
  if (rec.error) return { error: rec.error === 'no-mic' ? 'no-microphone' : rec.error };
  if (!rec.speech || rec.blob.size < 1200) return { error: 'no-speech' };

  setMode('thinking'); S.thinkingNote = t('ask.recognizing'); renderAsk();
  feedback.cue('sent');
  startTicks(seq);
  const ac = new AbortController();
  S.askAbort = ac;
  const context = S.settings.sttHint && S.book ? S.book.text(Math.max(0, S.askPos - 2), S.askPos + 1).slice(-200) : '';
  try {
    const text = (await ai.transcribe({ blob: rec.blob, mime: rec.mime, language: cloudLangCode(), uiLang: askLang(), bookLang: S.book?.lang || '', context }, { signal: ac.signal })).trim();
    if (seq !== S.askSeq) return { handled: true };
    S.askAbort = null;
    if (!text) { stopTicks(); return { error: 'no-speech' }; }
    S.questionLang = detectSpokenLang(text, askLang());
    return { text, quiet: true };
  } catch (err) {
    if (seq !== S.askSeq || err?.name === 'AbortError') return { handled: true };
    console.error('[transcribe] failed', err);
    toast(err.message || t('toast.sttError'), 'error', 8000);
    await failAsk(spokenSttError(err), seq);
    return { handled: true };
  }
}

function spokenSttError(err) {
  const s = err?.status;
  if (s === 402) return t('say.stt.402');
  if (s === 429) return t('say.stt.429');
  if (s === 503) return t('say.stt.503');
  if (s === 400) return t('say.stt.400');
  if (s === 401) return t('say.stt.401');
  if (err instanceof TypeError) return t('say.offline');
  return t('say.stt.default');
}

function openTypedAsk(seq) {
  openSheet('askSheet');
  $('askText').value = '';
  setTimeout(() => $('askText').focus(), 50);
  $('askForm').dataset.seq = String(seq);
}

async function submitQuestion(text, seq, { quiet = false } = {}) {
  text = text.trim();
  if (!text) { finishAsk(seq); return; }
  S.interim = text;
  if (!S.questionLang) S.questionLang = detectSpokenLang(text, askLang()); // typed or phone-recognized: the cloud path has set it already
  S.thinkingNote = t('ask.think.label');
  if (quiet) { renderAsk(); } // already waiting (cues and ticks are running) after cloud recognition
  else { setMode('thinking'); feedback.cue('sent'); startTicks(seq); }

  if (!S.config.ai) { await failAsk(S.config.offline ? t('say.serverOffline') : t('say.aiNotReady'), seq); return; }
  const pos = S.askPos;
  S.ceiling = Math.max(S.ceiling, pos + 1); // a question is the signal that the listener wants the memory caught up
  updateBuilder();
  saveMemorySoon();

  let ctx;
  try {
    ctx = buildAskContext({ book: S.book, pos, question: text, tree: S.tree, retr: S.retr, history: S.qa, lang: S.questionLang || askLang(), includeTitle: S.settings.sendTitle, player: playerState() });
  } catch (err) {
    console.error(err);
    await failAsk(t('say.contextError'), seq);
    return;
  }
  console.debug('[ask] context', ctx.meta);

  const ac = new AbortController();
  S.askAbort = ac;
  const stream = new SentenceStream();
  const done = answerer.begin();
  let answer = '', firstDelta = false, ready = false, readyResolve;
  const readyP = new Promise((r) => { readyResolve = r; });
  const backlog = [];
  const say = (s) => (ready ? answerer.push(s) : backlog.push(s));

  try {
    const { refusal, tools } = await ai.ask(ctx.payload, {
      signal: ac.signal,
      onText: (delta) => {
        if (seq !== S.askSeq) return;
        if (!firstDelta) {
          firstDelta = true;
          stopTicks();
          setMode('answering');
          feedback.cue('answer').then(() => {
            if (seq !== S.askSeq) return;
            ready = true;
            backlog.splice(0).forEach((s) => answerer.push(s));
            readyResolve();
          });
        }
        answer += delta;
        S.answerText = answer;
        renderCaption();
        for (const s of stream.push(delta)) say(s);
      },
    });
    if (seq !== S.askSeq) return;
    if (!firstDelta) { stopTicks(); setMode('answering'); ready = true; readyResolve(); }
    await readyP;
    if (seq !== S.askSeq) return;
    for (const s of stream.end()) say(s);
    const realAnswer = answer.trim();
    // The AI may have chosen player actions instead of (or as well as) answering.
    const plan = tools?.length ? planCommands(tools, { book: S.book, pos, rate: S.settings.rate || 1, retr: S.retr, answered: Boolean(realAnswer) }) : null;
    const acts = Boolean(plan && (plan.steps.length || plan.effect.listen));
    if (!realAnswer && !acts) {
      answer = t(refusal ? 'say.refusal' : 'say.empty'); S.answerText = answer; answerer.push(answer);
    }
    // Keep the complete answer in the Q&A log (and as conversation history) even if the listener skips the spoken part.
    if (realAnswer) saveQA({ q: text, a: realAnswer.slice(0, 1500), pos });
    answerer.finish();
    await done;
    if (seq !== S.askSeq) return;
    if (acts) { await runCommands(plan, { seq, text, pos, answered: Boolean(realAnswer) }); return; }
    finishAsk(seq);
  } catch (err) {
    if (seq !== S.askSeq || err?.name === 'AbortError') return;
    console.error('[ask] failed', err);
    if (firstDelta) answerer.cancel();
    toast(err.message || t('toast.aiError'), 'error', 8000);
    await failAsk(spokenError(err), seq);
  }
}

function saveQA(entry) {
  S.qa.push({ ...entry, t: Date.now() });
  S.qa = S.qa.slice(-40);
  lib.saveQA(S.book.id, S.qa).catch(() => {});
}

/**
 * Carry out the player actions the AI chose (see commands.js for what each one means): say what is being done, in the
 * language the listener used, then move / pause / change speed, and resume unless they asked to stop.
 */
async function runCommands(plan, { seq, text, pos, answered }) {
  const { steps, effect } = plan;
  const spoken = S.questionLang || '';
  if (steps.length) {
    const say = steps.map((s) => s.msg.text ?? tIn(spoken, s.msg.key, s.msg.params)).join(tIn(spoken, 'cmd.join'));
    const shown = steps.map((s) => (s.msg.text ?? t(s.msg.key, s.msg.params)) + (s.title ? ` · ${s.title}` : '')).join(' · ');
    S.answerText = shown;
    renderCaption();
    await answerer.say(say);
    if (seq !== S.askSeq) return;
    // Logged so that "again" / "a bit more" can follow up on it. Its position is the earlier of the two, so it stays visible
    // after a rewind (history only shows entries from at or before the current position).
    if (!answered) saveQA({ q: text, a: shown, pos: Math.min(pos, effect.pos ?? pos), cmd: true });
    else if (steps.some((s) => s.ok)) { // an answer plus an action: the log (and the AI's history) should say what was done too
      const last = S.qa.at(-1);
      if (last?.q === text) { last.a = `${last.a} (${shown})`.slice(0, 1600); lib.saveQA(S.book.id, S.qa).catch(() => {}); }
    }
  }
  if (effect.rate !== null) setRate(effect.rate);
  if (effect.pos !== null) {
    S.askPos = effect.pos;
    narrator.seek(effect.pos); // the book is paused while the listener talks, so this only moves the position
    saveProgressNow();
  }
  if (effect.sleep) applySleep(effect.sleep.mode === 'minutes' ? effect.sleep.minutes : effect.sleep.mode === 'chapter' ? -1 : 0, S.askPos);
  if (effect.play !== null) S.resumeAfter = effect.play;
  if (effect.listen && S.followUps < 3) { // the AI asked a question and wants the answer without another button press
    S.followUps++;
    const next = ++S.askSeq;
    S.micReady = false;
    setMode('listening');
    listenThenSubmit(next);
    return;
  }
  finishAsk(seq);
}

function spokenError(err) {
  const s = err?.status;
  if (s === 402) return t('say.ai.402');
  if (s === 401 || s === 403) return t('say.ai.401');
  if (s === 429) return t('say.ai.429');
  if (s === 503) return t('say.aiNotReady');
  if (err instanceof TypeError) return t('say.offline');
  return t('say.ai.default');
}

async function failAsk(message, seq, resume = true) {
  stopTicks();
  await feedback.cue('error');
  if (seq !== S.askSeq) return;
  setMode('answering');
  await answerer.say(message);
  if (seq !== S.askSeq) return;
  finishAsk(seq, resume);
}

async function finishAsk(seq, resume = true) {
  stopTicks();
  S.askAbort = null;
  closeTypedIfOpen();
  setMode('idle');
  S.interim = ''; S.answerText = '';
  renderCaption();
  if (S.sleep.due) { doSleep(); return; }
  if (S.resumeAfter && resume) {
    await sleep(450);
    if (seq !== S.askSeq || S.mode !== 'idle') return;
    narrator.play(S.askPos);
    session.engage();
    renderPlay();
  } else if (!narrator.playing) {
    session.release();
  }
}

/**
 * Back to "tap to ask", whatever the ask flow was doing: the AI stops mid-answer, a recording nothing was said into is dropped. Like
 * the end of an answer, the book carries on only if it was playing when the question was asked.
 */
function stopAsking() {
  const seq = ++S.askSeq;
  S.askAbort?.abort(); S.askAbort = null;
  listener.abort(); recorder.abort(); answerer.cancel(); stopTicks();
  feedback.cue('cancel');
  finishAsk(seq);
}

/** Tap while the AI is talking: stop it and listen for a follow-up question (tap again before saying anything: back to "tap to ask"). */
function interruptAnswer() {
  const seq = ++S.askSeq;
  S.askAbort?.abort(); S.askAbort = null;
  answerer.cancel(); stopTicks(); recorder.abort();
  S.micReady = false;
  setMode('listening');
  listenThenSubmit(seq);
}

function cancelAsk({ resume = true, silent = false } = {}) {
  const wasActive = S.mode !== 'idle';
  S.askSeq++;
  S.askAbort?.abort(); S.askAbort = null;
  listener.abort(); recorder.abort(); answerer.cancel(); stopTicks();
  closeTypedIfOpen();
  S.mode = 'idle';
  S.interim = ''; S.answerText = '';
  renderAsk(); renderPlay();
  if (!wasActive) return;
  if (!silent) feedback.cue('cancel');
  if (resume) {
    narrator.play(S.askPos);
    session.engage();
    renderPlay();
  } else if (!narrator.playing) {
    session.release();
  }
}

function startTicks(seq) {
  stopTicks();
  S.ticks = setInterval(() => { if (seq === S.askSeq && S.mode === 'thinking') feedback.cue('tick'); }, 2200);
}
function stopTicks() { clearInterval(S.ticks); S.ticks = null; }

function closeTypedIfOpen() { if (openSheetId === 'askSheet') closeSheets(); }

// ------------------------------------------------------------------ library & import
async function refreshLibrary() {
  const books = await lib.listBooks();
  const ul = $('bookList');
  ul.innerHTML = '';
  $('emptyLibrary').hidden = books.length > 0;
  $('formatHint').textContent = t('lib.formats', { list: t('lib.formatsList') });
  for (const b of books) {
    const li = document.createElement('li');
    li.className = `book-card${S.book?.id === b.id ? ' current' : ''}`;
    const pct = b.total > 1 ? Math.round((b.idx / (b.total - 1)) * 100) : 0;
    const info = document.createElement('button');
    info.className = 'info';
    info.innerHTML = '<span class="name"></span><span class="meta"></span><div class="mini"><i></i></div>';
    info.querySelector('.name').textContent = b.title || t('lib.untitled');
    info.querySelector('.meta').textContent = `${b.author ? b.author + ' · ' : ''}${t('lib.chaptersN', { n: b.chapters })} · ${pct}%`;
    info.querySelector('.mini i').style.width = `${pct}%`;
    info.addEventListener('click', () => { feedback.unlock(); openBook(b.id); });
    const del = document.createElement('button');
    del.className = 'del';
    del.setAttribute('aria-label', t('lib.delete.aria', { title: b.title }));
    del.textContent = '🗑';
    del.addEventListener('click', async () => {
      if (!confirm(t('lib.delete.confirm', { title: b.title }))) return;
      if (S.book?.id === b.id) { narrator.hardStop(); S.builder?.stop(); S.book = null; renderAll(); localStorage.removeItem(lib.LAST_BOOK_KEY); }
      await lib.deleteBook(b.id);
      refreshLibrary();
    });
    li.append(info, del);
    ul.appendChild(li);
  }
}

function showImport(msg, frac) {
  $('importOverlay').hidden = false;
  $('importMsg').textContent = msg;
  $('importBar').style.width = `${Math.round((frac ?? 0) * 100)}%`;
}
const hideImport = () => { $('importOverlay').hidden = true; };

async function storeParsed({ parsed, hash, kind }) {
  showImport(t('import.organizing'), 0.92);
  await new Promise((r) => setTimeout(r, 30));
  const data = buildBookData(parsed);
  await lib.saveBook(hash, data, kind);
  return { id: hash, title: data.title };
}

async function importFiles(files) {
  let last = null;
  for (const f of files) {
    try {
      showImport(t('import.reading', { name: f.name }), 0.02);
      const result = await parseBookFile(f, (p, msg) => showImport(msg || t('import.reading', { name: f.name }), p * 0.9));
      last = await storeParsed(result);
      if (result.parsed.warning) toast(`「${f.name}」：${result.parsed.warning}`, 'error', 14000);
    } catch (err) {
      console.error(err);
      toast(`「${f.name}」：${err.message || err}`, 'error', 9000);
    }
  }
  hideImport();
  if (last) {
    toast(t('import.added', { title: last.title }));
    await refreshLibrary();
    if (files.length === 1) openBook(last.id);
  }
}

// ------------------------------------------------------------------ sheets: text, chapters, settings
function updateTextSheet() {
  if ($('textBody').hidden) return; // the Q&A tab is showing
  const body = $('textBody'), i = narrator.idx;
  const cur = body.querySelector(`[data-i="${i}"]`);
  if (!cur) { renderTextSheet(); return; }
  body.querySelector('.now')?.classList.remove('now');
  cur.classList.add('now');
  for (const sp of body.querySelectorAll('span')) sp.classList.toggle('past', Number(sp.dataset.i) < i);
  cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function showTextTab(which) {
  const isText = which === 'text';
  $('textBody').hidden = !isText;
  $('qaBody').hidden = isText;
  $('tabText').classList.toggle('on', isText);
  $('tabQA').classList.toggle('on', !isText);
  $('tabText').setAttribute('aria-selected', String(isText));
  $('tabQA').setAttribute('aria-selected', String(!isText));
  if (isText) renderTextSheet(); else renderQA();
}

function renderQA() {
  const body = $('qaBody');
  body.innerHTML = '';
  if (!S.qa.length) {
    const empty = document.createElement('p');
    empty.className = 'qa-empty';
    empty.textContent = t('qa.empty');
    body.appendChild(empty);
    return;
  }
  for (const item of [...S.qa].reverse()) {
    const div = document.createElement('div');
    div.className = 'qa-item';
    const q = document.createElement('p'); q.className = 'q'; q.textContent = t('qa.q', { q: item.q });
    const a = document.createElement('p'); a.className = 'a'; a.textContent = item.a;
    const m = document.createElement('p'); m.className = 'meta';
    const ch = S.book.chapterOf(Math.min(item.pos, S.book.length - 1));
    m.textContent = t('qa.meta', { chapter: ch.title, pct: Math.round(S.book.fractionBefore(item.pos) * 100) });
    div.append(q, a, m);
    body.appendChild(div);
  }
}

function renderTextSheet() {
  const b = S.book;
  const body = $('textBody');
  body.innerHTML = '';
  if (!b) return;
  const i = narrator.idx, from = Math.max(0, i - 40), to = Math.min(b.length, i + 80);
  let p = document.createElement('p');
  for (let k = from; k < to; k++) {
    if (k > from && b.isParaStart[k]) { body.appendChild(p); p = document.createElement('p'); }
    const sp = document.createElement('span');
    sp.dataset.i = String(k);
    sp.textContent = b.sents[k] + (k + 1 < b.length ? gapBetween(b.sents[k], b.sents[k + 1]) : '');
    if (k === i) sp.className = 'now'; else if (k < i) sp.className = 'past';
    p.appendChild(sp);
  }
  body.appendChild(p);
  body.querySelector('.now')?.scrollIntoView({ block: 'center' });
}

/** Jump to a chapter from the picker and start listening there (picking a chapter is an explicit "play this"). */
function selectChapter(start) {
  unlockSpeech(); feedback.unlock();
  const wasPlaying = narrator.playing || (S.mode !== 'idle' && S.resumeAfter);
  if (S.mode !== 'idle') cancelAsk({ resume: false, silent: true });
  closeSheets();
  feedback.vibrate(20);
  narrator.seek(start);
  narrator.play(start);
  session.engage();
  if (!wasPlaying) toast(t('chapters.playFrom'), '', 1800);
  renderPlay();
}

function renderChapterSheet() {
  const b = S.book;
  const ol = $('chapterList');
  ol.innerHTML = '';
  if (!b) return;
  $('chapterSheetTitle').textContent = t('chapters.sheetTitle', { n: b.chapters.length });
  const cur = b.chapterIndexOf(narrator.idx);
  b.chapters.forEach((c, k) => {
    const li = document.createElement('li');
    if (k === cur) li.className = 'current';
    const btn = document.createElement('button');
    const name = document.createElement('span');
    name.textContent = c.title;
    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = `${Math.round(b.fractionBefore(c.start) * 100)}%`;
    btn.append(name, pct);
    if (k === cur) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', () => selectChapter(c.start));
    li.appendChild(btn);
    ol.appendChild(li);
  });
  ol.querySelector('.current')?.scrollIntoView({ block: 'center' });
}

function fillVoiceSelect(sel, lang, chosen) {
  sel.innerHTML = '';
  const auto = new Option(t('voice.auto'), '');
  sel.add(auto);
  for (const v of voicesFor(lang)) sel.add(new Option(`${v.name} (${v.lang}${v.localService ? '' : t('voice.online')})`, v.voiceURI));
  sel.value = chosen || '';
}

/** The server's voices for a language (it knows many more than a phone does); the list comes from the server and may take a moment. */
async function fillServerVoiceSelect(sel, lang, chosen) {
  const seq = (sel.dataset.seq = String(Number(sel.dataset.seq || 0) + 1));
  sel.innerHTML = '';
  sel.add(new Option(t('voice.auto'), ''));
  sel.value = '';
  try {
    const { voices } = await ai.ttsVoices(lang);
    if (sel.dataset.seq !== seq) return; // another language was asked for meanwhile
    for (const v of voices) {
      const gender = v.gender === 'female' ? t('voice.gender.female') : v.gender === 'male' ? t('voice.gender.male') : '';
      const bits = [v.lang, gender, v.multilingual && v.lang && t('voice.multilingual')].filter(Boolean);
      sel.add(new Option(`${v.name} (${bits.join(', ')})`, v.id));
    }
    sel.value = chosen || '';
    if (sel.value !== (chosen || '')) sel.value = '';
  } catch {
    if (sel.dataset.seq !== seq) return;
    const note = new Option(t('voice.listError'), '');
    note.disabled = true;
    sel.add(note);
  }
}

/** Which engine's voices the voice pickers in Settings are about: the server's when that is chosen and the server has them. */
const serverVoicesChosen = () => S.settings.engine === 'server' && Boolean(S.config.tts?.available);

/** The "voice engine" choice, its explanation, and the rows that depend on it (the phone's voices, or the server's). */
function renderVoiceRows() {
  const s = S.settings, tts = S.config.tts;
  const bookLang = S.book?.lang || normalizeTag(navigator.language) || 'zh-TW';
  const server = serverVoicesChosen();

  $('setEngine').value = s.engine === 'server' ? 'server' : 'device';
  $('setEngine').querySelector('option[value="server"]').disabled = !serverVoicesUsable();
  let info = '';
  if (s.engine === 'server') {
    if (!tts?.available) info = t('engine.info.unavailable', { reason: tts?.reason || '' });
    else if (S.config.offline) info = t('engine.info.offline');
    else if (engine.failed) info = t('engine.info.failed');
    else info = t('engine.info.server', { provider: tts.label }) + (tts.official ? '' : ` ${t('engine.info.unofficial')}`);
  } else {
    info = t('engine.info.device') + (tts?.available ? '' : ` ${t('engine.info.notSetUp')}`);
  }
  $('engineInfo').textContent = info;

  // the voice for the English words in the text (an English book's own voice is the one above); either engine splits mixed text by language
  const notEnglish = !/^en/i.test(bookLang);
  $('rowVoiceAlt').hidden = !notEnglish;
  if (server) {
    fillServerVoiceSelect($('setVoice'), bookLang, s.serverVoice[bookLang]);
    fillServerVoiceSelect($('setAnswerVoice'), askLang(), s.serverAnswerVoice[askLang()]);
    if (notEnglish) fillServerVoiceSelect($('setVoiceAlt'), 'en-US', s.serverVoice['en-US']);
  } else {
    fillVoiceSelect($('setVoice'), bookLang, s.voiceURI[bookLang]);
    fillVoiceSelect($('setAnswerVoice'), askLang(), s.answerVoiceURI[askLang()]);
    fillVoiceSelect($('setVoiceAlt'), 'en-US', s.voiceURI['en-US']);
  }
  // a phone without an English voice cannot read the English words of a Chinese or Japanese text in English: say so
  $('voiceHint').hidden = server || !notEnglish || !ttsSupported() || voicesFor('en-US').length > 0;
}

function renderMemInfo() {
  const el = $('memInfo');
  if (!S.builder) { el.textContent = ''; return; }
  const st = S.builder.status();
  const parts = [t('mem.summary', { done: st.done, total: st.total, running: st.running ? t('mem.running') : '' })];
  if (st.disabled === 'auth') parts.push(t('mem.auth'));
  if (st.disabled === 'config') parts.push(t('mem.config'));
  if (st.disabled === 'credit') parts.push(t('mem.credit'));
  if (st.failures) parts.push(t('mem.failures', { n: st.failures }));
  el.textContent = parts.join(' ');
}

const shakeText = (status) => ({
  ok: t('shake.ok'), waiting: t('shake.waiting'), none: t('shake.none'), denied: t('shake.denied'),
  unsupported: t('shake.unsupported'), 'needs-permission': t('shake.needsPermission'), insecure: t('shake.insecure'), 'load-failed': t('shake.loadFailed'),
})[status] || '';

/** The live meter under the shake setting: whether the phone sends motion data at all, and how hard the latest shake was against what it takes. */
function renderShakeMeter() {
  const box = $('shakeMeter');
  if (!box) return;
  const show = openSheetId === 'settingsSheet' && S.settings.shake && !['unsupported', 'denied', 'insecure', 'needs-permission', 'load-failed', ''].includes(S.shakeStatus);
  box.hidden = !show;
  if (!show) return;
  const st = shake.stats();
  $('shakeBar').style.width = `${Math.min(100, (st.peak / st.need) * (100 / 1.5))}%`;
  $('shakeBar').classList.toggle('hit', st.peak >= st.need);
  $('shakeMeterText').textContent = t('shake.meter', { hz: st.hz, peak: st.peak.toFixed(1), need: st.need.toFixed(1) });
}

function renderShakeInfo() {
  const row = $('shakeSensRow'), info = $('shakeInfo');
  if (!row || !info) return;
  row.hidden = !S.settings.shake;
  $('shakeSensHint').hidden = !S.settings.shake;
  info.hidden = !S.settings.shake;
  if (!S.settings.shake) return;
  const seen = Date.now() - S.shakeSeenAt < 2500;
  info.textContent = seen ? t('shake.detected') : shakeText(S.shakeStatus);
  info.style.color = seen ? 'var(--answer)' : '';
}

/**
 * Shake: start asking, like a tap on the big button — but while the AI is answering a shake means "stop": the answer ends and the
 * app is back at "tap to ask" (a tap then would instead stop it and listen for a follow-up). Not while listening or thinking: a
 * phone moves in the hand while its owner talks, and a stray shake must not end the question.
 * Inside the settings sheet it only gives feedback so the sensitivity can be tried out.
 */
function onShake() {
  if (!S.settings.shake || document.visibilityState !== 'visible') return;
  if (openSheetId === 'settingsSheet') {
    S.shakeSeenAt = Date.now(); feedback.vibrate([30, 40, 30]); renderShakeInfo();
    setTimeout(renderShakeInfo, 2600);
    return;
  }
  if (openSheetId || !S.book || $('player').hidden || !['idle', 'answering'].includes(S.mode)) return;
  feedback.vibrate([30, 40, 30]);
  feedback.unlock(); unlockSpeech();
  if (S.mode === 'answering') { announce(t('shake.interrupted')); stopAsking(); return; }
  announce(t('shake.announce'));
  beginAsk();
}

/** (Re)start or stop the motion listener according to the settings. `askPermission` only from a tap (iOS rule). */
async function applyShake(askPermission = false) {
  shake.stop();
  if (!S.settings.shake) { S.shakeStatus = ''; renderShakeInfo(); renderAsk(); return 'off'; }
  const result = await shake.start({ threshold: S.settings.shakeThreshold, askPermission });
  renderAsk();
  return result;
}

function renderSttInfo() {
  const el = $('sttInfo');
  if (!el) return;
  const st = S.config.stt;
  const plan = sttPlan();
  const now = { cloud: t('sttInfo.now.cloud'), device: t('sttInfo.now.device'), typed: t('sttInfo.now.typed') }[plan];
  el.textContent = st?.available
    ? t('sttInfo.connected', { who: st.provider === 'mock' ? t('sttInfo.mock') : `${st.provider} · ${st.model}`, now })
    : t('sttInfo.notSet', { now });
}

function openSettings() {
  const s = S.settings;
  $('setUiLang').value = isLang(s.uiLang) ? s.uiLang : LANG_AUTO;
  $('setRate').value = s.rate; $('rateVal').textContent = `${s.rate.toFixed(2).replace(/0$/, '')}×`;
  renderVoiceRows();
  $('setMixed').value = mixedMode(s);
  $('setAskLang').value = s.askLang;
  $('setShake').checked = s.shake; renderShakeInfo();
  $('setShakeSens').value = sliderFromThreshold(s.shakeThreshold); $('shakeSensVal').textContent = formatThreshold(s.shakeThreshold);
  $('setSttMode').value = s.sttMode; $('setCloudLang').value = s.cloudLang; $('setSttHint').checked = s.sttHint;
  renderSttInfo();
  $('setWake').checked = s.wakeLock; $('setEarcons').checked = s.earcons; $('setHaptics').checked = s.haptics; $('setTitle').checked = s.sendTitle;
  $('setToken').value = s.accessToken || '';
  $('aiInfo').textContent = S.config.ai
    ? t('aiInfo.connected', { detail: S.config.mock ? t('aiInfo.mock') : t('aiInfo.models', { qa: S.config.models?.qa, summary: S.config.models?.summary }) })
    : t('aiInfo.notSet');
  renderMemInfo();
  openSheet('settingsSheet');
}

const previewLang = (lang) => (/^zh/.test(lang) ? 'zh' : /^ja/.test(lang) ? 'ja' : 'en');

/**
 * Switch the interface language: static text, dynamic text, and whatever screen or sheet is open. The setting is a language
 * the listener chose by hand (kept as chosen) or 'auto', which follows the phone's language list.
 */
function changeUiLang() {
  setLang(resolveLang(S.settings.uiLang));
  applyI18n();
  renderAll();
  updateMediaMetadata();
  if (!$('library').hidden) refreshLibrary();
  if (openSheetId === 'settingsSheet') openSettings();
  else if (openSheetId === 'chapterSheet') renderChapterSheet();
  else if (openSheetId === 'textSheet') showTextTab($('tabQA').classList.contains('on') ? 'qa' : 'text');
}

/** A sample in the server's voice (the voice id is what the picker holds when the server voices are chosen). */
async function previewServer(text, lang, voice, extra = {}) {
  audioOut.unlock();
  try {
    const url = URL.createObjectURL(await ai.ttsClip({ text, lang, voice, ...extra }));
    try { await audioOut.play(url, { rate: S.settings.rate || 1 }); } finally { URL.revokeObjectURL(url); }
  } catch (err) { toast(t('toast.ttsError', { detail: err.message }), 'error', 6000); }
}

function speakPreview(text, lang, uri, pitch = 1) {
  if (serverVoicesChosen()) { previewServer(text, lang, uri); return; }
  if (!ttsSupported()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(lang, uri);
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = lang;
  u.rate = S.settings.rate || 1; u.pitch = pitch;
  setTimeout(() => speechSynthesis.speak(u), 60);
}

function bindSettings() {
  const s = S.settings;
  const save = () => lib.saveSettings(s);
  $('setRate').addEventListener('input', (e) => { $('rateVal').textContent = `${Number(e.target.value).toFixed(2).replace(/0$/, '')}×`; });
  $('setRate').addEventListener('change', (e) => setRate(Number(e.target.value)));
  $('setEngine').addEventListener('change', (e) => {
    s.engine = e.target.value === 'server' ? 'server' : 'device'; save();
    engine.retry(); // choosing the engine again is how a failed server is tried again
    narrator.refresh();
    renderVoiceRows(); renderBanner();
  });
  $('setVoice').addEventListener('change', (e) => {
    const lang = S.book?.lang || normalizeTag(navigator.language) || 'zh-TW';
    (serverVoicesChosen() ? s.serverVoice : s.voiceURI)[lang] = e.target.value; save();
    if (narrator.playing) narrator.play(narrator.idx);
  });
  $('setAnswerVoice').addEventListener('change', (e) => { (serverVoicesChosen() ? s.serverAnswerVoice : s.answerVoiceURI)[askLang()] = e.target.value; save(); });
  $('setVoiceAlt').addEventListener('change', (e) => { (serverVoicesChosen() ? s.serverVoice : s.voiceURI)['en-US'] = e.target.value; save(); if (narrator.playing) narrator.play(narrator.idx); });
  $('setMixed').addEventListener('change', (e) => { s.mixedVoice = e.target.value; save(); if (narrator.playing) narrator.play(narrator.idx); });
  $('setAskLang').addEventListener('change', (e) => { s.askLang = e.target.value; save(); openSettings(); });
  $('setUiLang').addEventListener('change', (e) => { s.uiLang = e.target.value; save(); changeUiLang(); });
  $('setShake').addEventListener('change', async (e) => {
    s.shake = e.target.checked; save();
    const result = await applyShake(true); // this handler runs from a tap, so iOS may show its permission prompt
    if (s.shake && result === 'denied') { s.shake = false; e.target.checked = false; save(); await applyShake(); toast(t('shake.deniedToast'), 'error', 7000); }
    renderShakeInfo();
  });
  // dragging the slider takes effect at once, so the live meter under it shows what the new number asks for; it is kept when let go
  $('setShakeSens').addEventListener('input', (e) => { const v = thresholdFromSlider(e.target.value); $('shakeSensVal').textContent = formatThreshold(v); shake.setThreshold(v); });
  $('setShakeSens').addEventListener('change', (e) => { s.shakeThreshold = thresholdFromSlider(e.target.value); save(); shake.setThreshold(s.shakeThreshold); });
  $('setSttMode').addEventListener('change', (e) => { s.sttMode = e.target.value; save(); renderSttInfo(); renderAsk(); });
  $('setCloudLang').addEventListener('change', (e) => { s.cloudLang = e.target.value; save(); });
  $('setSttHint').addEventListener('change', (e) => { s.sttHint = e.target.checked; save(); });
  for (const [id, key] of [['setWake', 'wakeLock'], ['setEarcons', 'earcons'], ['setHaptics', 'haptics'], ['setTitle', 'sendTitle']]) {
    $(id).addEventListener('change', (e) => { s[key] = e.target.checked; save(); if (key === 'wakeLock') { if (!e.target.checked) session.releaseLock(); else if (narrator.playing) session.acquireLock(); } });
  }
  $('setToken').addEventListener('change', (e) => { s.accessToken = e.target.value.trim(); ai.setAccessToken(s.accessToken); save(); renderBanner(); S.builder?.resume(); });
  $('btnTestVoice').addEventListener('click', () => {
    const lang = S.book?.lang || 'zh-TW';
    speakPreview(t(`preview.narration.${previewLang(lang)}`), lang, $('setVoice').value);
  });
  $('btnTestAnswer').addEventListener('click', () => {
    const lang = askLang();
    speakPreview(t(`preview.answer.${previewLang(lang)}`), lang, $('setAnswerVoice').value, s.answerPitch);
  });
  $('btnTestMixed').addEventListener('click', () => {
    const lang = S.book?.lang || normalizeTag(navigator.language) || 'zh-TW';
    const sample = t(`preview.mixed.${previewLang(lang)}`);
    if (serverVoicesChosen()) previewServer(sample, lang, '', { voices: s.serverVoice, mixed: mixedMode(s) });
    else speakMixed(sample, { lang, settings: s });
  });
  $('btnChapters').addEventListener('click', () => { openSheet('chapterSheet'); renderChapterSheet(); });
  $('btnClearMemory').addEventListener('click', async () => {
    if (!S.book || !confirm(t('confirm.clearMemory'))) return;
    S.builder.stop();
    await lib.clearMemory(S.book.id);
    S.tree = new MemoryTree(S.book); S.qa = []; S.ceiling = 0;
    S.builder = new MemoryBuilder({ book: S.book, tree: S.tree, summarize: ai.summarize, concurrency: 2, onChange: saveMemorySoon, onStatus: () => { if (openSheetId === 'settingsSheet') renderMemInfo(); } });
    renderMemInfo(); toast(t('toast.cleared'));
  });
  $('btnRestart').addEventListener('click', () => {
    if (!S.book || !confirm(t('confirm.restart'))) return;
    closeSheets(); narrator.seek(0); saveProgressNow();
  });
}

// ------------------------------------------------------------------ boot
function bindUI() {
  $('askBtn').addEventListener('click', onAskPress);
  $('btnPlay').addEventListener('click', togglePlay);
  bindTapHold($('btnBack'), () => jump(-1), () => jumpChapter(-1));
  bindTapHold($('btnFwd'), () => jump(1), () => jumpChapter(1));
  $('chipSpeed').addEventListener('click', cycleSpeed);
  $('chipSleep').addEventListener('click', cycleSleep);
  $('chipText').addEventListener('click', () => { if (!S.book) return; openSheet('textSheet'); showTextTab('text'); });
  $('tabText').addEventListener('click', () => showTextTab('text'));
  $('tabQA').addEventListener('click', () => showTextTab('qa'));
  $('chipType').addEventListener('click', () => {
    feedback.unlock(); unlockSpeech();
    if (!S.book) { openLibrary(); return; }
    if (S.mode === 'idle') beginAsk({ typed: true });
    else { const seq = ++S.askSeq; listener.abort(); recorder.abort(); answerer.cancel(); S.askAbort?.abort(); stopTicks(); setMode('listening'); openTypedAsk(seq); }
  });
  $('textBody').addEventListener('click', (e) => {
    const sp = e.target.closest('[data-i]');
    if (!sp) return;
    if (S.mode !== 'idle') cancelAsk({ resume: false, silent: true });
    narrator.seek(Number(sp.dataset.i));
    if (narrator.playing) session.engage();
  });
  $('btnChapterPicker').addEventListener('click', () => {
    if (!S.book) { openLibrary(); return; }
    openSheet('chapterSheet');
    renderChapterSheet();
  });
  $('btnLibrary').addEventListener('click', openLibrary);
  $('btnCloseLibrary').addEventListener('click', () => { if (S.book) showScreen('player'); });
  $('btnSettings').addEventListener('click', openSettings);
  $('btnSettings2').addEventListener('click', openSettings);
  $('sheetBackdrop').addEventListener('click', dismissSheet);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', dismissSheet));

  $('askForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('askText').value.trim();
    const seq = Number($('askForm').dataset.seq);
    if (!text || seq !== S.askSeq) return;
    closeSheets();
    submitQuestion(text, seq);
  });
  $('askText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('askForm').requestSubmit(); }
    else if (e.key === 'Escape') dismissSheet();
  });

  // seek slider
  const seek = $('seek');
  seek.addEventListener('input', () => { S.scrubbing = true; const v = Number(seek.value); seek.style.setProperty('--fill', `${v / 10}%`); $('pctText').textContent = `${Math.round(v / 10)}%`; });
  seek.addEventListener('change', () => {
    S.scrubbing = false;
    if (!S.book) return;
    if (S.mode !== 'idle') cancelAsk({ resume: false, silent: true });
    narrator.seek(S.book.unitAtFraction(Number(seek.value) / 1000));
    if (narrator.playing) session.engage();
  });

  // library
  $('fileInput').setAttribute('accept', ACCEPT);
  $('fileInput').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) importFiles(files); });
  $('btnPaste').addEventListener('click', () => { $('pasteTitle').value = ''; $('pasteText').value = ''; openSheet('pasteSheet'); });
  $('pasteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('pasteText').value;
    if (!text.trim()) return;
    closeSheets();
    try {
      showImport(t('import.organizing'), 0.5);
      const stored = await storeParsed(await parsePastedText(text, $('pasteTitle').value.trim()));
      hideImport(); await refreshLibrary(); openBook(stored.id);
    } catch (err) { hideImport(); toast(err.message, 'error'); }
  });
  const dz = $('dropZone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); }));
  dz.addEventListener('drop', (e) => { e.preventDefault(); const files = [...(e.dataTransfer?.files || [])]; if (files.length) importFiles(files); });

  // keyboard shortcuts (desktop testing / Bluetooth keyboards)
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if ($('player').hidden) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'a' || e.key === 'A' || e.key === 'Enter') { e.preventDefault(); onAskPress(); }
    else if (e.key === 'ArrowLeft') jump(-1);
    else if (e.key === 'ArrowRight') jump(1);
    else if (e.key === 'Escape') { if (openSheetId) dismissSheet(); else if (S.mode !== 'idle') cancelAsk({ resume: true }); }
  });

  // save state whenever the page goes away
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { saveProgressNow(); saveMemoryNow(); } });
  window.addEventListener('pagehide', () => { saveProgressNow(); saveMemoryNow(); });
  setInterval(() => { if (S.sleep.mode > 0) renderChips(); }, 20000);
  setInterval(renderShakeMeter, 200);

  bindSettings();
}

async function init() {
  setLang(resolveLang(S.settings.uiLang));
  applyI18n();
  bindUI();
  // the phone's language was changed while the app is open: follow it, unless a language was chosen by hand
  window.addEventListener('languagechange', () => { if (!isLang(S.settings.uiLang)) changeUiLang(); });
  ai.setAccessToken(S.settings.accessToken);
  loadVoices().then(() => { if (openSheetId === 'settingsSheet') openSettings(); });
  S.config = await ai.getConfig();
  renderBanner();
  if (S.settings.shake) {
    // No tap yet, so iOS can't be asked for permission now; if that turns out to be needed, ask on the first tap.
    applyShake(false).then(() => setTimeout(() => {
      if (S.shakeStatus === 'needs-permission') document.addEventListener('pointerdown', () => applyShake(true), { once: true });
    }, 2500));
  }

  let last = null;
  try { last = localStorage.getItem(lib.LAST_BOOK_KEY); } catch { /* ignore */ }
  if (last) await openBook(last).catch(() => {});
  if (!S.book) showScreen('library');
  renderAll();
  if (S.book) updateBuilder();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// Exposed for debugging and automated tests.
window.__audiobook = { S, narrator, answerer, listener, recorder, feedback, openBook, importFiles, submitQuestion, beginAsk, cancelAsk, storeParsed, jump, togglePlay, buildAskContext };

init();
