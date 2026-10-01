// "Server voices": text in, audio out, made on the server instead of by the phone's own speech engine.
//
// The browser asks POST /api/tts for one clip per speech unit (or per sentence of an AI answer) and plays it through an <audio>
// element — that is what lets it keep going when the screen locks, and the voices are far better than most phones' built-in ones.
// Which service makes the audio is a server setting, TTS_PROVIDER (see .env.example):
//   edge     Microsoft Edge's read-aloud voices. Free, no key, 75 languages, voices that read several languages in one sentence.
//            NOT an official API: it can change or stop working at any time, and its terms are not meant for commercial use.
//   azure    Azure AI Speech (the same voices, official; has a free monthly allowance).      AZURE_SPEECH_KEY + AZURE_SPEECH_REGION
//   google   Google Cloud Text-to-Speech (official; has a free monthly allowance).           GOOGLE_TTS_API_KEY
//   openai   OpenAI's /audio/speech.                                                          OPENAI_API_KEY
//   custom   Any server with an OpenAI-compatible /audio/speech (Kokoro-FastAPI, openedai-speech, …) — the model is yours to choose.
//                                                                                              TTS_BASE_URL (+ TTS_API_KEY, TTS_MODEL, TTS_VOICES)
// Clips are cached in memory, so listening to the same passage again costs nothing. The text that is spoken is sent to the
// provider; nothing else is.
import crypto from 'node:crypto';
import { planSpeech, cleanForSpeech, MIXED_MODES } from './public/js/speech-plan.js';

export class TtsError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export const TTS_PROVIDERS = ['edge', 'azure', 'google', 'openai', 'custom'];
export const MAX_TEXT = 1200;               // characters per clip (a speech unit is at most ~220; the service takes ~4 KB per message)
const VOICE_ID = /^[\w.:() -]{1,120}$/u;    // goes into SSML / JSON: keep it plain
const LANG_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const primary = (tag) => String(tag || '').toLowerCase().split(/[-_]/)[0];

const LABELS = {
  edge: 'Microsoft Edge read-aloud',
  azure: 'Azure AI Speech', google: 'Google Cloud Text-to-Speech', openai: 'OpenAI', custom: 'OpenAI-compatible server', mock: 'mock voices',
};

// ---------------------------------------------------------------- configuration
/**
 * What the environment says about server voices. `available` is whether the browser may offer the option; `reason` says why not.
 * (Secrets stay in the returned object — use publicInfo() for what goes to the browser.)
 */
