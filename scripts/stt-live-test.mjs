// Live check of cloud speech recognition against the running server (uses the key configured in .env).
//   node scripts/stt-live-test.mjs <folder-with-wav-files> [http://localhost:3001]
// Expects clips zh1.wav, mixA.wav, mixB.wav, en1.wav and names.wav (spoken with Windows voices, see the README).
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const base = process.argv[3] || 'http://localhost:3001';
if (!dir) { console.error('usage: node scripts/stt-live-test.mjs <wav-folder> [server-url]'); process.exit(2); }

async function transcribe(file, { language = '', uiLang = 'zh-TW', context = '' } = {}) {
  const buf = Buffer.isBuffer(file) ? file : fs.readFileSync(path.join(dir, file));
  const t0 = performance.now();
  const r = await fetch(`${base}/api/transcribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: buf.toString('base64'), mime: 'audio/wav', language, uiLang, bookLang: 'zh-TW', context }),
  });
  const j = await r.json();
  return { status: r.status, text: j.text ?? j.error, ms: Math.round(performance.now() - t0) };
}

const cfg = await (await fetch(`${base}/api/config`)).json();
console.log('server stt:', JSON.stringify(cfg.stt));
if (!cfg.stt?.available) { console.error('cloud recognition is not configured on the server'); process.exit(1); }

const norm = (s) => s.toLowerCase().replace(/[\s，。？！,.?!、「」'"“”:：;；]/g, '');
const simplified = /[们这说话么吗为对个时来会样该问觉]/;
const checks = [];
const check = (name, ok, got) => { checks.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        → ${got}`); };

const zh = await transcribe('zh1.wav');
console.log(`\n中文 (${zh.ms} ms)`);
check('Chinese only, Traditional characters', norm(zh.text).includes('偷走懷錶') && norm(zh.text).includes('兇手') && !simplified.test(zh.text), zh.text);

const a = await transcribe('mixA.wav');
console.log(`\n中英夾雜 A：中文 + 一整句英文 + 中文 (${a.ms} ms)`);
check('keeps the whole English sentence, Traditional Chinese around it', norm(a.text).includes('thequickbrownfox') && norm(a.text).includes('lazydog') && norm(a.text).includes('意思') && !simplified.test(a.text), a.text);

const b = await transcribe('mixB.wav');
console.log(`\n中英夾雜 B：中文句子裡一個英文單字 (${b.ms} ms)`);
check('keeps the single English word', norm(b.text).includes('metaphor') && norm(b.text).includes('故事') && !simplified.test(b.text), b.text);

// The app always sends the asker's phone language (zh-TW here), even when the question is entirely in English.
const en = await transcribe('en1.wav', { uiLang: 'zh-TW' });
console.log(`
English-only question from a Chinese-language phone (${en.ms} ms)`);
check('stays English (not translated into Chinese)', norm(en.text).includes('whatdoesthissentencemean'), en.text);

const enPhone = await transcribe('en1.wav', { uiLang: 'en-US' });
check('English-language phone: English', norm(enPhone.text).includes('whatdoesthissentencemean'), enPhone.text);

// Character names: the recognizer may mishear them; Claude repairs them from the story when it answers.
const bare = await transcribe('names.wav');
console.log(`
人名 (${bare.ms} ms) — informational, the answering model repairs misheard names`);
console.log('        default (no book text) → ' + bare.text);

// Optional book-text context (off by default): report what it does, without failing the run.
const ctx = '林曉晴推開老茶館的木門，聞到一股熟悉的桂花香。她的祖父上個月過世了，只留下一只銅製懷錶。陳志遠壓低聲音問她：「你確定昨晚最後離開的人是老周嗎？」';
const withCtxNames = await transcribe('names.wav', { context: ctx });
const withCtxEn = await transcribe('en1.wav', { uiLang: 'zh-TW', context: ctx });
console.log('        with book text         → ' + withCtxNames.text);
console.log('        English + book text    → ' + withCtxEn.text + (norm(withCtxEn.text).includes('whatdoesthissentencemean') ? '' : '   ← derailed: this is why the option is off by default'));

// A valid 16 kHz mono WAV of pure silence and of faint room noise: the recognizer must not invent a "question".
const wav = (samples) => {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => b.writeInt16LE(v, 44 + i * 2));
  return b;
};
for (const [label, buf] of [['純靜音', wav(new Array(48000).fill(0))], ['微弱底噪', wav(Array.from({ length: 48000 }, () => Math.round((Math.random() - 0.5) * 300)))]]) {
  const x = await transcribe(buf, { context: '林曉晴推開老茶館的木門。' });
  console.log(`\n${label} (HTTP ${x.status}, ${x.ms} ms)`);
  check(`${label}: no fake question and no echo of the instruction`, x.status === 200 && x.text.length < 12 && !/逐字|轉寫|Transcribe/.test(x.text), JSON.stringify(x.text));
}

console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
