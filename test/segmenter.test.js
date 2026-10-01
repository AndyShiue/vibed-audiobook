// Sentence cutting. A cut that sounds wrong is a cut in the middle of something — "Dr. | Chen", a quotation parted from its
// "he said", a closing » at the start of the next sentence, a Chinese word split in two — so these tests pin down, language
// by language, where the cuts must NOT be, plus invariants that hold for any text (nothing lost, nothing too long).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSentences, scanSentences, unitsFromParagraph, breakLong, SEG_VERSION } from '../public/js/segmenter.js';
import { gapBetween, joinText } from '../public/js/util.js';
import { buildBookData, resegmentBook, Book } from '../public/js/book.js';
import { parseTxt } from '../public/js/parsers/text.js';
import { SentenceStream } from '../public/js/tts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const split = (text, lang = '') => splitSentences(text, { lang });
const rejoin = (units) => units.reduce((acc, u) => (acc ? joinText(acc, u) : u), '');

// ---------------------------------------------------------------- English
test('English: a quotation keeps its "he said", whatever the length of the quotation', () => {
  assert.deepEqual(split('"Stop!" said Tom. "Why should I?" asked Ann. She laughed.'), ['"Stop!" said Tom.', '"Why should I?" asked Ann.', 'She laughed.']);
  const long = '"I will not go back to that house after everything that was said there tonight, not for you, not for anyone!" he cried. Then the room was silent.';
  assert.deepEqual(split(long), ['"I will not go back to that house after everything that was said there tonight, not for you, not for anyone!" he cried.', 'Then the room was silent.']);
  assert.deepEqual(split('"Really?", she asked. He nodded.'), ['"Really?", she asked.', 'He nodded.']);
  assert.deepEqual(split("'Go!' she said. He went."), ["'Go!' she said.", 'He went.']);
  assert.deepEqual(split('He asked, "Really?" and she nodded. Is it true? yes, it is! and so on.'), ['He asked, "Really?" and she nodded.', 'Is it true? yes, it is! and so on.']);
});

test('English: abbreviations, initials, numbers and URLs are not sentence ends — but real ends still are', () => {
  assert.deepEqual(split('Dr. Chen met Mrs. Whitlock and Prof. Alvarez on Mon. the 3rd. Then they left.'), ['Dr. Chen met Mrs. Whitlock and Prof. Alvarez on Mon. the 3rd.', 'Then they left.']);
  assert.deepEqual(split('J. K. Rowling and J. R. R. Tolkien wrote books. Both sold well.'), ['J. K. Rowling and J. R. R. Tolkien wrote books.', 'Both sold well.']);
  assert.equal(split('We discussed the U.S. Army, e.g. the 2nd Battalion, at 5 p.m. sharp.').length, 1);
  assert.equal(split('Version 2.0.1 cost $3.50. Visit example.com/page?x=1 today.').length, 2);
  assert.deepEqual(split('See No. 5 and Fig. 2 on p. 12. Then stop.'), ['See No. 5 and Fig. 2 on p. 12.', 'Then stop.']);
  assert.deepEqual(split('Did you go? No. He stayed home.'), ['Did you go?', 'No.', 'He stayed home.'], '"No." is a sentence, not an abbreviation, unless a number follows');
  assert.deepEqual(split('He bought pens, books, etc. Then he left.'), ['He bought pens, books, etc.', 'Then he left.'], '"etc." usually ends the sentence');
  assert.equal(split('He bought pens, etc. and paper.').length, 1);
  assert.deepEqual(split('Wait... what? It ended. Then... Silence.'), ['Wait... what?', 'It ended.', 'Then...', 'Silence.']);
});

