// Server voices (tts-providers.js): configuration, the Edge read-aloud protocol, the official/OpenAI-compatible request formats,
// voice choice, and the cache — against fake WebSocket / fetch implementations, so no network or key is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ttsConfig, publicInfo, createTts, secMsGec, parseEdgeFrame, voicesFor, pickDefaultVoice, mockWav, TtsError, MAX_TEXT } from '../tts-providers.js';

// ---------------------------------------------------------------- configuration
test('configuration: Edge voices by default, "off" turns them off, and every provider says what it is missing', () => {
  assert.deepEqual(pickPublic(ttsConfig({})), { available: true, provider: 'edge', official: false });
  assert.equal(ttsConfig({}, { hasWebSocket: false }).available, false);
  assert.match(ttsConfig({}, { hasWebSocket: false }).reason, /Node\.js 22/);
  assert.equal(ttsConfig({ TTS_PROVIDER: 'off' }).available, false);
  assert.equal(ttsConfig({ TTS_PROVIDER: 'nonsense' }).available, false);
  assert.match(ttsConfig({ TTS_PROVIDER: 'nonsense' }).reason, /not one of/);
  assert.match(ttsConfig({ TTS_PROVIDER: 'azure' }).reason, /AZURE_SPEECH_KEY and AZURE_SPEECH_REGION/);
  assert.match(ttsConfig({ TTS_PROVIDER: 'google' }).reason, /GOOGLE_TTS_API_KEY/);
  assert.match(ttsConfig({ TTS_PROVIDER: 'openai' }).reason, /OPENAI_API_KEY/);
  assert.match(ttsConfig({ TTS_PROVIDER: 'custom' }).reason, /TTS_BASE_URL/);
  const azure = ttsConfig({ TTS_PROVIDER: 'azure', AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: ' EastUS ' });
  assert.equal(azure.available, true); assert.equal(azure.region, 'eastus'); assert.equal(azure.official, true);
  const oa = ttsConfig({ TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });
  assert.equal(oa.base, 'https://api.openai.com/v1'); assert.equal(oa.defaultVoice, 'alloy'); assert.ok(oa.voiceNames.includes('coral'));
  const custom = ttsConfig({ TTS_PROVIDER: 'custom', TTS_BASE_URL: 'http://localhost:8880/v1/', TTS_VOICES: 'af_heart, zf_xiaobei', TTS_VOICE: 'zf_xiaobei' });
  assert.equal(custom.base, 'http://localhost:8880/v1'); assert.equal(custom.model, 'tts-1'); assert.deepEqual(custom.voiceNames, ['af_heart', 'zf_xiaobei']); assert.equal(custom.defaultVoice, 'zf_xiaobei');
  assert.equal(ttsConfig({ TTS_PROVIDER: 'edge' }, { mock: true }).provider, 'mock');
  assert.equal(ttsConfig({ TTS_PROVIDER: 'off' }, { mock: true }).available, false);
});

const pickPublic = (cfg) => ({ available: cfg.available, provider: cfg.provider, official: cfg.official });