export function ttsConfig(env = process.env, { mock = false, hasWebSocket = typeof globalThis.WebSocket === 'function' } = {}) {
  const asked = String(env.TTS_PROVIDER || '').trim().toLowerCase();
  if (['off', 'none', 'false', '0', 'disabled'].includes(asked)) return { available: false, provider: '', reason: 'off' };
  if (mock) return { available: true, provider: 'mock', label: LABELS.mock, official: true };
  const provider = asked || 'edge';
  if (!TTS_PROVIDERS.includes(provider)) return { available: false, provider, reason: `TTS_PROVIDER="${asked}" is not one of: ${TTS_PROVIDERS.join(', ')}, off` };
  const base = { provider, label: LABELS[provider], official: provider !== 'edge' };
  const missing = (...names) => ({ ...base, available: false, reason: `set ${names.join(' and ')} in .env` });
  switch (provider) {
    case 'edge':
      return hasWebSocket ? { ...base, available: true } : { ...base, available: false, reason: 'Edge voices need Node.js 22 or newer (no built-in WebSocket)' };
    case 'azure':
      if (!env.AZURE_SPEECH_KEY || !env.AZURE_SPEECH_REGION) return missing('AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION');
      return { ...base, available: true, key: env.AZURE_SPEECH_KEY, region: String(env.AZURE_SPEECH_REGION).trim().toLowerCase() };
    case 'google':
      if (!env.GOOGLE_TTS_API_KEY) return missing('GOOGLE_TTS_API_KEY');
      return { ...base, available: true, key: env.GOOGLE_TTS_API_KEY };
    case 'openai': {
      const key = env.TTS_API_KEY || env.OPENAI_API_KEY;
      if (!key) return missing('OPENAI_API_KEY');
      return openaiLike(base, { base: env.TTS_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com/v1', key, model: env.TTS_MODEL || 'gpt-4o-mini-tts', voices: OPENAI_VOICES, def: env.TTS_VOICE || 'alloy', env });
    }
    default: { // custom
      if (!env.TTS_BASE_URL) return missing('TTS_BASE_URL');
      return openaiLike(base, { base: env.TTS_BASE_URL, key: env.TTS_API_KEY || '', model: env.TTS_MODEL || 'tts-1', voices: [], def: env.TTS_VOICE || 'alloy', env });
    }
  }
}

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

function openaiLike(base, { base: url, key, model, voices, def, env }) {
  const listed = String(env.TTS_VOICES || '').split(',').map((v) => v.trim()).filter(Boolean);
  const names = listed.length ? listed : voices.length ? voices : [def];
  return { ...base, available: true, base: String(url).replace(/\/+$/, ''), key, model, defaultVoice: names.includes(def) ? def : names[0], voiceNames: names };
}

/** The part of the configuration the browser may see. */
export const publicInfo = (cfg) => ({ available: Boolean(cfg.available), provider: cfg.provider || '', label: cfg.label || '', official: Boolean(cfg.official), reason: cfg.reason || '' });

// ---------------------------------------------------------------- voices
/**
 * Voices are described the same way whatever the provider: { id, name, lang, gender, multilingual, quality }.
 * `quality` ranks the kinds of voice a provider has (0 = basic … 3 = best).
 */
const nameFromId = (id) => id.replace(/^[a-z]{2,3}-[A-Za-z]{2,4}(?:-[A-Za-z]+)?-/, '').replace(/Neural$/, '');

function normalizeAzureLike(list) {
  return list.filter((v) => v.ShortName && v.Locale && (v.Status || 'GA') === 'GA').map((v) => ({
    id: v.ShortName, name: nameFromId(v.ShortName), lang: v.Locale, gender: String(v.Gender || '').toLowerCase(),
    multilingual: /Multilingual/i.test(v.ShortName) || (v.SecondaryLocaleList || []).length > 1, quality: /Neural/.test(v.ShortName) ? 3 : 1,
  }));
}

const GOOGLE_LANG = { cmn: 'zh', yue: 'zh' };
const toGoogleLang = (lang) => { const [p, ...rest] = String(lang).split('-'); return [p.toLowerCase() === 'zh' ? 'cmn' : p, ...rest].join('-'); };
const fromGoogleLang = (code) => { const [p, ...rest] = String(code).split('-'); return [GOOGLE_LANG[p] || p, ...rest].join('-'); };

function normalizeGoogle(list) {
  return list.map((v) => {
    const q = /Chirp3-HD|Chirp-HD|Studio|Neural2/.test(v.name) ? 3 : /Wavenet|News|Casual/.test(v.name) ? 2 : /Polyglot/.test(v.name) ? 3 : 0;
    return { id: v.name, name: v.name.replace(/^[a-z]{2,3}-[A-Za-z]{2,4}-/, ''), lang: fromGoogleLang(v.languageCodes?.[0] || ''), gender: String(v.ssmlGender || '').toLowerCase(), multilingual: /Polyglot/.test(v.name), quality: q };
  });
}

/** The voice used when the listener has not picked one: a good, well-known voice for the language, preferably one that also reads other languages. */
const KNOWN_GOOD = new Set([
  'zh-TW-HsiaoChenNeural', 'zh-CN-XiaoxiaoNeural', 'zh-HK-HiuMaanNeural', 'en-US-AvaMultilingualNeural', 'en-GB-SoniaNeural', 'ja-JP-NanamiNeural',
  'ko-KR-SunHiNeural', 'fr-FR-VivienneMultilingualNeural', 'de-DE-SeraphinaMultilingualNeural', 'es-ES-ElviraNeural', 'it-IT-ElsaNeural',
  'pt-BR-FranciscaNeural', 'ru-RU-SvetlanaNeural', 'ar-SA-ZariyahNeural', 'hi-IN-SwaraNeural', 'th-TH-PremwadeeNeural', 'vi-VN-HoaiMyNeural',
  'id-ID-GadisNeural', 'tr-TR-EmelNeural', 'pl-PL-ZofiaNeural', 'nl-NL-ColetteNeural', 'sv-SE-SofieNeural', 'he-IL-HilaNeural', 'uk-UA-PolinaNeural',
  'el-GR-AthinaNeural',
]);

function rank(v, lang) {
  const same = v.lang.toLowerCase() === String(lang).toLowerCase();
  return (same ? 100 : 0) + (KNOWN_GOOD.has(v.id) ? 30 : 0) + (v.multilingual ? 20 : 0) + v.quality * 5 + (v.gender === 'female' ? 1 : 0);
}

/** The voices to offer for a language, best first: that language's own, then voices that read any language. */
export function voicesFor(all, lang) {
  const p = primary(lang);
  const own = all.filter((v) => primary(v.lang) === p);
  const poly = all.filter((v) => v.multilingual && primary(v.lang) !== p);
  const byRank = (a, b) => rank(b, lang) - rank(a, lang) || a.id.localeCompare(b.id);
  return [...own.sort(byRank), ...poly.sort(byRank)];
}

export const pickDefaultVoice = (all, lang) => voicesFor(all, lang)[0] || null;

// ---------------------------------------------------------------- SSML
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Control characters other than tab / newline make the services reject the message. */
const cleanText = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');

function ssml(text, voice, lang, { prosody = false } = {}) {
  const body = xmlEscape(cleanText(text));
  const inner = prosody ? `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${body}</prosody>` : body;
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang || 'en-US'}'><voice name='${voice}'>${inner}</voice></speak>`;
}

// ---------------------------------------------------------------- upstream errors
function upstreamError(what, status, detail = '') {
  const d = String(detail).slice(0, 200);
  if (status === 401 || status === 403) return new TtsError(`The ${what} key was rejected (check the key in .env).`, 502); // never 401: the browser would think its ACCESS_TOKEN is wrong
  if (status === 402 || /insufficient_quota|billing|quota/i.test(d)) return new TtsError(`The ${what} account has no credit or quota left. ${d}`.trim(), 402);
  if (status === 429) return new TtsError(`${what} is rate limiting this server; try again shortly.`, 429);
  if (status === 400 || status === 422) return new TtsError(`${what} refused the request: ${d || status}`, 400);
  return new TtsError(`${what} failed (${status})${d ? ': ' + d : ''}`, 502);
}

const readDetail = async (res) => { try { const t = await res.text(); try { const j = JSON.parse(t); return j?.error?.message || j?.message || t; } catch { return t; } } catch { return ''; } };

// ---------------------------------------------------------------- Microsoft Edge read-aloud
const EDGE = {
  token: '6A5AA1D4EAFF4E9FB37E23D68491D6F4',
  version: '143.0.3650.75',
  base: 'speech.platform.bing.com/consumer/speech/synthesize/readaloud',
};
const EDGE_MAJOR = EDGE.version.split('.')[0];
const EDGE_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_MAJOR}.0.0.0 Safari/537.36 Edg/${EDGE_MAJOR}.0.0.0`;
const WIN_EPOCH = 11644473600;

/** The token the service wants with every request: SHA-256 of "Windows file time rounded down to 5 minutes" + the client token. */
export function secMsGec(nowMs, skewSeconds = 0) {
  const secs = Math.floor(nowMs / 1000 + skewSeconds) + WIN_EPOCH;
  const ticks = BigInt(secs - (secs % 300)) * 10_000_000n;
  return crypto.createHash('sha256').update(`${ticks}${EDGE.token}`, 'ascii').digest('hex').toUpperCase();
}

const jsDate = (d = new Date()) => { // "Thu Oct 01 2026 12:00:00 GMT+0000 (Coordinated Universal Time)", as a browser writes it
  const [wd, day, mon, year, time] = d.toUTCString().replace(',', '').split(' ');
  return `${wd} ${mon} ${day} ${year} ${time} GMT+0000 (Coordinated Universal Time)`;
};

/** Splits one binary frame: 2-byte header length, the headers, then the payload. */
export function parseEdgeFrame(buf) {
  if (buf.length < 2) return null;
  const headerLen = buf.readUInt16BE(0);
  if (headerLen + 2 > buf.length) return null;
  const headers = {};
  for (const line of buf.subarray(2, 2 + headerLen).toString('utf8').split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1);
  }
  return { headers, body: buf.subarray(2 + headerLen) };
}

function edgeProvider({ WebSocketImpl, fetchImpl, now }) {
  let skew = 0; // seconds the computer's clock is off from the service's (the token is time-based)
  const gec = () => `Sec-MS-GEC=${secMsGec(now(), skew)}&Sec-MS-GEC-Version=1-${EDGE.version}`;

  /** If this computer's clock is wrong the service answers 403 with its own time in the Date header; adopt it. */
  async function syncClock() {
    try {
      const res = await fetchImpl(`https://${EDGE.base}/voices/list?trustedclienttoken=${EDGE.token}&${gec()}`, { method: 'GET', headers: { 'User-Agent': EDGE_UA }, signal: AbortSignal.timeout(8000) });
      const date = Date.parse(res.headers.get('date') || '');
      if (res.status === 403 && Number.isFinite(date)) { skew += (date - now()) / 1000; return true; }
    } catch { /* offline: nothing to learn */ }
    return false;
  }

  function once(text, voice, lang) {
    return new Promise((resolve, reject) => {
      const url = `wss://${EDGE.base}/edge/v1?TrustedClientToken=${EDGE.token}&ConnectionId=${crypto.randomUUID().replaceAll('-', '')}&${gec()}`;
      let ws;
      try {
        ws = new WebSocketImpl(url, { headers: {
          Pragma: 'no-cache', 'Cache-Control': 'no-cache', Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', 'User-Agent': EDGE_UA,
          'Accept-Language': 'en-US,en;q=0.9', Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
        } });
      } catch (err) { reject(new TtsError(`could not start the Edge voice connection: ${err.message}`)); return; }
      ws.binaryType = 'arraybuffer';
      const chunks = [];
      let opened = false, done = false;
      const end = (err, audio) => {
        if (done) return;
        done = true; clearTimeout(timer);
        try { ws.close(); } catch { /* already closed */ }
        if (err) { err.beforeOpen = !opened; reject(err); } else resolve(audio);
      };
      const timer = setTimeout(() => end(new TtsError('The Edge voice service did not answer in time.', 504)), 20_000);
      ws.addEventListener('open', () => {
        opened = true;
        ws.send(`X-Timestamp:${jsDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
        ws.send(`X-RequestId:${crypto.randomUUID().replaceAll('-', '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${jsDate()}Z\r\nPath:ssml\r\n\r\n${ssml(text, voice, lang, { prosody: true })}`);
      });
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') {
          const path = /Path:(\S+)/.exec(ev.data)?.[1];
          if (path === 'turn.end') end(chunks.length ? null : new TtsError('The Edge voice service returned no audio for this text.'), Buffer.concat(chunks));
          return;
        }
        const frame = parseEdgeFrame(Buffer.from(ev.data));
        if (frame && frame.headers.Path === 'audio' && frame.headers['Content-Type'] === 'audio/mpeg' && frame.body.length) chunks.push(frame.body);
      });
      ws.addEventListener('error', () => end(new TtsError(opened ? 'The Edge voice connection was interrupted.' : 'Could not connect to the Edge voice service.')));
      ws.addEventListener('close', () => end(new TtsError('The Edge voice connection closed before the audio was complete.')));
    });
  }

  return {
    async fetchVoices() {
      const get = () => fetchImpl(`https://${EDGE.base}/voices/list?trustedclienttoken=${EDGE.token}&${gec()}`, { headers: { 'User-Agent': EDGE_UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: '*/*' }, signal: AbortSignal.timeout(15_000) });
      let res = await get();
      if (res.status === 403 && await syncClock()) res = await get();
      if (!res.ok) throw upstreamError('Edge voice service', res.status, await readDetail(res));
      return normalizeAzureLike(await res.json());
    },
    async synthesize({ text, voice, lang }) {
      try { return { audio: await once(text, voice, lang), type: 'audio/mpeg' }; }
      catch (err) {
        if (!err.beforeOpen || !(await syncClock())) throw err; // the clock was off: try once more with the service's time
        return { audio: await once(text, voice, lang), type: 'audio/mpeg' };
      }
    },
  };
}

