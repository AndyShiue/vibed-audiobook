// Keeps playback alive and controllable when the phone is in a pocket:
//  • a looping silent <audio> element makes the browser treat the page as "playing media"
//    (helps against tab freezing and unlocks lock-screen / headset controls via Media Session)
//  • Screen Wake Lock keeps the display on while listening (speech synthesis stops in most mobile
//    browsers once the screen locks)
function silentWavUrl() {
  const rate = 8000, n = rate; // 1 second
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export class Session {
  constructor(handlers, getSettings) {
    this.h = handlers;
    this.getSettings = getSettings;
    this.audio = null;
    this.lock = null;
    this.wantLock = false;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.wantLock) this.acquireLock(); });
    this.bindMediaSession();
  }

  bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* unsupported action */ } };
    set('play', () => this.h.play());
    set('pause', () => this.h.pause());
    set('previoustrack', () => this.h.prev());
    set('nexttrack', () => this.h.next());
    set('seekbackward', () => this.h.prev());
    set('seekforward', () => this.h.next());
  }

  /** Call from a user gesture when playback starts. */
  async engage() {
    try {
      if (!this.audio) {
        this.audio = new Audio(silentWavUrl());
        this.audio.loop = true;
        this.audio.setAttribute('playsinline', '');
      }
      await this.audio.play();
    } catch { /* blocked or unsupported — narration still works, just without background hints */ }
    this.wantLock = true;
    this.acquireLock();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  }

  release() {
    this.wantLock = false;
    try { this.audio?.pause(); } catch { /* ignore */ }
    this.releaseLock();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }

  async acquireLock() {
    if (!this.getSettings().wakeLock || !('wakeLock' in navigator) || this.lock) return;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => { this.lock = null; });
    } catch { this.lock = null; }
  }

  releaseLock() { try { this.lock?.release(); } catch { /* ignore */ } this.lock = null; }

  setMetadata({ title, artist, album }) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist, album,
      artwork: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
}