test('the browser is never told a key', () => {
  const cfg = ttsConfig({ TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-secret-123' });
  assert.ok(!JSON.stringify(publicInfo(cfg)).includes('sk-secret'));
  assert.deepEqual(Object.keys(publicInfo(cfg)).sort(), ['available', 'label', 'official', 'provider', 'reason']);
});

// ---------------------------------------------------------------- the Edge protocol
test('Sec-MS-GEC equals the reference implementation (edge-tts) and only changes every five minutes', () => {
  const at = (unix) => secMsGec(unix * 1000);
  assert.equal(at(1767225600), '42D1947403FD94975436C65DBFCA8003073F9CB5C3F1CE25AF8961A11D7C3DFE');
  assert.equal(at(1767225899), '42D1947403FD94975436C65DBFCA8003073F9CB5C3F1CE25AF8961A11D7C3DFE', 'same five-minute window');
  assert.equal(at(1767225901.5), 'D1555CE75F459479ED05B765B3F720D547F27509AD68D10106360D2A35FAE324');
  assert.equal(at(1790000123.456), '8FD81A00C2EAEDB004963D5A0BD37C00DAF969A0A8FB3B08C469C9BEF94498F2');
  assert.equal(secMsGec(1767225000 * 1000, 600), at(1767225600), 'a clock skew moves the window');
});

function frame(headers, body = Buffer.alloc(0)) {
  const h = Buffer.from(Object.entries(headers).map(([k, v]) => `${k}:${v}`).join('\r\n'));
  const out = Buffer.alloc(2 + h.length + body.length);
  out.writeUInt16BE(h.length, 0); h.copy(out, 2); Buffer.from(body).copy(out, 2 + h.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

test('binary frames: a length, headers, then the audio', () => {
  const f = parseEdgeFrame(Buffer.from(frame({ 'X-RequestId': 'abc', 'Content-Type': 'audio/mpeg', Path: 'audio' }, Buffer.from([1, 2, 3]))));
  assert.equal(f.headers.Path, 'audio'); assert.equal(f.headers['Content-Type'], 'audio/mpeg'); assert.deepEqual([...f.body], [1, 2, 3]);
  assert.equal(parseEdgeFrame(Buffer.from([0])), null);
  assert.equal(parseEdgeFrame(Buffer.from([0, 200, 65])), null, 'a header longer than the message');
});

/** A WebSocket that behaves like the Edge service: after the two requests it sends turn.start, audio frames, turn.end. */
function fakeEdgeSocket(behaviour = {}) {
  return class FakeSocket {
    static instances = [];
    constructor(url, opts) {
      this.url = url; this.opts = opts; this.sent = []; this.handlers = {};
      FakeSocket.instances.push(this);
      const attempt = FakeSocket.instances.length;
      queueMicrotask(() => {
        if (behaviour.failBeforeOpen?.(attempt, this)) { this.emit('error', {}); this.emit('close', {}); return; }
        this.emit('open', {});
      });
    }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    emit(type, ev) { for (const fn of this.handlers[type] || []) fn(ev); }
    send(message) {
      this.sent.push(message);
      if (this.sent.length === 2) queueMicrotask(() => {
        this.emit('message', { data: 'X-RequestId:1\r\nContent-Type:application/json; charset=utf-8\r\nPath:turn.start\r\n\r\n{}' });
        for (const chunk of behaviour.audioFor ? behaviour.audioFor(this.sent[1]) : behaviour.audio ?? [[1, 2, 3], [4, 5]]) this.emit('message', { data: frame({ 'X-RequestId': '1', 'Content-Type': 'audio/mpeg', Path: 'audio' }, Buffer.from(chunk)) });
        this.emit('message', { data: frame({ 'X-RequestId': '1', Path: 'audio' }) }); // the empty closing frame
        this.emit('message', { data: 'X-RequestId:1\r\nPath:turn.end\r\n\r\n{}' });
      });
    }
    close() { queueMicrotask(() => this.emit('close', {})); }
  };
}

const edge = (WebSocketImpl, extra = {}) => createTts(ttsConfig({}), { WebSocketImpl, ...extra });

test('Edge: sends the config and the SSML (escaped, with the voice) and joins the audio frames', async () => {
  const WS = fakeEdgeSocket();
  const tts = edge(WS);
  const out = await tts.synthesize({ text: 'Tom & Jerry 說「你好」', lang: 'zh-TW', voice: 'zh-TW-HsiaoChenNeural' });
  assert.deepEqual([...out.audio], [1, 2, 3, 4, 5]);
  assert.equal(out.type, 'audio/mpeg');
  const [ws] = WS.instances;
  assert.match(ws.url, /^wss:\/\/speech\.platform\.bing\.com\/consumer\/speech\/synthesize\/readaloud\/edge\/v1\?TrustedClientToken=[0-9A-F]{32}&ConnectionId=[0-9a-f]{32}&Sec-MS-GEC=[0-9A-F]{64}&Sec-MS-GEC-Version=1-/);
  assert.match(ws.opts.headers.Origin, /^chrome-extension:\/\//);
  assert.match(ws.opts.headers.Cookie, /^muid=[0-9A-F]{32};$/);
  assert.match(ws.sent[0], /Path:speech\.config/); assert.match(ws.sent[0], /audio-24khz-48kbitrate-mono-mp3/);
  assert.match(ws.sent[1], /Path:ssml/); assert.match(ws.sent[1], /Content-Type:application\/ssml\+xml/);
  assert.ok(ws.sent[1].includes("<voice name='zh-TW-HsiaoChenNeural'>"));
  assert.ok(ws.sent[1].includes('Tom &amp; Jerry 說你好'), 'text is cleaned for speech (no quotation marks) and escaped for XML');
  assert.ok(ws.sent[1].includes("xml:lang='zh-TW'"));
});

test('Edge: an answer without audio is an error, and so is a connection that cannot be made', async () => {
  await assert.rejects(() => edge(fakeEdgeSocket({ audio: [] })).synthesize({ text: 'hi', lang: 'en-US', voice: 'en-US-AvaNeural' }), /no audio/);
  const WS = fakeEdgeSocket({ failBeforeOpen: () => true });
  await assert.rejects(() => edge(WS, { fetchImpl: async () => new Response('', { status: 200 }) }).synthesize({ text: 'hi', lang: 'en-US', voice: 'en-US-AvaNeural' }), (e) => e instanceof TtsError && /Could not connect/.test(e.message));
  assert.equal(WS.instances.length, 1, 'no retry when the clock is not the problem');
});

test('Edge: when the computer\'s clock is off the service says so (403 + Date) and the request is tried again with its time', async () => {
  const now = () => Date.UTC(2026, 9, 1, 12, 0, 0);
  const serviceNow = now() + 20 * 60_000; // this computer is 20 minutes behind
  const WS = fakeEdgeSocket({ failBeforeOpen: (attempt) => attempt === 1 });
  const fetchImpl = async () => new Response('', { status: 403, headers: { Date: new Date(serviceNow).toUTCString() } });
  const out = await createTts(ttsConfig({}), { WebSocketImpl: WS, fetchImpl, now }).synthesize({ text: 'hi', lang: 'en-US', voice: 'en-US-AvaNeural' });
  assert.equal(out.audio.length, 5);
  assert.equal(WS.instances.length, 2);
  const gec = (ws) => /Sec-MS-GEC=([0-9A-F]+)/.exec(ws.url)[1];
  assert.notEqual(gec(WS.instances[0]), gec(WS.instances[1]));
  assert.equal(gec(WS.instances[1]), secMsGec(serviceNow));
});

// ---------------------------------------------------------------- choosing voices
const V = (id, lang, extra = {}) => ({ id, name: id, lang, gender: 'female', multilingual: false, quality: 3, ...extra });
const LIST = [
  V('zh-CN-XiaoxiaoNeural', 'zh-CN'), V('zh-TW-YunJheNeural', 'zh-TW', { gender: 'male' }), V('zh-TW-HsiaoYuNeural', 'zh-TW'), V('zh-TW-HsiaoChenNeural', 'zh-TW'),
  V('en-US-AriaNeural', 'en-US'), V('en-US-AvaMultilingualNeural', 'en-US', { multilingual: true }), V('en-GB-SoniaNeural', 'en-GB'),
  V('ja-JP-KeitaNeural', 'ja-JP', { gender: 'male' }), V('ja-JP-NanamiNeural', 'ja-JP'),
  V('fr-FR-VivienneMultilingualNeural', 'fr-FR', { multilingual: true }), V('fr-FR-DeniseNeural', 'fr-FR'),
];

test('voice choice: the language\'s own voices first (exact locale, known-good, multilingual), then voices that read any language', () => {
  assert.equal(pickDefaultVoice(LIST, 'zh-TW').id, 'zh-TW-HsiaoChenNeural');
  assert.equal(pickDefaultVoice(LIST, 'zh-CN').id, 'zh-CN-XiaoxiaoNeural');
  assert.equal(pickDefaultVoice(LIST, 'en-US').id, 'en-US-AvaMultilingualNeural');
  assert.equal(pickDefaultVoice(LIST, 'en-GB').id, 'en-GB-SoniaNeural', 'the exact locale beats a multilingual voice of another one');
  assert.equal(pickDefaultVoice(LIST, 'ja-JP').id, 'ja-JP-NanamiNeural', 'not the male voice that happens to be listed first');
  const zh = voicesFor(LIST, 'zh-TW').map((v) => v.id);
  assert.deepEqual(zh.slice(0, 4).sort(), ['zh-CN-XiaoxiaoNeural', 'zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural', 'zh-TW-YunJheNeural']);
  assert.deepEqual(zh.slice(4).sort(), ['en-US-AvaMultilingualNeural', 'fr-FR-VivienneMultilingualNeural'], 'multilingual voices of other languages are offered at the end');
  assert.deepEqual(voicesFor(LIST, 'sw-KE').map((v) => v.id).sort(), ['en-US-AvaMultilingualNeural', 'fr-FR-VivienneMultilingualNeural']);
  assert.equal(pickDefaultVoice([V('x-XX-A', 'x-XX')], 'ko-KR'), null);
});

const voiceListResponse = () => new Response(JSON.stringify(LIST.map((v) => ({ ShortName: v.id, Locale: v.lang, Gender: v.gender === 'male' ? 'Male' : 'Female', Status: 'GA' }))), { status: 200, headers: { 'content-type': 'application/json' } });

test('Edge: the voice list is fetched once and a clip without a chosen voice uses the default for its language', async () => {
  let listCalls = 0;
  const WS = fakeEdgeSocket();
  const tts = createTts(ttsConfig({}), { WebSocketImpl: WS, fetchImpl: async () => { listCalls++; return voiceListResponse(); } });
  const v = await tts.voices('zh-TW');
  assert.equal(v.defaultVoice, 'zh-TW-HsiaoChenNeural');
  assert.equal(v.voices[0].id, 'zh-TW-HsiaoChenNeural');
  await tts.voices('en-US'); await tts.voices('ja-JP');
  assert.equal(listCalls, 1);
  const out = await tts.synthesize({ text: '你好', lang: 'zh-TW' });
  assert.equal(out.voice, 'zh-TW-HsiaoChenNeural');
  assert.ok(WS.instances[0].sent[1].includes("<voice name='zh-TW-HsiaoChenNeural'>"));
});

test('Edge: when the voice list cannot be fetched, built-in picks still let a clip be made', async () => {
  const tts = createTts(ttsConfig({}), { WebSocketImpl: fakeEdgeSocket(), fetchImpl: async () => { throw new Error('offline'); } });
  const v = await tts.voices('ja-JP');
  assert.equal(v.defaultVoice, 'ja-JP-NanamiNeural'); assert.deepEqual(v.voices, []); assert.match(v.listError, /Could not reach the speech service/);
  assert.equal((await tts.synthesize({ text: 'こんにちは', lang: 'ja-JP' })).voice, 'ja-JP-NanamiNeural');
});

// ---------------------------------------------------------------- a text that mixes languages
/** An Edge service whose audio says which voice made it, so the order and the voices of the joined clip can be checked. */
function mixedEdge(extra = {}) {
  const tag = (ssmlText) => { const voice = /<voice name='([^']+)'>/.exec(ssmlText)[1]; return [[...Buffer.from(voice.slice(0, 2))], [...Buffer.from(/>([^<]*)<\/prosody>/.exec(ssmlText)[1].slice(0, 1))]]; };
  const WS = fakeEdgeSocket({ audioFor: tag });
  const tts = createTts(ttsConfig({}), { WebSocketImpl: WS, fetchImpl: async () => voiceListResponse(), ...extra });
  return { tts, WS };
}
const voiceOf = (ws) => /<voice name='([^']+)'>/.exec(ws.sent[1])[1];
const textOf = (ws) => /<prosody[^>]*>([^<]*)<\/prosody>/.exec(ws.sent[1])[1];
const asText = (audio) => Buffer.from(audio).toString('utf8');

test('a Chinese sentence with English words is made of clips in the voices of their languages, joined in order', async () => {
  const { tts, WS } = mixedEdge();
  const out = await tts.synthesize({ text: '我昨天在 Apple Store 買了一支手機。', lang: 'zh-TW', mixed: 'words' });
  assert.equal(out.parts, 3);
  assert.equal(out.voice, 'zh-TW-HsiaoChenNeural+en-US-AvaMultilingualNeural');
  assert.deepEqual(WS.instances.map((w) => [voiceOf(w), textOf(w)]), [
    ['zh-TW-HsiaoChenNeural', '我昨天在'], ['en-US-AvaMultilingualNeural', 'Apple Store'], ['zh-TW-HsiaoChenNeural', '買了一支手機。'],
  ]);
  assert.equal(asText(out.audio), 'zh我' + 'enA' + 'zh買', 'each clip in its place: zh + 我, en + A, zh + 買');
});

test('the listener\'s voice for a language is used for that language; neighbours in the same voice are one clip', async () => {
  const { tts, WS } = mixedEdge();
  const chosen = await tts.synthesize({ text: '我昨天在 Apple Store 買了一支手機。', lang: 'zh-TW', mixed: 'words', voices: { 'zh-TW': 'zh-TW-YunJheNeural', 'en-US': 'en-US-BrianNeural' } });
  assert.equal(chosen.voice, 'zh-TW-YunJheNeural+en-US-BrianNeural');
  assert.ok(WS.instances.some((w) => voiceOf(w) === 'en-US-BrianNeural' && textOf(w) === 'Apple Store'));
  const before = WS.instances.length;
  const same = await tts.synthesize({ text: '我昨天在 Apple Store 買了一支手機。', lang: 'zh-TW', mixed: 'words', voices: { 'zh-TW': 'en-US-AvaMultilingualNeural', 'en-US': 'en-US-AvaMultilingualNeural' } });
  assert.equal(same.parts, 1, 'one voice for everything: one clip');
  assert.equal(WS.instances.length, before + 1);
  assert.equal(textOf(WS.instances.at(-1)), '我昨天在 Apple Store 買了一支手機。');
});

test('each piece is cached on its own: changing the English voice makes only the English clip again', async () => {
  const { tts, WS } = mixedEdge();
  const ask = (en) => tts.synthesize({ text: '我昨天在 Apple Store 買了一支手機。', lang: 'zh-TW', mixed: 'words', voices: { 'en-US': en } });
  assert.equal((await ask('en-US-AvaMultilingualNeural')).cached, false);
  assert.equal(WS.instances.length, 3);
  assert.equal((await ask('en-US-AvaMultilingualNeural')).cached, true);
  assert.equal(WS.instances.length, 3);
  assert.equal((await ask('en-US-BrianNeural')).cached, false);
  assert.equal(WS.instances.length, 4, 'only the English clip was made again');
});

test('"off", no "mixed" at all, and services whose voices read every language make one clip', async () => {
  const { tts, WS } = mixedEdge();
  const text = '他說了 Python 和 Apple Store。';
  assert.equal((await tts.synthesize({ text, lang: 'zh-TW', mixed: 'off' })).parts, 1);
  assert.equal((await tts.synthesize({ text: text + '。', lang: 'zh-TW' })).parts, 1);
  assert.equal(WS.instances.length, 2);
  const seen = [];
  const openai = createTts(ttsConfig({ TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }), { fetchImpl: async (url, init) => { seen.push(JSON.parse(init.body)); return bytes(1, 2); } });
  const out = await openai.synthesize({ text, lang: 'zh-TW', mixed: 'words' });
  assert.equal(out.parts, 1); assert.equal(seen.length, 1);
  assert.equal(seen[0].input, text);
});

test('a whole English sentence in a Chinese book is read by the English voice; a language the service has no voice for stays', async () => {
  const { tts } = mixedEdge();
  const en = await tts.synthesize({ text: 'Pride and Prejudice is a novel about manners and marriage.', lang: 'zh-TW', mixed: 'words' });
  assert.equal(en.voice, 'en-US-AvaMultilingualNeural');
  assert.equal(en.parts, 1);
  const list = LIST.filter((v) => !v.lang.startsWith('en'));
  const noEnglish = createTts(ttsConfig({}), { WebSocketImpl: fakeEdgeSocket(), fetchImpl: async () => new Response(JSON.stringify(list.map((v) => ({ ShortName: v.id, Locale: v.lang, Gender: 'Female', Status: 'GA' }))), { status: 200 }) });
  const stays = await noEnglish.synthesize({ text: '我昨天在 Apple Store 買了一支手機。', lang: 'zh-TW', mixed: 'words' });
  assert.equal(stays.parts, 1, 'no English voice: the words stay with the Chinese one');
});

test('the listener\'s voices are checked: nonsense entries are ignored, and a text with nothing to say is refused', async () => {
  const { tts } = mixedEdge();
  const out = await tts.synthesize({ text: '你好', lang: 'zh-TW', mixed: 'words', voices: { 'zh-TW': "bad'voice", xx: 5, '??': 'v', 'en-US': 7 } });
  assert.equal(out.voice, 'zh-TW-HsiaoChenNeural');
  await assert.rejects(() => tts.synthesize({ text: '……「」', lang: 'zh-TW', mixed: 'words' }), (e) => e.status === 400);
  assert.ok((await tts.synthesize({ text: '你好', lang: 'zh-TW', mixed: 'words', voices: 'not even an object' })).audio.length);
});

// ---------------------------------------------------------------- OpenAI and compatible servers
const bytes = (...n) => new Response(Buffer.from(n), { status: 200, headers: { 'content-type': 'audio/mpeg' } });

test('OpenAI-compatible: POST /audio/speech with the model, voice and text; the key goes in the header', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init, body: JSON.parse(init.body) }); return bytes(9, 8, 7); };
  const tts = createTts(ttsConfig({ TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', TTS_MODEL: 'tts-1' }), { fetchImpl });
  const out = await tts.synthesize({ text: '你好 world', lang: 'zh-TW' });
  assert.deepEqual([...out.audio], [9, 8, 7]);
  assert.equal(out.voice, 'alloy');
  assert.equal(seen[0].url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(seen[0].body, { model: 'tts-1', input: '你好 world', voice: 'alloy', response_format: 'mp3' });
  const v = await tts.voices('zh-TW');
  assert.equal(v.defaultVoice, 'alloy'); assert.ok(v.voices.every((x) => x.multilingual));
});

test('a self-hosted OpenAI-compatible server needs no key', async () => {
  const seen = [];
  const tts = createTts(ttsConfig({ TTS_PROVIDER: 'custom', TTS_BASE_URL: 'http://localhost:8880/v1', TTS_VOICES: 'zf_xiaobei,af_heart' }), { fetchImpl: async (url, init) => { seen.push({ url, init }); return bytes(1); } });
  const out = await tts.synthesize({ text: 'hi', lang: 'en-US', voice: 'af_heart' });
  assert.equal(out.voice, 'af_heart');
  assert.equal(seen[0].url, 'http://localhost:8880/v1/audio/speech');
  assert.equal(seen[0].init.headers.Authorization, undefined);
});

test('upstream errors become readable ones — and never a 401, which the browser would take for a wrong ACCESS_TOKEN', async () => {
  const failing = (status, body = {}) => createTts(ttsConfig({ TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }), { fetchImpl: async () => new Response(JSON.stringify(body), { status }) });
  const run = (tts) => tts.synthesize({ text: 'hi', lang: 'en-US', voice: 'alloy' });
  await assert.rejects(() => run(failing(401)), (e) => e.status === 502 && /key was rejected/.test(e.message));
  await assert.rejects(() => run(failing(403)), (e) => e.status === 502);
  await assert.rejects(() => run(failing(429)), (e) => e.status === 429);
  await assert.rejects(() => run(failing(429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } })), (e) => e.status === 402);
  await assert.rejects(() => run(failing(400, { error: { message: 'bad voice' } })), (e) => e.status === 400 && /bad voice/.test(e.message));
  await assert.rejects(() => run(failing(500)), (e) => e.status === 502);
});