// ---------------------------------------------------------------- Azure AI Speech
function azureProvider({ cfg, fetchImpl }) {
  const host = `https://${cfg.region}.tts.speech.microsoft.com/cognitiveservices`;
  return {
    async fetchVoices() {
      const res = await fetchImpl(`${host}/voices/list`, { headers: { 'Ocp-Apim-Subscription-Key': cfg.key }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw upstreamError('Azure Speech', res.status, await readDetail(res));
      return normalizeAzureLike(await res.json());
    },
    async synthesize({ text, voice, lang }) {
      const res = await fetchImpl(`${host}/v1`, {
        method: 'POST', signal: AbortSignal.timeout(30_000), body: ssml(text, voice, lang),
        headers: { 'Ocp-Apim-Subscription-Key': cfg.key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'audiobook-companion' },
      });
      if (!res.ok) throw upstreamError('Azure Speech', res.status, await readDetail(res));
      return { audio: Buffer.from(await res.arrayBuffer()), type: 'audio/mpeg' };
    },
  };
}

// ---------------------------------------------------------------- Google Cloud Text-to-Speech
function googleProvider({ cfg, fetchImpl }) {
  const headers = { 'X-Goog-Api-Key': cfg.key, 'Content-Type': 'application/json' };
  return {
    async fetchVoices() {
      const res = await fetchImpl('https://texttospeech.googleapis.com/v1/voices', { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw upstreamError('Google Text-to-Speech', res.status, await readDetail(res));
      return normalizeGoogle((await res.json()).voices || []);
    },
    async synthesize({ text, voice, lang }) {
      const res = await fetchImpl('https://texttospeech.googleapis.com/v1/text:synthesize', {
        method: 'POST', headers, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ input: { text: cleanText(text) }, voice: { languageCode: toGoogleLang(voice.match(/^[a-z]{2,3}-[A-Za-z]{2,4}/)?.[0] || lang), name: voice }, audioConfig: { audioEncoding: 'MP3' } }),
      });
      if (!res.ok) throw upstreamError('Google Text-to-Speech', res.status, await readDetail(res));
      const audio = Buffer.from(String((await res.json()).audioContent || ''), 'base64');
      if (!audio.length) throw new TtsError('Google Text-to-Speech returned no audio.');
      return { audio, type: 'audio/mpeg' };
    },
  };
}

// ---------------------------------------------------------------- OpenAI and OpenAI-compatible servers
function openaiProvider({ cfg, fetchImpl }) {
  const what = cfg.provider === 'openai' ? 'OpenAI speech' : 'The speech server';
  return {
    async fetchVoices() { return cfg.voiceNames.map((id) => ({ id, name: id, lang: '', gender: '', multilingual: true, quality: 3 })); },
    async synthesize({ text, voice }) {
      const res = await fetchImpl(`${cfg.base}/audio/speech`, {
        method: 'POST', signal: AbortSignal.timeout(45_000),
        headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
        body: JSON.stringify({ model: cfg.model, input: cleanText(text), voice, response_format: 'mp3' }),
      });
      if (!res.ok) throw upstreamError(what, res.status, await readDetail(res));
      return { audio: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type')?.split(';')[0] || 'audio/mpeg' };
    },
  };
}

// ---------------------------------------------------------------- mock (for tests and for trying the app without a service)
/** A short tone per character, so a clip's length follows its text. */
export function mockWav(text, voice = '') {
  const rate = 16000;
  const secs = Math.min(10, Math.max(0.3, [...String(text)].length * 0.06));
  const n = Math.floor(rate * secs);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  const freq = /B$/.test(voice) ? 330 : 440;
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 400, (n - i) / 400);
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 2500 * fade), 44 + i * 2);
  }
  return buf;
}

