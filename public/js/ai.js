// Thin client for the server's two AI endpoints.
let token = '';
export const setAccessToken = (t) => { token = t || ''; };

const headers = () => ({ 'Content-Type': 'application/json', ...(token ? { 'x-access-token': token } : {}) });

export async function getConfig() {
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    return await r.json();
  } catch {
    return { ai: false, offline: true };
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message || `HTTP ${status}`), { status });
}

/** Condense already-heard text (used by the background memory builder). */
export async function summarize(request, signal) {
  const r = await fetch('/api/summarize', { method: 'POST', headers: headers(), body: JSON.stringify(request), signal });
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).error; } catch { /* ignore */ }
    throw httpError(r.status, msg);
  }
  return r.json();
}

/**
 * One clip of server voices (see tts-providers.js) as audio. `text` is the text as written: the server cuts it by language when
 * `mixed` is 'words' or 'phrases' (see speech-plan.js) and reads each piece with the voice for its language, taken from `voices`
 * ({language: voice id}) or else its own pick. With `mixed` 'off' (or none) the whole text is read with `voice`, or the server's
 * pick for `lang`. Rejects with an Error (with .status) when the server cannot make it.
 */
export async function ttsClip({ text, lang, voice = '', voices, mixed }, { signal } = {}) {
  const r = await fetch('/api/tts', { method: 'POST', headers: headers(), body: JSON.stringify({ text, lang, voice, voices, mixed }), signal });
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).error; } catch { /* ignore */ }
    throw httpError(r.status, msg);
  }
  return r.blob();
}

/** The server voices for a language, best first: { provider, label, voices:[{id, name, lang, gender, multilingual}], defaultVoice }. */
export async function ttsVoices(lang, { signal } = {}) {
  const r = await fetch('/api/tts/voices', { method: 'POST', headers: headers(), body: JSON.stringify({ lang }), signal });
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).error; } catch { /* ignore */ }
    throw httpError(r.status, msg);
  }
  return r.json();
}

/**
 * Ask a question; text arrives as a stream. `onText(delta)` is called for each chunk.
 * Resolves {refusal:boolean, tools:[{name, input}]} — `tools` are the player commands the AI chose to call, in order.
 * Rejects with an Error (with .status) on failure.
 */
export async function ask(payload, { signal, onText }) {
  const r = await fetch('/api/ask', { method: 'POST', headers: headers(), body: JSON.stringify(payload), signal });
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).error; } catch { /* ignore */ }
    throw httpError(r.status, msg);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let refusal = false;
  const tools = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let msg;
        try { msg = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (msg.error) throw httpError(msg.status || 500, msg.error);
        if (msg.t) onText(msg.t);
        if (msg.refusal) refusal = true;
        if (Array.isArray(msg.tools)) for (const c of msg.tools) if (c && typeof c.name === 'string') tools.push({ name: c.name, input: c.input && typeof c.input === 'object' ? c.input : {} });
      }
    }
  }
  return { refusal, tools };
}

const toBase64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/**
 * Cloud speech recognition: uploads the recorded question and returns the text.
 * `language` is an ISO-639-1 hint or '' for automatic detection (best for mixed-language speech);
 * `uiLang` / `bookLang` choose the script and wording of the server-side instruction;
 * `context` is optional recent book text that helps with names and rare words.
 */
export async function transcribe({ blob, mime, language = '', uiLang = '', bookLang = '', context = '' }, { signal } = {}) {
  const r = await fetch('/api/transcribe', {
    method: 'POST', headers: headers(), signal,
    body: JSON.stringify({ audio: await toBase64(blob), mime: mime || blob.type, language, uiLang, bookLang, context }),
  });
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).error; } catch { /* ignore */ }
    throw httpError(r.status, msg);
  }
  return (await r.json()).text || '';
}
