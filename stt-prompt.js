// The prompt sent along with a recording to the speech recognizer.
//
// Measured on real mixed-language speech: WITHOUT an instruction, gpt-4o-transcribe silently drops the English
// part of "這句話 <English sentence> 是什麼意思？" and writes the Chinese in Simplified characters. With the
// instruction below it keeps both languages, writes Traditional characters, and does not translate all-English
// questions (that last sentence of the instruction matters). So the instruction is always sent.
//
// Optional book text as extra context is OFF by default: with a Chinese passage in the prompt, gpt-4o-transcribe
// sometimes translates English speech into Chinese or even repeats the passage. It only helps with character
// names, and the answering model already repairs misheard names from the story itself.
//
// Whisper-family models keep only the END of the prompt, so the context goes first and the instruction last.

const INSTRUCTIONS = {
  'zh-TW': '以下是一個人提出的問題，說話者可能全程說中文、全程說英文，或在同一句話裡中英夾雜。請照說話者實際說的語言逐字轉寫：說中文的部分寫成台灣繁體字，說英文的部分一律寫英文原文；絕對不要把英文翻成中文，也不要把中文翻成英文，不要省略任何一段。',
  'zh-CN': '以下是一个人提出的问题，说话者可能全程说中文、全程说英文，或在同一句话里中英夹杂。请按说话者实际说的语言逐字转写：说中文的部分写成简体字，说英文的部分一律写英文原文；绝对不要把英文翻译成中文，也不要把中文翻译成英文，不要省略任何一段。',
  generic: 'Transcribe verbatim, in the language actually spoken. The speaker may talk entirely in one language or mix several inside a single question (for example English with Chinese or Japanese). Write each language in its own script exactly as spoken. NEVER translate between languages and never omit any part.',
};

const isZh = (tag) => /^zh/i.test(tag || '');
const variantOf = (tag) => (/^zh-(cn|sg|hans)/i.test(tag) ? 'zh-CN' : 'zh-TW');

/** Instruction text for the asker's language (falls back to the book's language for the Chinese script). */
export function transcribeInstruction({ uiLang = '', bookLang = '' } = {}) {
  if (isZh(uiLang)) return INSTRUCTIONS[variantOf(uiLang)];
  if (isZh(bookLang)) {
    const script = variantOf(bookLang) === 'zh-CN' ? 'Simplified' : 'Traditional';
    return `${INSTRUCTIONS.generic} Write any Chinese in ${script} characters.`;
  }
  return INSTRUCTIONS.generic;
}

export function buildTranscribePrompt({ uiLang = '', bookLang = '', context = '' } = {}) {
  const instruction = transcribeInstruction({ uiLang, bookLang });
  const ctx = String(context || '').replace(/\s+/g, ' ').trim().slice(-160);
  const label = isZh(uiLang) || (!uiLang && isZh(bookLang)) ? '書中目前位置附近的文字（人名與用語參考）：' : 'Nearby text from the book (names and terms may appear):';
  return { instruction, context: ctx, prompt: ctx ? `${label}${ctx}

${instruction}` : instruction };
}

const norm = (s) => String(s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/** Share of the text's 6-character windows that appear in `source` (both normalised). */
function overlap(t, source) {
  let hit = 0, total = 0;
  for (let i = 0; i + 6 <= t.length; i += 3) { total++; if (source.includes(t.slice(i, i + 6))) hit++; }
  return total ? hit / total : 0;
}

/**
 * Given near-silence, a prompted model may answer with the prompt itself: our instruction, or (worse) the book text
 * we supplied as context. Neither is something the listener said, and forwarding a book sentence to Claude as if it
 * were a question would be nonsense. Output that is (almost entirely) a piece of the instruction or the context is
 * therefore treated as "nothing heard". A real question that merely quotes a few words of the book is not affected.
 */
export function isPromptEcho(text, instruction, context = '') {
  const t = norm(text);
  if (t.length < 6) return false;
  const ins = norm(instruction), ctx = norm(context);
  if (ins.includes(t) || (ctx && ctx.includes(t))) return true;
  return overlap(t, ins) >= 0.6 || (ctx.length > 0 && overlap(t, ctx) >= 0.85);
}