// ---------------------------------------------------------------- other Latin-script languages
test('German: z. B., d. h., Dr., Nr. and dates written with a dot', () => {
  assert.deepEqual(split('Dr. Müller sagte z. B. nichts, d. h. er schwieg. „Das ist nicht wahr.“ Er ging. „Warum?“, fragte sie.'),
    ['Dr. Müller sagte z. B. nichts, d. h. er schwieg.', '„Das ist nicht wahr.“', 'Er ging.', '„Warum?“, fragte sie.']);
  assert.deepEqual(split('Es war Nr. 3 auf der Liste, ca. 10 Minuten später. Ende.'), ['Es war Nr. 3 auf der Liste, ca. 10 Minuten später.', 'Ende.']);
  assert.deepEqual(split('Am 3. Mai fuhren wir ab. Es war schön.', 'de-DE'), ['Am 3. Mai fuhren wir ab.', 'Es war schön.'], 'ordinals with a dot, when the book is German');
  assert.deepEqual(split('Den 5. januar kom han. Det var koldt.', 'da'), ['Den 5. januar kom han.', 'Det var koldt.']);
  assert.deepEqual(split('He was born in 1990. Then he moved.', 'en-US'), ['He was born in 1990.', 'Then he moved.'], 'in English a number before a period is just a number');
});

test('French: guillemets with spaces keep their closing » and the "dit-il"', () => {
  assert.deepEqual(split('« Bonjour, madame. » dit-il. « Comment allez-vous ? » demanda-t-elle. Puis ils partirent.'),
    ['« Bonjour, madame. » dit-il.', '« Comment allez-vous ? » demanda-t-elle.', 'Puis ils partirent.']);
  assert.deepEqual(split('M. Dupont salua Mme Martin. Elle sourit.'), ['M. Dupont salua Mme Martin.', 'Elle sourit.']);
  assert.deepEqual(split('« Non ! » cria-t-il. « Jamais. » Il sortit.'), ['« Non ! » cria-t-il.', '« Jamais. »', 'Il sortit.']);
});

test('German »Hallo!« and „Hallo!“ quotation styles, and Italian «…»', () => {
  assert.deepEqual(split('»Komm her!« rief er. Sie kam. „Warum?“ fragte sie. Niemand antwortete.'), ['»Komm her!« rief er.', 'Sie kam.', '„Warum?“ fragte sie.', 'Niemand antwortete.']);
  assert.deepEqual(split('«Che bello!» disse lei. Il sig. Rossi sorrise.'), ['«Che bello!» disse lei.', 'Il sig. Rossi sorrise.']);
});

test('Spanish and Portuguese: dialogue dashes and inverted marks', () => {
  assert.deepEqual(split('—¿Quién eres? —preguntó él. —Soy yo, Sr. García. ¡Qué sorpresa! Llegó a las 5 p. m. y se fue.'),
    ['—¿Quién eres? —preguntó él.', '—Soy yo, Sr. García.', '¡Qué sorpresa!', 'Llegó a las 5 p. m. y se fue.']);
  assert.deepEqual(split('— Olá — disse ele. — Tudo bem? — perguntou ela. O Sr. Silva saiu.'), ['— Olá — disse ele.', '— Tudo bem? — perguntou ela.', 'O Sr. Silva saiu.']);
});

test('Polish, Czech, Turkish, Vietnamese, Dutch', () => {
  assert.deepEqual(split('Prof. Kowalski przyjechał o 5, tj. wcześniej. Dr Nowak został.'), ['Prof. Kowalski przyjechał o 5, tj. wcześniej.', 'Dr Nowak został.']);
  assert.deepEqual(split('Ing. Novák přišel, tzn. včas. Pak odešel.'), ['Ing. Novák přišel, tzn. včas.', 'Pak odešel.']);
  assert.deepEqual(split('Dr. Yılmaz geldi. Atatürk Cad. 5 numarada oturuyor.'), ['Dr. Yılmaz geldi.', 'Atatürk Cad. 5 numarada oturuyor.']);
  assert.deepEqual(split('PGS. TS. Nguyễn Văn A sống ở TP. Hồ Chí Minh. Ông ấy rất vui.'), ['PGS. TS. Nguyễn Văn A sống ở TP. Hồ Chí Minh.', 'Ông ấy rất vui.']);
  assert.deepEqual(split('Dhr. Jansen en mevr. de Vries kwamen, o.a. om vijf uur. Daarna gingen ze.'), ['Dhr. Jansen en mevr. de Vries kwamen, o.a. om vijf uur.', 'Daarna gingen ze.']);
});