/** WAV clips of the same format as one clip (the mock voice's; the real services make MP3, which needs no more than joining). */
function joinWavs(wavs) {
  const data = Buffer.concat(wavs.map((w) => w.subarray(44)));
  const out = Buffer.concat([Buffer.from(wavs[0].subarray(0, 44)), data]);
  out.writeUInt32LE(36 + data.length, 4);
  out.writeUInt32LE(data.length, 40);
  return out;
}

const MOCK_VOICES = [
  { id: 'mock-A', name: 'Mock A', lang: 'zh-TW', gender: 'female', multilingual: true, quality: 3 },
  { id: 'mock-B', name: 'Mock B', lang: 'en-US', gender: 'male', multilingual: true, quality: 3 },
];
const mockProvider = () => ({
  async fetchVoices() { return MOCK_VOICES; },
  async synthesize({ text, voice }) { return { audio: mockWav(text, voice), type: 'audio/wav' }; },
});

/** Whatever went wrong talking to the service, as an error with a status and a sentence a person can read. */
function asTtsError(err) {
  if (err instanceof TtsError) return err;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new TtsError('The speech service did not answer in time.', 504);
  return new TtsError('Could not reach the speech service.', 502);
}

// ---------------------------------------------------------------- the service the server uses
/** Services whose voices belong to a language (a text that mixes languages is read by several of them, one per language). */
const PER_LANGUAGE = new Set(['edge', 'azure', 'google', 'mock']);
const speakable = (s) => /[\p{L}\p{N}]/u.test(s);