// ---------------------------------------------------------------- Azure and Google
test('Azure: SSML to the region\'s endpoint with the subscription key; the voice list is read from the same host', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    if (url.endsWith('/voices/list')) return voiceListResponse();
    return bytes(5, 5);
  };
  const tts = createTts(ttsConfig({ TTS_PROVIDER: 'azure', AZURE_SPEECH_KEY: 'azure-key', AZURE_SPEECH_REGION: 'eastasia' }), { fetchImpl });
  const out = await tts.synthesize({ text: 'a & b', lang: 'zh-TW' });
  assert.equal(out.voice, 'zh-TW-HsiaoChenNeural');
  const post = seen.find((s) => s.init.method === 'POST');
  assert.equal(post.url, 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(post.init.headers['Ocp-Apim-Subscription-Key'], 'azure-key');
  assert.equal(post.init.headers['Content-Type'], 'application/ssml+xml');
  assert.match(post.init.headers['X-Microsoft-OutputFormat'], /mp3/);
  assert.ok(post.init.body.includes("<voice name='zh-TW-HsiaoChenNeural'>a &amp; b</voice>"));
  assert.equal(seen.find((s) => s.url.endsWith('/voices/list')).url, 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/voices/list');
  assert.equal(seen.find((s) => s.url.endsWith('/voices/list')).init.headers['Ocp-Apim-Subscription-Key'], 'azure-key');
});

