import test from 'node:test';
import assert from 'node:assert/strict';
import { setupPage, pickSetupLang } from '../setup-page.js';

test('the certificate page follows the phone\'s language preference', () => {
  assert.equal(pickSetupLang(''), 'zh', 'no header → Chinese, the default');
  assert.equal(pickSetupLang('zh-TW,zh;q=0.9,en;q=0.8'), 'zh');
  assert.equal(pickSetupLang('en-US,en;q=0.9'), 'en');
  assert.equal(pickSetupLang('ja-JP,ja;q=0.9,en-US;q=0.6'), 'ja');
  assert.equal(pickSetupLang('fr-FR,fr;q=0.9,ja;q=0.5'), 'ja', 'first supported language by preference');
  assert.equal(pickSetupLang('fr-FR,de;q=0.8'), 'zh', 'nothing supported → default');
  assert.equal(pickSetupLang('en-US', 'ja'), 'ja', '?lang= wins');
  assert.equal(pickSetupLang('en-US', 'xx'), 'en', 'an unknown ?lang= is ignored');
  assert.equal(pickSetupLang('en;q=0.5,ja;q=0.9'), 'ja', 'q-values are respected');
});

test('every language version links to the certificate and to the HTTPS app, and is really translated', () => {
  const url = 'https://192.168.1.10:3000';
  const pages = Object.fromEntries(['zh', 'en', 'ja'].map((lang) => [lang, setupPage({ httpsUrl: url, lang })]));
  for (const [lang, html] of Object.entries(pages)) {
    assert.ok(html.includes('href="/ca.crt"'), `${lang}: download link`);
    assert.ok(html.includes(`href="${url}"`), `${lang}: link to the app`);
    assert.ok(html.includes('Audiobook Companion Local CA'), `${lang}: the certificate's name, which the user must find in the trust list`);
    assert.ok(html.includes('.certs'), `${lang}: where the private key lives`);
  }
  assert.match(pages.zh, /<html lang="zh-Hant">/);
  assert.match(pages.en, /<html lang="en">/);
  assert.match(pages.ja, /<html lang="ja">/);
  assert.ok(!/[一-鿿]/.test(pages.en), 'the English page contains no Chinese');
  assert.ok(/[぀-ヿ]/.test(pages.ja), 'the Japanese page contains kana');
  assert.ok(!/[぀-ヿ]/.test(pages.zh), 'the Chinese page contains no kana');
  assert.equal(setupPage({ httpsUrl: url, lang: 'xx' }), pages.zh, 'an unknown language falls back to Chinese');
});
