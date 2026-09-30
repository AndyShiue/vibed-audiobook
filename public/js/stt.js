// Speech-to-text for spoken questions (Web Speech API; needs Chrome/Safari over HTTPS).
const getSR = () => (typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null);
export const sttSupported = () => !!getSR();

export class Listener {
  constructor() { this.rec = null; }

  /**
   * Listen for one utterance.
   * Resolves {text} on success or {error} — 'no-speech' | 'not-allowed' | 'aborted' | 'network' | …
   */
  listen({ lang = 'en-US', onInterim = () => {}, onReady = () => {}, noSpeechMs = 9000, maxMs = 40000 } = {}) {
    return new Promise((resolve) => {
      const SR = getSR();
      if (!SR) return resolve({ error: 'unsupported' });
      const rec = new SR();
      rec.lang = lang;
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      let finalText = '', interim = '', heard = false, settled = false, readied = false, t1, t2;
      const ready = () => { if (!readied) { readied = true; try { onReady(); } catch { /* ignore */ } } };
      rec.onaudiostart = ready;             // the microphone is really capturing now
      rec.onstart = () => setTimeout(ready, 400); // engines without `audiostart`
      const done = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(t1); clearTimeout(t2);
        this.rec = null;
        try { rec.abort(); } catch { /* already stopped */ }
        resolve(res);
      };
      rec.onresult = (e) => {
        heard = true;
        finalText = ''; interim = '';
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
        }
        onInterim((finalText + interim).trim());
      };
      rec.onerror = (e) => {
        const text = (finalText || interim).trim();
        if (e.error === 'no-speech') done({ error: 'no-speech' });
        else if (e.error === 'aborted') done(text ? { text } : { error: 'aborted' });
        else if (e.error === 'not-allowed' || e.error === 'service-not-allowed') done({ error: 'not-allowed' });
        else done(text ? { text } : { error: e.error || 'error' });
      };
      rec.onend = () => {
        const text = (finalText || interim).trim();
        done(text ? { text } : { error: 'no-speech' });
      };
      t1 = setTimeout(() => { if (!heard) done({ error: 'no-speech' }); }, noSpeechMs);
      t2 = setTimeout(() => { try { rec.stop(); } catch { /* ignore */ } }, maxMs);
      this.rec = rec;
      try { rec.start(); } catch { done({ error: 'start-failed' }); }
    });
  }

  /** Stop listening and deliver whatever was heard so far. */
  stop() { try { this.rec?.stop(); } catch { /* ignore */ } }
  abort() { try { this.rec?.abort(); } catch { /* ignore */ } }
  get active() { return !!this.rec; }
}
