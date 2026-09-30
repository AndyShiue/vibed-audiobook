import { buildBookData, Book } from '../public/js/book.js';

const NAMES = ['阿明', '小華', '老王', '林太太', '陳醫師', '艾莉絲', '鮑伯'];
const PLACES = ['港口', '老茶館', '山頂燈塔', '地下書店', '北門市場'];
const THINGS = ['銅鑰匙', '藍色信封', '破舊懷錶', '黑皮筆記本', '玻璃罐'];

/** Deterministic synthetic novel. */
export function makeParsed({ chapters = 12, paras = 6, sentences = 7 } = {}) {
  const out = [];
  let k = 0;
  for (let c = 0; c < chapters; c++) {
    const ps = [];
    for (let p = 0; p < paras; p++) {
      const ss = [];
      for (let s = 0; s < sentences; s++, k++) {
        const n = NAMES[k % NAMES.length], pl = PLACES[(k * 3) % PLACES.length], th = THINGS[(k * 7) % THINGS.length];
        ss.push(`${n}在${pl}發現了${th}，心裡想著第${k}件事情究竟會怎麼發展下去呢。`);
      }
      ps.push(ss.join(''));
    }
    out.push({ title: `第${c + 1}章 測試章節${c + 1}`, paras: ps });
  }
  return { title: '測試小說', author: '某人', language: 'zh-TW', chapters: out };
}

/** Stamp every speech unit with a unique marker so tests can detect any text that leaks past the position. */
export function makeBook(opts) {
  const data = buildBookData(makeParsed(opts));
  data.sents = data.sents.map((s, i) => `${s}Z${i}Z`);
  return new Book({ id: 'test', ...data });
}

export const markersIn = (str) => [...String(str).matchAll(/Z(\d+)Z/g)].map((m) => Number(m[1]));

/** Fake summariser: keeps the markers of the text it saw, so tests can check what each note covers. */
export function fakeSummarizer(log = []) {
  return async (req) => {
    const src = req.kind === 'merge' ? req.parts.join(' ') : req.text;
    const ms = markersIn(src);
    log.push({ kind: req.kind, min: Math.min(...ms), max: Math.max(...ms) });
    return { summary: `S${req.kind[0]}[${ms[0]}..${ms[ms.length - 1]}] ` + ms.map((m) => `Z${m}Z`).join('') };
  };
}

const EN_NAMES = ['Alice', 'Bob Harrington', 'Dr. Chen', 'Mrs. Whitlock', 'the old captain'];
const EN_THINGS = ['brass key', 'sealed letter', 'silver compass', 'torn map', 'cracked lantern'];

/** English counterpart of makeBook (Latin script, space-separated sentences). */
export function makeEnglishBook({ chapters = 20, paras = 6, sentences = 6 } = {}) {
  const out = [];
  let k = 0;
  for (let c = 0; c < chapters; c++) {
    const ps = [];
    for (let p = 0; p < paras; p++) {
      const ss = [];
      for (let s = 0; s < sentences; s++, k++) {
        ss.push(`${EN_NAMES[k % 5]} found the ${EN_THINGS[(k * 3) % 5]} near the harbour, and wondered what event number ${k} would bring next week.`);
      }
      ps.push(ss.join(' '));
    }
    out.push({ title: `Chapter ${c + 1}: The Voyage`, paras: ps });
  }
  const data = buildBookData({ title: 'The Voyage', author: 'A. Writer', language: 'en', chapters: out });
  data.sents = data.sents.map((s, i) => `${s} Z${i}Z`);
  return new Book({ id: 'test-en', ...data });
}