test('Google: Chinese is "cmn" there, the key goes in a header, and the audio comes back as base64', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    if (url.endsWith('/voices')) return new Response(JSON.stringify({ voices: [
      { languageCodes: ['cmn-TW'], name: 'cmn-TW-Wavenet-A', ssmlGender: 'FEMALE' }, { languageCodes: ['cmn-TW'], name: 'cmn-TW-Standard-A', ssmlGender: 'FEMALE' },
      { languageCodes: ['cmn-CN'], name: 'cmn-CN-Neural2-A', ssmlGender: 'FEMALE' }, { languageCodes: ['en-US'], name: 'en-US-Neural2-C', ssmlGender: 'FEMALE' },
    ] }), { status: 200 });
    return new Response(JSON.stringify({ audioContent: Buffer.from([7, 7, 7]).toString('base64') }), { status: 200 });
  };
  const tts = createTts(ttsConfig({ TTS_PROVIDER: 'google', GOOGLE_TTS_API_KEY: 'g-key' }), { fetchImpl });
  const v = await tts.voices('zh-TW');
  assert.equal(v.defaultVoice, 'cmn-TW-Wavenet-A', 'a Wavenet voice beats a Standard one; the language is zh');
  assert.ok(v.voices.some((x) => x.lang === 'zh-CN'));
  const out = await tts.synthesize({ text: '你好', lang: 'zh-TW' });
  assert.deepEqual([...out.audio], [7, 7, 7]);
  const post = seen.find((s) => s.init.method === 'POST');
  assert.equal(post.url, 'https://texttospeech.googleapis.com/v1/text:synthesize');
  assert.ok(!post.url.includes('g-key'), 'the key is not in the URL');
  assert.equal(post.init.headers['X-Goog-Api-Key'], 'g-key');
  assert.deepEqual(JSON.parse(post.init.body), { input: { text: '你好' }, voice: { languageCode: 'cmn-TW', name: 'cmn-TW-Wavenet-A' }, audioConfig: { audioEncoding: 'MP3' } });
});