// ---------------------------------------------------------------- Cyrillic, Greek
test('Russian: initials, abbreviations and dialogue dashes', () => {
  assert.deepEqual(split('А. С. Пушкин родился в 1799 г. — Привет, — сказал он. — Как дела? — спросил Иван. Т. е. всё хорошо.'),
    ['А. С. Пушкин родился в 1799 г.', '— Привет, — сказал он.', '— Как дела? — спросил Иван.', 'Т. е. всё хорошо.']);
  assert.deepEqual(split('Они жили на ул. Ленина, д. 5. Потом уехали.'), ['Они жили на ул. Ленина, д. 5.', 'Потом уехали.']);
});

test('Greek: the question mark that looks like a semicolon, and abbreviations', () => {
  assert.deepEqual(split('Ο κ. Παπαδόπουλος ήρθε στις 5 μ.μ. «Τι κάνεις;» ρώτησε. Η Μαρία απάντησε: «Καλά.» Έφυγαν.'),
    ['Ο κ. Παπαδόπουλος ήρθε στις 5 μ.μ. «Τι κάνεις;» ρώτησε.', 'Η Μαρία απάντησε: «Καλά.»', 'Έφυγαν.']);
  assert.deepEqual(split('Τι κάνεις; Καλά. Και εσύ; Μια χαρά!'), ['Τι κάνεις;', 'Καλά.', 'Και εσύ;', 'Μια χαρά!']);
  assert.equal(split('Λέγεται ότι ήρθε; και έφυγε.').length, 1, 'a semicolon before a lower-case word is not a question mark');
});

// ---------------------------------------------------------------- scripts with their own full stops
test('Arabic, Persian, Urdu, Hebrew', () => {
  assert.deepEqual(split('قال المعلم: «من أنت؟» فأجاب الولد بهدوء. هل تعرف الطريق؟ نعم، أعرفه جيدا! ثم ذهبا معا.'),
    ['قال المعلم: «من أنت؟»', 'فأجاب الولد بهدوء.', 'هل تعرف الطريق؟', 'نعم، أعرفه جيدا!', 'ثم ذهبا معا.']);
  assert.deepEqual(split('اس نے آہستہ سے جواب دیا۔ لڑکا بازار گیا۔ کیا تم راستہ جانتے ہو؟'), ['اس نے آہستہ سے جواب دیا۔', 'لڑکا بازار گیا۔', 'کیا تم راستہ جانتے ہو؟']);
  assert.deepEqual(split('הוא שאל: "מי אתה?" והיא ענתה בשקט. האם אתה יודע את הדרך? כן, אני יודע!'), ['הוא שאל: "מי אתה?"', 'והיא ענתה בשקט.', 'האם אתה יודע את הדרך?', 'כן, אני יודע!']);
});

test('Hindi, Bengali, Armenian, Ethiopic, Khmer, Burmese: the danda and the other full stops', () => {
  assert.equal(split('उसने धीरे से जवाब दिया। लड़का बाज़ार गया। फिर वे दोनों घर लौट आए। उन्होंने खाना खाया।').length, 4);
  assert.equal(split('उसने पूछा, "तुम कौन हो?" लड़के ने जवाब दिया। क्या तुम जानते हो? हाँ, मैं जानता हूँ!').length, 4);
  assert.equal(split('আমি ভালো আছি। সে বাজারে গেল। তারা বাড়ি ফিরে এল।').length, 3);
  assert.equal(split('Նա դանդաղ պատասխանեց։ Տղան գնաց շուկա։ Նրանք տուն վերադարձան։').length, 3);
  assert.equal(split('እሱ በዝግታ መለሰ። ልጁ ወደ ገበያ ሄደ። ወደ ቤት ተመለሱ።').length, 3);
  assert.equal(split('គាត់បានឆ្លើយយឺតៗ។ ក្មេងប្រុសបានទៅផ្សារ។ ពួកគេត្រឡប់ទៅផ្ទះវិញ។').length, 3);
  assert.equal(split('သူ ဖြည်းဖြည်းချင်း ဖြေလိုက်သည်။ ကောင်လေး ဈေးသွားသည်။ သူတို့ အိမ်ပြန်လာကြသည်။').length, 3);
  assert.equal(split('သူ၊ ကောင်လေး၊ ဈေးသွားသည်။').length, 1, 'the Burmese comma-like mark is not a full stop');
});

