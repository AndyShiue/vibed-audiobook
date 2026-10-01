// The plain-HTTP page that hands out the personal certificate authority (see lan-cert.js).
// A phone opens it before it has ever seen the app, so the language comes from the browser's Accept-Language header
// (or ?lang=), not from the app's settings.
import { detectLang, FALLBACK_LANG } from './public/js/i18n.js';

const PAGES = {
  zh: {
    html: 'zh-Hant', title: '安裝憑證 · 有聲書夥伴', h1: '讓手機信任這台有聲書伺服器',
    intro: '手機的麥克風只能在「安全連線 (HTTPS)」下使用。第一次使用請在手機上安裝一次憑證，之後電腦的 IP 變了也不用重裝。',
    download: '① 下載憑證', ios: 'iPhone / iPad（用 Safari）', android: 'Android（Chrome）',
    iosSteps: ['按上面的「下載憑證」，選擇「允許」下載描述檔。', '打開「設定」，最上方會出現「已下載描述檔」，點進去按「安裝」。', '到「設定 → 一般 → 關於本機 → 憑證信任設定」，把「Audiobook Companion Local CA」打開。'],
    androidSteps: ['按上面的「下載憑證」，儲存檔案 <code>ca.crt</code>。', '「設定」搜尋「CA 憑證」（通常在 安全性 → 加密與憑證 → 安裝憑證 → CA 憑證），選「仍要安裝」，再選剛下載的 <code>ca.crt</code>。', '完全關掉 Chrome 再重新打開。'],
    open: '② 完成後，開啟有聲書 →', hint: '開啟後可以「加到主畫面」，就像一般 App 一樣使用。',
    note: '這張憑證只能用在私人網段（192.168.x.x、10.x.x.x…）和 <code>.local</code> 名稱，無法用來偽造一般網站。它的私鑰只存在執行伺服器的那台電腦（專案裡的 <code>.certs</code> 資料夾）；如果那台電腦遺失，請到手機的憑證設定把它移除。',
  },
  en: {
    html: 'en', title: 'Install the certificate · Audiobook Companion', h1: 'Let your phone trust this audiobook server',
    intro: 'A phone only allows the microphone on a secure (HTTPS) connection. Install the certificate on the phone once; after that you won\'t need to do it again even if the computer\'s IP address changes.',
    download: '① Download the certificate', ios: 'iPhone / iPad (Safari)', android: 'Android (Chrome)',
    iosSteps: ['Tap "Download the certificate" above and choose "Allow" to download the profile.', 'Open Settings; "Profile Downloaded" appears at the top. Tap it, then tap "Install".', 'Go to Settings → General → About → Certificate Trust Settings and switch on "Audiobook Companion Local CA".'],
    androidSteps: ['Tap "Download the certificate" above and save the file <code>ca.crt</code>.', 'Search Settings for "CA certificate" (usually Security → Encryption &amp; credentials → Install a certificate → CA certificate), choose "Install anyway", then pick the downloaded <code>ca.crt</code>.', 'Close Chrome completely and open it again.'],
    open: '② When you\'re done, open the audiobook app →', hint: 'Once it\'s open you can "Add to Home screen" and use it like any other app.',
    note: 'This certificate is only valid for private network addresses (192.168.x.x, 10.x.x.x …) and <code>.local</code> names, so it can\'t be used to impersonate ordinary websites. Its private key exists only on the computer running the server (the <code>.certs</code> folder in the project); if that computer is lost, remove the certificate in your phone\'s certificate settings.',
  },
  ja: {
    html: 'ja', title: '証明書のインストール · オーディオブック・コンパニオン', h1: 'このオーディオブックサーバーをスマホに信頼させる',
    intro: 'スマホのマイクは安全な接続（HTTPS）でしか使えません。最初に一度だけスマホに証明書をインストールしてください。以降はパソコンのIPアドレスが変わっても再インストールは不要です。',
    download: '① 証明書をダウンロード', ios: 'iPhone / iPad（Safari）', android: 'Android（Chrome）',
    iosSteps: ['上の「証明書をダウンロード」をタップし、「許可」を選んでプロファイルをダウンロードします。', '「設定」を開くと、一番上に「プロファイルがダウンロードされました」と表示されます。タップして「インストール」を押します。', '「設定 → 一般 → 情報 → 証明書信頼設定」で「Audiobook Companion Local CA」をオンにします。'],
    androidSteps: ['上の「証明書をダウンロード」をタップし、ファイル <code>ca.crt</code> を保存します。', '「設定」で「CA証明書」を検索し（通常は セキュリティ → 暗号化と認証情報 → 証明書のインストール → CA証明書）、「インストールする」を選んで、ダウンロードした <code>ca.crt</code> を選びます。', 'Chromeを完全に終了して、もう一度開きます。'],
    open: '② 完了したら、オーディオブックを開く →', hint: '開いたら「ホーム画面に追加」して、通常のアプリのように使えます。',
    note: 'この証明書はプライベートネットワークのアドレス（192.168.x.x、10.x.x.x など）と <code>.local</code> の名前でのみ有効で、一般のウェブサイトのなりすましには使えません。秘密鍵はサーバーを動かしているパソコン（プロジェクト内の <code>.certs</code> フォルダ）にだけあります。そのパソコンを紛失した場合は、スマホの証明書設定からこの証明書を削除してください。',
  },
};