// ---------------------------------------------------------------- the cache, de-duplication and limits
const counting = (delay = 0) => {
  const state = { calls: 0, running: 0, maxRunning: 0 };
  state.fetchImpl = async () => {
    state.calls++; state.running++; state.maxRunning = Math.max(state.maxRunning, state.running);
    await new Promise((r) => setTimeout(r, delay));
    state.running--;
    return bytes(state.calls);
  };
  return state;
};
const oa = (state, extra = {}) => createTts(ttsConfig({ TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }), { fetchImpl: state.fetchImpl, ...extra });

test('the same text and voice is made once; another voice or text is made again', async () => {
  const s = counting();
  const tts = oa(s);
  const a = await tts.synthesize({ text: 'hello', lang: 'en-US', voice: 'alloy' });
  const b = await tts.synthesize({ text: 'hello', lang: 'en-US', voice: 'alloy' });
  assert.equal(s.calls, 1); assert.equal(a.cached, false); assert.equal(b.cached, true); assert.deepEqual([...b.audio], [...a.audio]);
  await tts.synthesize({ text: 'hello', lang: 'en-US', voice: 'nova' });
  await tts.synthesize({ text: 'hello!', lang: 'en-US', voice: 'alloy' });
  assert.equal(s.calls, 3);
});

test('requests for the same clip at the same moment share one upstream call; parallel upstream calls are limited', async () => {
  const s = counting(20);
  const tts = oa(s, { concurrency: 2 });
  await Promise.all(Array.from({ length: 5 }, () => tts.synthesize({ text: 'same', lang: 'en-US', voice: 'alloy' })));
  assert.equal(s.calls, 1);
  await Promise.all(Array.from({ length: 8 }, (_, i) => tts.synthesize({ text: `clip ${i}`, lang: 'en-US', voice: 'alloy' })));
  assert.equal(s.calls, 9);
  assert.ok(s.maxRunning <= 2, `at most 2 at a time, saw ${s.maxRunning}`);
});