/**
 * @param cfg  from ttsConfig()
 * @param deps { fetchImpl, WebSocketImpl, now } — replaced in tests
 */
export function createTts(cfg, { fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, now = Date.now, cacheBytes = 64 * 1024 * 1024, concurrency = 4 } = {}) {
  if (!cfg.available) throw new TtsError(`server voices are not available: ${cfg.reason || 'not configured'}`, 503);
  const joinClips = cfg.provider === 'mock' ? joinWavs : (pieces) => Buffer.concat(pieces);
  const impl = cfg.provider === 'mock' ? mockProvider()
    : cfg.provider === 'edge' ? edgeProvider({ WebSocketImpl, fetchImpl, now })
    : cfg.provider === 'azure' ? azureProvider({ cfg, fetchImpl })
    : cfg.provider === 'google' ? googleProvider({ cfg, fetchImpl })
    : openaiProvider({ cfg, fetchImpl });

  // the voice list is fetched once and kept for a day (a failed fetch is retried on the next request)
  let voiceList = null, voiceListAt = 0, voiceListPending = null;
  async function allVoices() {
    if (voiceList && now() - voiceListAt < 86_400_000) return voiceList;
    voiceListPending ??= impl.fetchVoices().then((v) => { voiceList = v; voiceListAt = now(); return v; }, (err) => { throw asTtsError(err); }).finally(() => { voiceListPending = null; });
    return voiceListPending;
  }

  /** Voices for a language, best first, and the one used when the listener has not chosen. A failed list falls back to the built-in picks. */
  async function voices(lang) {
    if (!LANG_TAG.test(String(lang || ''))) throw new TtsError('lang missing or malformed', 400);
    if (cfg.provider === 'openai' || cfg.provider === 'custom') {
      const list = await allVoices();
      return { voices: list, defaultVoice: cfg.defaultVoice };
    }
    let list;
    try { list = await allVoices(); }
    catch (err) {
      const id = [...KNOWN_GOOD].find((v) => v.toLowerCase().startsWith(String(lang).toLowerCase() + '-')) || [...KNOWN_GOOD].find((v) => primary(v) === primary(lang));
      if (!id || cfg.provider === 'google') throw err;
      return { voices: [], defaultVoice: id, listError: err.message };
    }
    const mine = voicesFor(list, lang);
    return { voices: mine, defaultVoice: mine[0]?.id || '' };
  }

  // ---- cache, de-duplication, and a limit on parallel requests to the provider
  const cache = new Map(); let cached = 0;
  const pending = new Map();
  let running = 0; const waiting = [];
  const slot = async () => { if (running >= concurrency) await new Promise((r) => waiting.push(r)); running++; };
  const release = () => { running--; waiting.shift()?.(); };

  /** One piece of text in one voice: from the cache, or made once even if asked for several times at the same moment. */
  async function clipOf(text, voice, lang) {
    const key = crypto.createHash('sha256').update(`${cfg.provider}\n${voice}\n${text}`).digest('hex');
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return { ...hit, cached: true }; }
    if (!pending.has(key)) {
      const job = (async () => {
        await slot();
        try {
          let out;
          try { out = await impl.synthesize({ text, voice, lang }); }
          catch (err) { throw asTtsError(err); }
          if (!out.audio.length) throw new TtsError('the voice service returned an empty clip');
          cache.set(key, out); cached += out.audio.length;
          for (const [k, v] of cache) { if (cached <= cacheBytes) break; cache.delete(k); cached -= v.audio.length; }
          return out;
        } finally { release(); }
      })().finally(() => pending.delete(key));
      pending.set(key, job);
    }
    return { ...(await pending.get(key)), cached: false };
  }

  // ---- who reads what: a text that mixes languages is cut into runs by writing system (speech-plan.js, the same planner the
  // phone's own voices use), and each run is read by a voice of its language
  const knownLangs = new Set([...KNOWN_GOOD].map(primary));

  /** The voice the listener chose for a language: for that very language, else for another form of it (zh-TW's for zh-CN). */
  const chosenFor = (map, lang) => map[Object.keys(map).find((k) => k.toLowerCase() === String(lang).toLowerCase())] || map[Object.keys(map).find((k) => primary(k) === primary(lang))] || '';

  async function planParts({ raw, lang, voice, chosen, mixed }) {
    const mode = MIXED_MODES.includes(mixed) ? mixed : 'off';
    const mainLang = lang || 'en-US';
    const split = mode !== 'off' && PER_LANGUAGE.has(cfg.provider);
    let planned = [{ text: raw, lang: mainLang }];
    if (split) {
      let list = null;
      try { list = await allVoices(); } catch { /* the built-in picks tell which languages there are voices for */ }
      const hasVoice = (l) => (list ? list.some((v) => primary(v.lang) === primary(l)) : knownLangs.has(primary(l)));
      planned = planSpeech(raw, { lang: mainLang, mode, hasVoice });
    }
    const parts = planned.map((p) => ({ lang: p.lang, text: cleanForSpeech(p.text) })).filter((p) => speakable(p.text));
    if (!parts.length) throw new TtsError('there is nothing to speak in this text', 400);

    const mainVoice = voice || chosenFor(chosen, mainLang) || (await voices(mainLang)).defaultVoice;
    if (!mainVoice) throw new TtsError(`no voice for ${mainLang}`, 404);
    const byLang = new Map();
    for (const p of parts) {
      const k = primary(p.lang);
      if (!byLang.has(k)) byLang.set(k, k === primary(mainLang) ? mainVoice : chosenFor(chosen, p.lang) || (await voices(p.lang).catch(() => ({}))).defaultVoice || mainVoice);
      p.voice = byLang.get(k);
    }
    const merged = []; // neighbours in the same voice are one clip: fewer requests, no seam
    for (const p of parts) {
      const last = merged.at(-1);
      if (last && last.voice === p.voice) last.text += ` ${p.text}`; else merged.push({ ...p });
    }
    return merged;
  }

  async function synthesize({ text, lang, voice, voices: chosen, mixed }) {
    const raw = String(text ?? '');
    if (!raw.trim()) throw new TtsError('text missing', 400);
    if (raw.length > MAX_TEXT) throw new TtsError(`text too long (max ${MAX_TEXT} characters)`, 413);
    if (lang && !LANG_TAG.test(lang)) throw new TtsError('lang malformed', 400);
    if (voice && !VOICE_ID.test(voice)) throw new TtsError('voice malformed', 400);
    const map = {}; // the listener's voices per language; entries that make no sense are ignored rather than refused
    if (chosen && typeof chosen === 'object' && !Array.isArray(chosen)) {
      for (const [k, v] of Object.entries(chosen).slice(0, 60)) if (LANG_TAG.test(k) && typeof v === 'string' && VOICE_ID.test(v)) map[k] = v;
    }

    const parts = await planParts({ raw, lang, voice, chosen: map, mixed });
    const clips = await Promise.all(parts.map((p) => clipOf(p.text, p.voice, p.lang)));
    const pieces = clips.map((c) => c.audio);
    const audio = pieces.length === 1 ? pieces[0] : joinClips(pieces); // MP3 frames can simply follow one another
    return { audio, type: clips[0].type, voice: [...new Set(parts.map((p) => p.voice))].join('+'), parts: parts.length, cached: clips.every((c) => c.cached) };
  }

  return { provider: cfg.provider, label: cfg.label, official: cfg.official, voices, synthesize, stats: () => ({ cachedClips: cache.size, cachedBytes: cached }) };
}
