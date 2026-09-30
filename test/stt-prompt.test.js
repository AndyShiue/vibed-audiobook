import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscribePrompt, transcribeInstruction, isPromptEcho } from '../stt-prompt.js';

const CONTEXT = '林曉晴推開老茶館的木門，聞到一股熟悉的桂花香。她的祖父上個月過世了。';

test('the instruction follows the asker: Traditional, Simplified, or generic with the book\'s script', () => {
  assert.match(transcribeInstruction({ uiLang: 'zh-TW' }), /繁體/);
  assert.match(transcribeInstruction({ uiLang: 'zh-TW' }), /全程說英文/, 'all-English questions must be covered explicitly (they got translated otherwise)');
  assert.match(transcribeInstruction({ uiLang: 'zh-Hant' }), /繁體/);
  assert.match(transcribeInstruction({ uiLang: 'zh-CN' }), /简体/);
  assert.match(transcribeInstruction({ uiLang: 'en-US' }), /Transcribe verbatim/);
  assert.doesNotMatch(transcribeInstruction({ uiLang: 'en-US' }), /Traditional|Simplified/);
  assert.match(transcribeInstruction({ uiLang: 'en-US', bookLang: 'zh-TW' }), /Traditional characters/);
  assert.match(transcribeInstruction({ uiLang: 'en-US', bookLang: 'zh-CN' }), /Simplified characters/);
  for (const lang of ['zh-TW', 'zh-CN', 'en-US', 'ja-JP', '']) {
    assert.match(transcribeInstruction({ uiLang: lang }), /translate|翻成|翻译成|翻譯/i, 'must forbid translating');
    assert.match(transcribeInstruction({ uiLang: lang }), /omit|省略/i, 'must forbid dropping the second language');
  }
});

test('the instruction is always present; book context is optional, clipped, and placed BEFORE it (Whisper keeps the prompt tail)', () => {
  const bare = buildTranscribePrompt({ uiLang: 'zh-TW' });
  assert.equal(bare.prompt, bare.instruction);
  const withCtx = buildTranscribePrompt({ uiLang: 'zh-TW', context: CONTEXT });
  assert.ok(withCtx.prompt.endsWith(withCtx.instruction));
  assert.ok(withCtx.prompt.indexOf(CONTEXT.slice(0, 10)) < withCtx.prompt.indexOf(withCtx.instruction));
  const long = buildTranscribePrompt({ uiLang: 'zh-TW', context: '字'.repeat(1000) });
  assert.ok(long.context.length <= 160);
  assert.ok(long.prompt.length < 400, 'stays well inside the 224-token limit of Whisper-style prompts');
});

test('echo guard: the instruction or the supplied book text coming back is "nothing heard"', () => {
  const { instruction, context } = buildTranscribePrompt({ uiLang: 'zh-TW', context: CONTEXT });
  assert.equal(isPromptEcho(instruction, instruction, context), true);
  assert.equal(isPromptEcho(instruction.slice(10, 40), instruction, context), true, 'a fragment of the instruction');
  assert.equal(isPromptEcho('請照說話者實際說的語言逐字轉寫', instruction, context), true);
  assert.equal(isPromptEcho('林曉晴推開老茶館的木門。', instruction, context), true);
  assert.equal(isPromptEcho('聞到一股熟悉的桂花香。她的祖父上個月過世了', instruction, context), true);
});

test('echo guard: real questions are never dropped, even when they quote the book', () => {
  const { instruction, context } = buildTranscribePrompt({ uiLang: 'zh-TW', context: CONTEXT });
  for (const q of [
    '偷走懷錶的兇手是誰？',
    '這句話"The quick brown fox jumps over the lazy dog"是什麼意思？',
    '林曉晴為什麼要去老茶館？',
    '她的祖父是怎麼過世的？',
    '「聞到一股熟悉的桂花香」是什麼意思？',
    '好',
    '繼續',
  ]) assert.equal(isPromptEcho(q, instruction, context), false, q);
  assert.equal(isPromptEcho('What does this mean?', transcribeInstruction({ uiLang: 'en-US' }), ''), false);
});