test('a Hindi sentence is not cut because an English word follows the danda', () => {
  assert.deepEqual(split('फिर वे दोनों घर गए। iPhone खरीदा गया।'), ['फिर वे दोनों घर गए।', 'iPhone खरीदा गया।']);
});

// ---------------------------------------------------------------- Chinese, Japanese, Korean
test('Chinese: quotations, ellipsis and the tag after a quotation', () => {
  assert.deepEqual(split('他說：「你好。」然後走了。真的嗎？是的！'), ['他說：「你好。」', '然後走了。', '真的嗎？', '是的！']);
  assert.deepEqual(split('他想了想……然後點頭。'), ['他想了想……', '然後點頭。']);
  assert.deepEqual(split('“你好。”他说。“真的吗？”她问。'), ['“你好。”', '他说。', '“真的吗？”', '她问。']);
  // the tag stays with its quotation when the sentences are put into units
  const quote = `「${'這是一句相當長的話，'.repeat(4)}你聽懂了嗎？」`;
  const units = unitsFromParagraph(`${quote}她問道。老周沒有回答，只是低下頭，看著手裡那只銅製的懷錶。`);
  assert.ok(units[0].endsWith('她問道。'), `the unit should end with the tag: ${JSON.stringify(units)}`);
});

test('Japanese: 「…」と言った stays together; a quote followed by a tag is one unit', () => {
  const units = unitsFromParagraph('老人はゆっくりと桟橋を歩いていった。「どこへ行くの？」と彼女は尋ねた。彼は答えなかった。「ああ、そうか。」と彼は言った。');
  assert.ok(units.some((u) => u.includes('「どこへ行くの？」と彼女は尋ねた。')), JSON.stringify(units));
  assert.ok(units.every((u) => !/^と/.test(u)), 'no unit may begin with the particle of a quotation tag');
});