test('the cache is bounded: the least recently used clips go first', async () => {
  const s = counting();
  const tts = oa(s, { cacheBytes: 3 }); // each fake clip is one byte
  for (const t of ['a', 'b', 'c']) await tts.synthesize({ text: t, lang: 'en-US', voice: 'alloy' });
  await tts.synthesize({ text: 'a', lang: 'en-US', voice: 'alloy' }); // touch a
  await tts.synthesize({ text: 'd', lang: 'en-US', voice: 'alloy' }); // evicts b
  assert.equal(s.calls, 4);
  assert.equal((await tts.synthesize({ text: 'a', lang: 'en-US', voice: 'alloy' })).cached, true);
  assert.equal((await tts.synthesize({ text: 'b', lang: 'en-US', voice: 'alloy' })).cached, false);
  assert.ok(tts.stats().cachedBytes <= 3);
});

test('bad input is refused before anything is sent to the provider', async () => {
  const s = counting();
  const tts = oa(s);
  const bad = (o) => tts.synthesize({ lang: 'en-US', voice: 'alloy', ...o });
  await assert.rejects(() => bad({ text: '  ' }), (e) => e.status === 400);
  await assert.rejects(() => bad({ text: 'x'.repeat(MAX_TEXT + 1) }), (e) => e.status === 413);
  await assert.rejects(() => bad({ text: 'hi', voice: "x'/><script>" }), (e) => e.status === 400);
  await assert.rejects(() => bad({ text: 'hi', lang: 'not a tag!' }), (e) => e.status === 400);
  await assert.rejects(() => tts.voices(''), (e) => e.status === 400);
  assert.equal(s.calls, 0);
  assert.ok((await bad({ text: 'x'.repeat(MAX_TEXT) })).audio.length);
});

test('a provider that is not available cannot be created', () => {
  assert.throws(() => createTts(ttsConfig({ TTS_PROVIDER: 'azure' })), (e) => e.status === 503);
});

// ---------------------------------------------------------------- the mock voice
test('mock voices make a real WAV whose length follows the text', async () => {
  const short = mockWav('hi'), long = mockWav('x'.repeat(100));
  for (const w of [short, long]) {
    assert.equal(w.toString('ascii', 0, 4), 'RIFF'); assert.equal(w.toString('ascii', 8, 12), 'WAVE');
    assert.equal(w.readUInt32LE(40), w.length - 44);
  }
  assert.ok(long.length > short.length * 5);
  assert.ok(mockWav('x'.repeat(5000)).length <= 44 + 16000 * 2 * 10, 'capped at ten seconds');
  const tts = createTts(ttsConfig({}, { mock: true }));
  const out = await tts.synthesize({ text: '測試', lang: 'zh-TW' });
  assert.equal(out.type, 'audio/wav');
  assert.equal((await tts.voices('en-US')).voices.length, 2);
});
