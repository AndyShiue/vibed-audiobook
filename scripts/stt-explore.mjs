// Compares OpenAI transcription models / prompts on mixed-language clips (uses OPENAI_API_KEY from .env).
//   node scripts/stt-explore.mjs <wav-folder>
import fs from 'node:fs';
import path from 'node:path';
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch { /* env may come from the shell */ }

const dir = process.argv[2];
const key = process.env.OPENAI_API_KEY;
if (!dir || !key) { console.error('usage: node scripts/stt-explore.mjs <wav-folder>   (needs OPENAI_API_KEY)'); process.exit(2); }

const MODELS = (process.env.MODELS || 'gpt-4o-transcribe,gpt-4o-mini-transcribe,gpt-transcribe,whisper-1').split(',');
const PROMPTS = {
  none: '',
  zh: '以下是台灣繁體中文的問句，可能夾雜英文單字或整句英文。請保留英文原文，不要翻譯或省略任何部分。',
  en: 'Transcribe verbatim. The speaker mixes Traditional Chinese (Taiwan) and English inside one question. Write the Chinese in Traditional characters and keep every English word or sentence in English exactly as spoken. Never translate or omit anything.',
};
const CLIPS = { mixA: 'quick brown fox', mixB: 'metaphor', en1: 'What does this sentence mean', zh1: '偷走懷錶' };

async function run(model, clip, prompt, extra = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(path.join(dir, clip + '.wav'))], { type: 'audio/wav' }), clip + '.wav');
  fd.append('model', model);
  fd.append('response_format', 'json');
  if (prompt) fd.append('prompt', prompt);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const t0 = performance.now();
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
  const j = await r.json();
  return { ok: r.ok, text: r.ok ? j.text : `HTTP ${r.status}: ${j.error?.message?.slice(0, 90)}`, ms: Math.round(performance.now() - t0), raw: j };
}

const rows = [];
for (const model of MODELS) {
  for (const [pname, prompt] of Object.entries(PROMPTS)) {
    for (const [clip, needle] of Object.entries(CLIPS)) {
      const r = await run(model, clip, prompt);
      const keeps = r.ok && r.text.toLowerCase().includes(needle.toLowerCase());
      const trad = r.ok && !/[们这说话么吗为对个时来会样]/.test(r.text);
      rows.push({ model, pname, clip, keeps, trad, ms: r.ms, text: r.text });
      console.log(`${model.padEnd(22)} prompt=${pname.padEnd(4)} ${clip.padEnd(5)} keeps="${needle}":${keeps ? 'Y' : 'n'} trad:${trad ? 'Y' : 'n'} ${String(r.ms).padStart(5)}ms  ${r.text}`);
    }
  }
}

// gpt-transcribe advertises a "languages" hint; try the plausible encodings and show what the API says.
if (MODELS.includes('gpt-transcribe')) {
  console.log('\n--- gpt-transcribe with a languages hint ---');
  for (const [label, extra] of [['languages=zh,en', { languages: 'zh,en' }], ['languages[]=zh & en', null], ['language=zh', { language: 'zh' }]]) {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(path.join(dir, 'mixA.wav'))], { type: 'audio/wav' }), 'mixA.wav');
    fd.append('model', 'gpt-transcribe'); fd.append('response_format', 'json');
    if (extra) for (const [k, v] of Object.entries(extra)) fd.append(k, v); else { fd.append('languages[]', 'zh'); fd.append('languages[]', 'en'); }
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
    const j = await r.json();
    console.log(`${label.padEnd(22)} → HTTP ${r.status} ${r.ok ? JSON.stringify(j).slice(0, 200) : j.error?.message?.slice(0, 120)}`);
  }
}