test('Korean keeps its spaces between sentences (units and the text built from them)', () => {
  const units = unitsFromParagraph('노인은 천천히 걸어갔다. "어디 가세요?" 그녀가 물었다. 그는 대답하지 않았다. 박 씨는 오후 5시에 도착했다. 그리고 모두 떠났다.');
  assert.ok(units.length >= 2);
  assert.ok(units.every((u) => !/[?.]["”']?[가-힣]/.test(u)), `no sentence may be glued to the next: ${JSON.stringify(units)}`);
  assert.equal(gapBetween('안녕하세요.', '반갑습니다.'), ' ');
  assert.equal(gapBetween('你好。', '再見。'), '');
  assert.equal(gapBetween('こんにちは。', 'Hello'), '');
  assert.equal(gapBetween('Hello.', 'World'), ' ');
  assert.equal(gapBetween('Hello 👍', 'World'), ' ', 'an emoji is not a script written without spaces');
  const book = new Book({ id: 'k', ...buildBookData({ title: '소설', language: 'ko', chapters: [{ title: '1장', paras: ['노인은 천천히 걸어갔다. 그는 대답하지 않았다. 박 씨는 오후에 도착했다. 그리고 모두 떠났다. 아무도 말하지 않았다. 바람만 불었다.'] }] }) });
  assert.ok(!/[가-힣][.?!][가-힣]/.test(book.text(0, book.length)), `Book.text keeps the spaces: ${book.text(0, book.length)}`);
});

// ---------------------------------------------------------------- cutting a sentence that has to be cut
test('a long sentence without punctuation is cut into even pieces, between words', () => {
  const s = 'The old captain walked slowly down the long wooden pier toward the small grey boat that had been waiting for him since before the first light of dawn touched the harbour and he did not look back even once because he knew that looking back would make leaving much harder than it already was for a man of his age';
  const parts = breakLong(s, 220);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 220 && p.length >= 100), `uneven: ${parts.map((p) => p.length)}`);
  assert.equal(parts.join(' '), s);
  const lens = breakLong('word '.repeat(300).trim(), 220).map((p) => p.length);
  assert.ok(Math.max(...lens) - Math.min(...lens) < 60, `pieces should be about equally long: ${lens}`);
});

test('cuts prefer a comma or semicolon over a plain word boundary, and never leave an opening quote behind', () => {
  const s = 'He walked down the long road toward the town, which was farther than he had thought; and when he arrived, tired and hungry, he knocked at the door of the first house and said, "Please, may I come in and rest for a while?"';
  const parts = breakLong(s, 120);
  assert.ok(parts.length >= 2);
  for (const p of parts.slice(0, -1)) assert.match(p, /[,;]$/, `a piece should end at a clause: ${p}`);
  for (const p of parts) assert.ok(!/(^|\s)["“«(\[]$/.test(p) && !/[“«(\[]$/.test(p) && !/^[,.;:!?)”»]/.test(p), `bad edge in: ${p}`);
});

test('Chinese or Japanese text with no punctuation is cut only at word boundaries (the browser\'s word dictionary)', () => {
  const zh = '那一年的冬天特別寒冷河面結了厚厚的冰住在村子東邊的老人每天清晨都會拄著拐杖走到河邊看著那些孩子在冰上追逐嬉戲一直到太陽完全升起才慢慢走回家中點燃爐火煮一壺熱茶然後坐在窗邊看著遠處的山慢慢被雪覆蓋直到夜色降臨才輕輕地嘆了一口氣吹熄了燈';
  const ja = '老人はゆっくりと桟橋を歩いていってから小さな灰色の船に乗り込み夜明けの光が港を照らす前からずっと待っていた船頭に静かに挨拶をして一度も振り返らずに沖へと向かって行った'.repeat(2);
  for (const [text, locale] of [[zh, 'zh'], [ja, 'ja']]) {
    const units = unitsFromParagraph(text);
    assert.ok(units.length > 1 && units.every((u) => u.length <= 110), `${units.map((u) => u.length)}`);
    assert.equal(units.join(''), text);
    const words = new Set();
    for (const seg of new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)) words.add(seg.index);
    let at = 0;
    for (const u of units.slice(0, -1)) { at += u.length; assert.ok(words.has(at), `cut at ${at} splits a word: …${text.slice(at - 4, at)}|${text.slice(at, at + 4)}…`); }
  }
});

test('Thai: cuts fall on the spaces between clauses, or on word boundaries when there are none', () => {
  const spaced = 'ชายชราเดินไปที่ท่าเรืออย่างช้า ๆ แล้วมองดูเรือลำเล็กที่รออยู่ เขาไม่หันกลับไปมองอีกเลย เพราะรู้ดีว่าการมองกลับจะทำให้การจากไปยากขึ้น '.repeat(3).trim();
  const units = unitsFromParagraph(spaced);
  assert.ok(units.length > 1 && units.every((u) => u.length <= 220));
  assert.equal(units.join(' '), spaced, 'only spaces were cut');
  const solid = 'ชายชราเดินไปที่ท่าเรืออย่างช้าๆแล้วมองดูเรือลำเล็กที่รออยู่เขาไม่หันกลับไปมองอีกเลยเพราะรู้ดีว่าการมองกลับจะทำให้การจากไปยากขึ้น'.repeat(4);
  const cut = unitsFromParagraph(solid);
  assert.ok(cut.length > 1);
  assert.equal(cut.join(''), solid);
  const words = new Set([...new Intl.Segmenter('th', { granularity: 'word' }).segment(solid)].map((x) => x.index));
  let at = 0;
  for (const u of cut.slice(0, -1)) { at += u.length; assert.ok(words.has(at), `cut at ${at} splits a Thai word`); }
});

test('a hard cut never lands inside a surrogate pair or before a combining mark', () => {
  const s = ('𠀀𠀁𠀂'.repeat(60));
  const parts = breakLong(s, 50);
  assert.equal(parts.join(''), s);
  assert.ok(parts.every((p) => !/^[\udc00-\udfff]/.test(p) && !/[\ud800-\udbff]$/.test(p)));
  const combining = 'é'.repeat(120);
  assert.ok(breakLong(combining, 40).every((p) => !/^́/.test(p)));
});

// ---------------------------------------------------------------- units
test('units: short sentences are merged, a stray tail is joined to the unit before it, nothing exceeds the cap', () => {
  assert.equal(unitsFromParagraph('好。是的。走吧。').length, 1);
  const longEn = `${'The quick brown fox jumps over the lazy dog near the river bank. '.repeat(3)}He left.`;
  const units = unitsFromParagraph(longEn);
  assert.ok(units.every((u) => u.length <= 220));
  assert.ok(!units.some((u) => u === 'He left.'), `a two-word tail should not be a unit of its own: ${JSON.stringify(units)}`);
  const raw = '很長的句子，'.repeat(60) + '結束了。';
  const long = unitsFromParagraph(raw);
  assert.ok(long.length > 1 && long.every((u) => u.length <= 110));
  assert.equal(long.join(''), raw);
});

// ---------------------------------------------------------------- invariants over real text
async function fixtureParagraphs() {
  const out = [];
  for (const name of ['novel-zh.txt', 'novel-en.txt']) {
    const parsed = await parseTxt(fs.readFileSync(path.join(ROOT, 'fixtures', name)), { name });
    for (const ch of parsed.chapters) out.push(...ch.paras);
  }
  return out;
}

const CORPUS = [
  '"Stop right there!" he cried, raising the lantern high. "Why?" she asked. "Because," he said slowly, "the door was open." Nobody moved.',
  'Dr. Müller sagte z. B. nichts, d. h. er schwieg. „Das ist nicht wahr.“ Er ging. Am 3. Mai fuhren wir ab.',
  '« Bonjour, madame. » dit-il. « Comment allez-vous ? » M. Dupont est arrivé. Mme Martin l’a salué ; puis ils sont partis.',
  '—¿Quién eres? —preguntó él. —Soy yo, Sr. García. ¡Qué sorpresa! Llegó a las 5 p. m. y se fue.',
  'А. С. Пушкин родился в 1799 г. — Привет, — сказал он. — Как дела? — спросил Иван. Т. е. всё хорошо.',
  'قال المعلم: «من أنت؟» فأجاب الولد بهدوء. هل تعرف الطريق؟ نعم، أعرفه جيدا! ثم ذهبا معا.',
  'उसने धीरे से जवाब दिया। लड़का बाज़ार गया। फिर वे दोनों घर लौट आए। उन्होंने खाना खाया।',
  '老人はゆっくりと桟橋を歩いていった。「どこへ行くの？」と彼女は尋ねた。彼は答えなかった。「ああ、そうか。」と彼は言った。',
  '他說：「你好。」然後走了。「真的嗎？」她問。「不知道。你呢？」他搖搖頭。老周提著燈走向鐘樓。',
  '노인은 천천히 걸어갔다. "어디 가세요?" 그녀가 물었다. 그는 대답하지 않았다.',
  'ชายชราเดินไปที่ท่าเรืออย่างช้า ๆ แล้วมองดูเรือลำเล็กที่รออยู่ เขาไม่หันกลับไปมองอีกเลย',
  'Ο κ. Παπαδόπουλος ήρθε στις 5 μ.μ. «Τι κάνεις;» ρώτησε. Η Μαρία απάντησε: «Καλά.»',
];

test('invariants for any text: nothing is lost or invented, nothing is too long, no unit starts with a closing mark', async () => {
  const paragraphs = [...CORPUS, ...(await fixtureParagraphs())];
  for (const par of paragraphs) {
    const units = unitsFromParagraph(par);
    assert.ok(units.length > 0 && units.every((u) => u.length > 0 && u === u.trim()), par.slice(0, 40));
    const dense = /[぀-ヿ㐀-鿿가-힯]/.test(par) && (par.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length / par.length > 0.3;
    for (const u of units) assert.ok(u.length <= (dense ? 110 : 220), `too long (${u.length}): ${u.slice(0, 50)}`);
    for (const u of units) assert.ok(!/^[」』)\]】》»›”’、。，！？!?.,:;]/.test(u), `a unit starts with a closing mark: ${u.slice(0, 30)}`);
    assert.equal(rejoin(units).replace(/\s+/g, ''), par.replace(/\s+/g, ''), 'the units must add up to the paragraph');
  }
});

test('cutting is stable: cutting the units of a paragraph again gives the same units (so re-cutting a book never drifts)', async () => {
  for (const par of [...CORPUS, ...(await fixtureParagraphs())]) {
    const units = unitsFromParagraph(par);
    assert.deepEqual(unitsFromParagraph(rejoin(units)), units, par.slice(0, 40));
  }
});

test('speed: a million characters are cut in a couple of seconds at most', () => {
  const text = `${CORPUS.join(' ')} `.repeat(Math.ceil(1_000_000 / CORPUS.join(' ').length));
  const t0 = performance.now();
  let n = 0;
  for (const par of text.match(/[\s\S]{1,600}/g)) n += unitsFromParagraph(par).length;
  const ms = performance.now() - t0;
  assert.ok(n > 1000);
  assert.ok(ms < 4000, `took ${Math.round(ms)} ms`);
});

// ---------------------------------------------------------------- books cut with older rules
test('re-cutting a stored book keeps paragraphs, chapters and the listener\'s place', () => {
  const chapters = [
    { title: '第1章', paras: ['他說：「你好。」然後走了。「真的嗎？」她問。老周提著燈走向鐘樓，那只銅製懷錶就藏在鐘樓頂端的暗格裡。', '第二段很短。'] },
    { title: 'Chapter 2', paras: ['"Stop!" said Tom. "Why should I?" asked Ann. She laughed. Dr. Chen arrived at five and everyone else had already gone home by then.', 'A short one.'] },
  ];
  const fresh = buildBookData({ title: 't', language: 'zh-TW', chapters });
  // simulate a book cut by older rules: every unit split in two
  const oldSents = [], oldStart = [];
  fresh.paraStart.forEach((s, k) => {
    oldStart.push(oldSents.length);
    for (let u = s; u < (fresh.paraStart[k + 1] ?? fresh.sents.length); u++) {
      const t = fresh.sents[u];
      let mid = Math.floor(t.length / 2);
      if (/ /.test(t)) { const sp = [...t].map((c, i) => (c === ' ' ? i : -1)).filter((i) => i > 0); mid = sp.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0]; }
      oldSents.push(t.slice(0, mid).trim(), t.slice(mid).trim());
    }
  });
  const oldChapters = fresh.chapters.map((c) => ({ title: c.title, start: oldStart[fresh.paraStart.indexOf(c.start)] }));
  const rec = { id: 'x', lang: 'zh-TW', sents: oldSents, paraStart: oldStart, chapters: oldChapters, seg: 1 };
  const { data, mapIndex } = resegmentBook(rec);
  assert.equal(data.seg, SEG_VERSION);
  assert.equal(data.paraStart.length, fresh.paraStart.length, 'same paragraphs');
  assert.deepEqual(data.chapters.map((c) => c.title), ['第1章', 'Chapter 2']);
  assert.deepEqual(data.chapters.map((c) => data.paraStart.includes(c.start)), [true, true], 'chapters start at paragraph starts');
  const rebuilt = new Book({ id: 'y', title: 't', lang: 'zh-TW', ...data });
  const original = new Book({ id: 'z', title: 't', lang: 'zh-TW', ...fresh });
  assert.equal(rebuilt.text(0, rebuilt.length).replace(/\s+/g, ''), original.text(0, original.length).replace(/\s+/g, ''), 'no text lost');
  assert.deepEqual(data.sents, fresh.sents, 'cutting the paragraphs again gives exactly what a fresh import gives');

  // positions: first, last, monotonic, and inside the same paragraph
  assert.equal(mapIndex(0), 0);
  let prev = -1;
  for (let i = 0; i < oldSents.length; i++) {
    const j = mapIndex(i);
    assert.ok(j >= prev, `monotonic at ${i}`);
    assert.equal(rebuilt.paraIndexOf(j), (() => { let k = 0; while (oldStart[k + 1] !== undefined && oldStart[k + 1] <= i) k++; return k; })(), `unit ${i} stays in its paragraph`);
    prev = j;
  }
  assert.equal(rebuilt.chapterIndexOf(mapIndex(oldSents.length - 1)), 1);
  assert.equal(mapIndex(-5), 0);
  assert.ok(mapIndex(10_000) <= data.sents.length - 1);
});