/**
 * The language for an Accept-Language header (e.g. "ja,en;q=0.8"), chosen the same way as the app's interface language
 * (i18n.js): the first language by preference that we have, else English. `override` (?lang=) wins.
 */
export function pickSetupLang(acceptLanguage = '', override = '') {
  if (PAGES[override]) return override;
  const tags = String(acceptLanguage).split(',').map((part) => {
    const [tag, q] = part.trim().split(';q=');
    return { tag, q: q === undefined ? 1 : Number(q) || 0 };
  }).filter((w) => w.q > 0).sort((a, b) => b.q - a.q).map((w) => w.tag);
  return detectLang(tags); // always an explicit list: on the server there is no phone to ask
}

export function setupPage({ httpsUrl, lang = FALLBACK_LANG }) {
  const p = PAGES[lang] || PAGES[FALLBACK_LANG];
  const list = (items) => `<ol>${items.map((i) => `<li>${i}</li>`).join('')}</ol>`;
  return `<!doctype html><html lang="${p.html}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${p.title}</title>
<style>
  body{margin:0;background:#0b0d12;color:#eef1f8;font:16px/1.65 system-ui,-apple-system,"Noto Sans TC","PingFang TC","Microsoft JhengHei","Hiragino Sans",sans-serif;padding:20px 18px 48px;max-width:640px;margin-inline:auto}
  h1{font-size:1.4rem;margin:.2em 0 .3em} h2{font-size:1.05rem;margin:1.6em 0 .4em;color:#b9d2ff}
  p,li{color:#c8cfe2} a.btn{display:block;text-align:center;padding:16px;border-radius:16px;background:linear-gradient(160deg,#6c8cff,#a56cff);color:#fff;text-decoration:none;font-weight:700;margin:14px 0}
  a.btn.alt{background:#1a2030;border:1px solid #2a3247} ol{padding-left:1.3em} code{background:#1a2030;padding:1px 6px;border-radius:6px}
  .note{font-size:.85rem;color:#98a2bd;border-top:1px solid #2a3247;margin-top:2em;padding-top:1em}
</style></head><body>
<h1>${p.h1}</h1>
<p>${p.intro}</p>
<a class="btn" href="/ca.crt">${p.download}</a>
<h2>${p.ios}</h2>${list(p.iosSteps)}
<h2>${p.android}</h2>${list(p.androidSteps)}
<a class="btn alt" href="${httpsUrl}">${p.open}</a>
<p>${p.hint}</p>
<p class="note">${p.note}</p>
</body></html>`;
}
