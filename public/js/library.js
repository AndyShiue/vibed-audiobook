// IndexedDB storage. Everything (parsed books, reading position, AI memory, Q&A history) stays
// in the browser; the server never stores any book text.
const DB_NAME = 'audiobook-companion';
const DB_VERSION = 1;
const STORES = ['books', 'content', 'progress', 'memory', 'qa'];

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const d = req.result;
      // If another tab (or "clear site data") wants to delete or upgrade the database, let go of it right away.
      // An open connection that ignores this blocks the request — and every later open() queues up behind it.
      d.onversionchange = () => { d.close(); dbPromise = null; };
      d.onclose = () => { dbPromise = null; };
      resolve(d);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => console.warn('[db] opening is blocked by another tab that still holds the database');
  });
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(...[].concat(stores).map((s) => t.objectStore(s)))).then((v) => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

const wrap = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export const store = {
  get: (name, id) => tx(name, 'readonly', (s) => wrap(s.get(id))),
  put: (name, value) => tx(name, 'readwrite', (s) => wrap(s.put(value))),
  del: (name, id) => tx(name, 'readwrite', (s) => wrap(s.delete(id))),
  all: (name) => tx(name, 'readonly', (s) => wrap(s.getAll())),
};

// ---- books
export async function listBooks() {
  const [books, progress] = await Promise.all([store.all('books'), store.all('progress')]);
  const byId = new Map(progress.map((p) => [p.id, p]));
  return books.map((b) => ({ ...b, idx: byId.get(b.id)?.idx ?? 0, progressAt: byId.get(b.id)?.updatedAt ?? 0 }))
    .sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
}

const sizeOf = (data) => ({ total: data.sents.length, chapters: data.chapters.length, chars: data.sents.reduce((t, s) => t + s.length, 0) });

export async function saveBook(id, data, kind) {
  const meta = { id, title: data.title, author: data.author, lang: data.lang, ...sizeOf(data), seg: data.seg, kind, addedAt: Date.now(), lastOpened: Date.now() };
  await tx(['books', 'content'], 'readwrite', (b, c) => Promise.all([wrap(b.put(meta)), wrap(c.put({ id, sents: data.sents, paraStart: data.paraStart, chapters: data.chapters, seg: data.seg }))]));
  return meta;
}

/**
 * A book cut again with newer sentence rules: replaces its units and moves the reading position and the Q&A log over.
 * The AI's notes are tied to the old units, so they are dropped (they are rebuilt as the listener goes on).
 */
export async function upgradeBook(id, data, { idx, qa }) {
  const old = await store.get('books', id);
  const meta = { ...old, ...sizeOf(data), seg: data.seg };
  await tx(['books', 'content', 'progress', 'memory', 'qa'], 'readwrite', (b, c, p, m, q) => Promise.all([
    wrap(b.put(meta)),
    wrap(c.put({ id, sents: data.sents, paraStart: data.paraStart, chapters: data.chapters, seg: data.seg })),
    wrap(p.put({ id, idx, updatedAt: Date.now() })),
    wrap(m.delete(id)),
    wrap(q.put({ id, items: qa.slice(-40) })),
  ]));
  return meta;
}

export async function loadBookRecord(id) {
  const [meta, content] = await Promise.all([store.get('books', id), store.get('content', id)]);
  if (!meta || !content) return null;
  return { ...meta, ...content };
}

export const touchBook = async (id) => {
  const meta = await store.get('books', id);
  if (meta) await store.put('books', { ...meta, lastOpened: Date.now() });
};

export async function deleteBook(id) {
  await Promise.all(STORES.map((s) => store.del(s, id)));
}

// ---- progress / memory / Q&A
export const getProgress = async (id) => (await store.get('progress', id))?.idx ?? 0;
export const saveProgress = (id, idx) => store.put('progress', { id, idx, updatedAt: Date.now() });
export const getMemory = (id) => store.get('memory', id);
export const saveMemory = (id, dump) => store.put('memory', { id, ...dump, updatedAt: Date.now() });
export const getQA = async (id) => (await store.get('qa', id))?.items ?? [];
export const saveQA = (id, items) => store.put('qa', { id, items: items.slice(-40) });
export const clearMemory = async (id) => { await store.del('memory', id); await store.del('qa', id); };

// ---- settings (small, synchronous, localStorage)
const SETTINGS_KEY = 'audiobook-settings-v1';
export const DEFAULT_SETTINGS = {
  v: 3,
  uiLang: 'auto',        // interface language: 'auto' = follow the phone (default) | 'zh' | 'en' | 'ja' once chosen by hand
  rate: 1.0,
  voiceURI: {},          // per language: {'zh-TW': 'voiceURI'}
  answerVoiceURI: {},
  answerPitch: 1.12,
  askLang: 'auto',       // language for the phone's built-in recognizer: 'auto' = phone language
  sttMode: 'auto',       // 'auto' | 'cloud' | 'device'
  cloudLang: 'auto',     // language hint for cloud recognition ('auto' lets it detect mixed languages)
  sttHint: false,        // send nearby book text to the recognizer (helps names, but can derail English speech)
  wakeLock: true,
  sendTitle: false,
  accessToken: '',
  sleepMinutes: 0,
  haptics: true,
  shake: false,          // shake the phone to start asking (off by default)
  shakeSens: 'normal',   // 'low' | 'normal' | 'high'
  earcons: true,
};
export function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    // v2: the book-text hint used to default to on; it turned out to derail English questions, so switch it off once.
    if ((stored.v || 1) < 2) { stored.sttHint = false; stored.v = 2; }
    // v3: the interface language follows the phone by default. Earlier builds saved 'zh' as the default together with any
    // other setting, so a stored 'zh' cannot be told from a choice and goes back to following the phone; a stored 'en' or
    // 'ja' was always chosen by hand and stays. From v3 on, whatever is stored is the listener's own choice.
    if ((stored.v || 1) < 3) { if (stored.uiLang === 'zh') delete stored.uiLang; stored.v = 3; }
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode etc. */ }
}
export const LAST_BOOK_KEY = 'audiobook-last-book';