// ---------------------------------------------------------------- streamed answers
function stream(text, chunk = 1, lang = '') {
  const s = new SentenceStream(lang);
  const out = [];
  for (let i = 0; i < text.length; i += chunk) out.push(...s.push(text.slice(i, i + chunk)));
  out.push(...s.end());
  return out;
}

test('streamed answers: a sentence is released only once the next character shows that it ended', () => {
  const s = new SentenceStream();
  assert.deepEqual(s.push('Hello there.'), []);
  assert.deepEqual(s.push(' '), []);
  assert.deepEqual(s.push('W'), ['Hello there.']);
  assert.deepEqual(s.end(), ['W']);
  const z = new SentenceStream();
  assert.deepEqual(z.push('好的。'), [], 'waits for a possible closing quote');
  assert.deepEqual(z.push('接著'), ['好的。']);
});

test('streamed answers use the book\'s sentence rules, in any chunking', () => {
  const cases = [
    ['Dr. Chen met Mrs. Whitlock. Then they left. Was it fun? Yes!', ['Dr. Chen met Mrs. Whitlock.', 'Then they left.', 'Was it fun?', 'Yes!']],
    ['« Bonjour. » dit-il. Puis il partit.', ['« Bonjour. » dit-il.', 'Puis il partit.']],
    ['هل تعرف الطريق؟ نعم أعرفه! ثم ذهبا.', ['هل تعرف الطريق؟', 'نعم أعرفه!', 'ثم ذهبا.']],
    ['उसने जवाब दिया। लड़का बाज़ार गया। फिर घर लौटा।', ['उसने जवाब दिया।', 'लड़का बाज़ार गया।', 'फिर घर लौटा।']],
    ['Хорошо. А. С. Пушкин родился в Москве.', ['Хорошо.', 'А. С. Пушкин родился в Москве.']],
  ];
  for (const [text, expected] of cases) for (const chunk of [1, 2, 3, 7, 1000]) assert.deepEqual(stream(text, chunk), expected, `${text} (chunks of ${chunk})`);
});

test('streamed answers: lines become sentences, and markdown never reaches the speech engine', () => {
  const out = stream('**重點**：\n- 第一\n- 第二。\n\n1. 結尾', 3).join(' ');
  assert.ok(!/[*#]/.test(out) && !/(^|\s)[-]\s/.test(out), out);
});

test('scanSentences: unfinished text is handed back while streaming, and consumed at the end', () => {
  assert.deepEqual(scanSentences('One. Two. Thr', { final: false }), { sentences: ['One.', 'Two.'], rest: 'Thr' });
  assert.deepEqual(scanSentences('One. Two.', { final: false }), { sentences: ['One.'], rest: 'Two.' }, 'the last full stop is not final until something follows it');
  assert.deepEqual(scanSentences('One. Two. Thr', { final: true }), { sentences: ['One.', 'Two.', 'Thr'], rest: '' });
  assert.deepEqual(scanSentences('', { final: true }), { sentences: [], rest: '' });
});
