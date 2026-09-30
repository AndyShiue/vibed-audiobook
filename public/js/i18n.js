// Interface language: Traditional Chinese (default), English, Japanese.
//
//   t(key, params)   translated string; {name} placeholders are filled from params
//                    (a value may also be a function of params, used where plural forms matter)
//   setLang / getLang
//   applyI18n(root)  fills every element marked with data-i18n / data-i18n-aria / data-i18n-ph
//
// Missing keys fall back to Chinese and then to the key itself; test/i18n.test.js makes sure no language lacks a key
// and that every key used in the code exists.

export const LANGS = [
  { code: 'zh', label: '中文', html: 'zh-Hant' },
  { code: 'en', label: 'English', html: 'en' },
  { code: 'ja', label: '日本語', html: 'ja' },
];

export const STRINGS = {
  // ==================================================================== 中文（預設）
  zh: {
    'app.title': '有聲書夥伴', 'quote': '「{s}」',
    'lib.aria': '書櫃', 'picker.aria': '選擇章節', 'picker.ariaCurrent': '選擇章節，目前是 {title}',
    'book.none': '尚未選擇書籍', 'settings.title': '設定', 'progress.aria': '閱讀進度',
    'ask.idle.label': '點一下提問', 'ask.idle.sub': '問劇情，或聽不懂的句子', 'ask.idle.subShake': '也可以搖一搖手機提問', 'ask.idle.aria': '按一下向 AI 提問',
    'ask.typed.label': '點一下輸入問題', 'ask.typed.sub': '此瀏覽器不支援語音輸入',
    'ask.listen.label': '請說話…', 'ask.listen.prep': '準備麥克風…', 'ask.listen.sub': '說完會自動送出，也可以再點一下送出', 'ask.listen.aria': '正在聆聽，按一下送出',
    'ask.think.label': '思考中…', 'ask.think.sub': '點一下取消', 'ask.think.aria': '{label}，按一下取消', 'ask.recognizing': '辨識語音中…',
    'ask.answer.label': 'AI 回答中', 'ask.answer.sub': '點一下追問，或按「繼續聽書」', 'ask.answer.aria': 'AI 回答中，按一下追問',
    'status.listening': '請說話', 'status.thinking': '思考中', 'status.answering': 'AI 回答中',
    'caption.aria': '目前的文字，可上下捲動', 'transport.aria': '播放控制',
    'back.aria': '上一段（長按：上一章）', 'back.label': '上一段', 'fwd.aria': '下一段（長按：下一章）', 'fwd.label': '下一段',
    'play.play': '播放', 'play.pause': '暫停', 'play.resume': '繼續聽書',
    'chip.speed.aria': '朗讀速度', 'chip.sleep.aria': '睡眠計時', 'chip.text': '文字/問答', 'chip.text.aria': '顯示文字與問答紀錄',
    'chip.type': '⌨ 打字問', 'chip.type.aria': '用鍵盤輸入問題',
    'sleep.off': '睡眠 關', 'sleep.minutes': '睡眠 {n} 分', 'sleep.chapter': '睡眠 章末',
    'sleep.toastOff': '已關閉睡眠計時', 'sleep.toastChapter': '這一章結束後停止', 'sleep.toastMinutes': '{n} 分鐘後停止',
    // voice commands (spoken and shown after the AI has chosen a player action)
    'cmd.rewind': (p) => `倒回 ${p.n} 句`, 'cmd.atStart': '已經在最前面了', 'cmd.skip': (p) => `往後跳 ${p.n} 句`, 'cmd.atEnd': '已經到最後了',
    'cmd.chapter': '跳到第 {n} 章', 'cmd.noChapter': '這本書只有 {count} 章，沒有第 {n} 章', 'cmd.passage': '回到那一段', 'cmd.passageNone': '在你聽過的內容裡找不到那一段',
    'cmd.percent': '跳到 {p}% 的位置', 'cmd.stop': '好，先停在這裡', 'cmd.resume': '繼續念', 'cmd.speed': '語速 {rate} 倍',
    'cmd.unknown': '我還不會做這個操作', 'cmd.invalid': '這個指令我沒聽清楚，請再說一次', 'cmd.askAgain': '我沒聽清楚，請再說一次', 'cmd.join': '，',
    'time.left': '還剩約 {t}', 'time.done': '已讀完',
    'dur.lt1': '不到 1 分鐘', 'dur.min': (p) => `${p.m} 分鐘`, 'dur.hour': (p) => `${p.h} 小時${p.rem ? ` ${p.rem} 分` : ''}`,

    'lib.back.aria': '回到播放', 'lib.title': '我的書櫃', 'lib.add': '＋ 加入書籍', 'lib.paste': '貼上文字',
    'lib.empty1': '還沒有書。', 'lib.empty2': '選擇一個電子書或文件檔，或把檔案拖到這裡。文字會留在你的手機上，只有你提問時，「已經聽過的部分」才會送給 AI。',
    'lib.formats': '支援格式：{list}', 'lib.formatsList': 'EPUB、PDF、TXT、Markdown、HTML、Word (docx)、ODT、FB2、RTF',
    'lib.untitled': '未命名', 'lib.chaptersN': (p) => `${p.n} 章`, 'lib.delete.aria': '刪除 {title}',
    'lib.delete.confirm': '要刪除「{title}」嗎？進度與 AI 記憶也會一併刪除。',
    'import.working': '處理中…', 'import.organizing': '整理文字…', 'import.reading': '讀取「{name}」…', 'import.added': '已加入：{title}',
    'book.missing': '找不到這本書', 'book.finished': '全書播放完畢 🎉',

    'sheet.text.aria': '文字', 'tab.text': '書中文字', 'tab.qa': '問答紀錄', 'close': '關閉', 'cancel': '取消',
    'chapters.title': '章節', 'chapters.sheetTitle': '章節（共 {n} 章）', 'chapters.playFrom': '從這一章開始播放',
    'ask.sheet': '輸入問題', 'ask.placeholder': '例如：剛剛那句話是什麼意思？／他為什麼要這麼做？', 'ask.submit': '送出',
    'paste.title': '貼上文字', 'paste.titlePh': '標題（選填）', 'paste.textPh': '把要聽的文章貼在這裡', 'paste.submit': '加入書櫃',
    'qa.empty': '這本書還沒有問過問題。', 'qa.q': '問：{q}', 'qa.meta': '{chapter} · 約 {pct}% 處',

    'set.language': '介面語言 / Language / 言語',
    'set.rate': '朗讀速度', 'set.voice': '朗讀聲音', 'set.answerVoice': 'AI 回答的聲音（依提問語言）',
    'set.testVoice': '試聽朗讀', 'set.testAnswer': '試聽回答', 'voice.auto': '自動（建議）', 'voice.online': '・線上',
    'set.sec.voice': '語音提問', 'set.sttMode': '辨識方式',
    'set.sttMode.auto': '自動（設定好雲端就用雲端）', 'set.sttMode.cloud': '雲端辨識（整段錄音上傳，可中英夾雜）', 'set.sttMode.device': '手機內建辨識（一次只能一種語言）',
    'set.cloudLang': '雲端辨識的語言', 'set.cloudLang.auto': '自動偵測（建議，可混合多種語言）',
    'set.sttHint': '把目前位置附近的書中文字一併傳給辨識服務（可提高人名準確度，但可能讓英文提問被誤認成書中文字；一般不建議開，AI 回答時本來就會依劇情修正聽錯的人名）',
    'set.askLang': '手機內建辨識的語言（只有「手機內建辨識」用得到）', 'set.askLang.auto': '跟隨手機語言', 'set.askLang.book': '跟隨書本語言',
    'set.wake': '播放時保持螢幕亮著（鎖屏後手機通常會停止朗讀）', 'set.earcons': '提示音', 'set.haptics': '震動回饋',
    'set.sendTitle': '讓 AI 知道書名與作者（回答較準，但 AI 可能記得後面的劇情）',
    'set.sec.gesture': '手勢', 'set.shake': '搖晃手機來開始提問（預設關閉）。相當於點一下大按鈕；需要螢幕亮著。', 'set.shakeSens': '搖晃靈敏度',
    'shake.low': '低（要用力搖，最不會誤觸）', 'shake.normal': '中', 'shake.high': '高（輕搖就觸發，走路或慢跑時可能誤觸）',
    'set.sec.advanced': '進階', 'set.token': '存取密碼（伺服器有設定時才需要）',
    'set.chapters': '章節列表', 'set.clearMemory': '清除此書的 AI 記憶', 'set.restart': '從頭開始',
    'confirm.clearMemory': '清除這本書的 AI 記憶（摘要與問答紀錄）？之後會依聽書進度重新整理，可能再花費一些 API 用量。', 'toast.cleared': '已清除', 'confirm.restart': '回到這本書的開頭？',
    'preview.narration.zh': '這是朗讀聲音的試聽，你覺得速度合適嗎？', 'preview.narration.ja': 'これは読み上げ音声の試聴です。速さはちょうど良いですか？', 'preview.narration.en': 'This is a preview of the narration voice. How does the speed feel?',
    'preview.answer.zh': '這是 AI 回答的聲音。我會盡量簡短地回答你的問題。', 'preview.answer.ja': 'これはAIの回答の声です。できるだけ簡潔にお答えします。', 'preview.answer.en': 'This is the voice of the AI. I will keep my answers short.',

    'sttInfo.now.cloud': '目前用：雲端辨識', 'sttInfo.now.device': '目前用：手機內建辨識', 'sttInfo.now.typed': '目前這個瀏覽器沒有可用的語音辨識，只能打字提問',
    'sttInfo.connected': '雲端辨識已連線：{who}。{now}。', 'sttInfo.mock': '測試用模擬',
    'sttInfo.notSet': '雲端辨識尚未設定（在伺服器 .env 設定 OPENAI_API_KEY 或 GROQ_API_KEY 後可用）。{now}。',
    'aiInfo.connected': 'AI 已連線{detail}。', 'aiInfo.mock': '（測試用模擬模式）', 'aiInfo.models': '：回答用 {qa}，記憶整理用 {summary}', 'aiInfo.notSet': 'AI 尚未設定。',
    'mem.summary': 'AI 記憶：已整理 {done}/{total} 段「聽過的內容」摘要{running}', 'mem.running': '（整理中…）',
    'mem.auth': '金鑰或存取密碼有問題，已暫停整理。', 'mem.config': '伺服器尚未設定 AI，已暫停整理。', 'mem.credit': 'AI 帳戶額度用完，已暫停整理（儲值後重新整理頁面）。',
    'mem.failures': (p) => `暫時失敗 ${p.n} 次，稍後會重試。`,
    'shake.ok': '動作感測器正常。搖一搖試試看，偵測到時這裡會顯示「偵測到搖晃」並震動一下。', 'shake.waiting': '正在確認動作感測器…',
    'shake.none': '沒有收到動作感測器的資料。電腦通常沒有這個感測器；手機請確認瀏覽器允許「動作與方向」。',
    'shake.denied': '沒有取得動作感測器的權限。iPhone：設定 → Safari → 動作與方向存取，打開後重新開啟這個開關。',
    'shake.unsupported': '這個瀏覽器不支援動作感測器。', 'shake.needsPermission': 'iPhone 需要你的允許：點一下畫面任何地方，會跳出「動作與方向」的詢問。',
    'shake.detected': '✓ 偵測到搖晃！', 'shake.announce': '偵測到搖晃，開始提問', 'shake.deniedToast': '沒有取得動作感測器的權限，搖晃提問沒有開啟。',

    'banner.noTts': '這個瀏覽器不支援語音朗讀，請改用 Chrome 或 Safari。', 'banner.offline': '連不到伺服器，AI 問答暫時無法使用（朗讀仍可運作）。',
    'banner.noAi': 'AI 尚未設定：請在伺服器 .env 設定 ANTHROPIC_API_KEY（或改用 OpenAI：AI_PROVIDER=openai 與 OPENAI_API_KEY，見 README）。朗讀不受影響。', 'banner.needToken': '伺服器需要存取密碼：請到「設定」輸入。',
    'toast.blocked': '瀏覽器擋住了自動播放，請再點一下「播放」。', 'toast.ttsError': '語音朗讀發生問題（{detail}）。請到設定換一個聲音試試。',
    'toast.cloudFallback': '雲端語音辨識還沒設定好，這次改用手機內建辨識。',
    'toast.micDenied': '麥克風權限被拒絕。請在瀏覽器網址列旁的網站設定允許使用麥克風，或改用「⌨ 打字問」。',
    'toast.sttFailed': '語音辨識失敗（{err}）。可改用「⌨ 打字問」。', 'toast.sttError': '語音辨識發生錯誤', 'toast.aiError': 'AI 發生錯誤',
    'say.micDenied': '沒有麥克風權限，請到瀏覽器設定允許。', 'say.sttFailed': '語音辨識沒有成功',
    'say.stt.402': '語音辨識帳戶的額度用完了，請到服務商的帳單頁面儲值。', 'say.stt.429': '語音辨識現在太忙了，請稍後再問一次。', 'say.stt.503': '雲端語音辨識還沒有設定好。',
    'say.stt.400': '這段錄音沒有辦法辨識，請再說一次。', 'say.stt.401': '存取密碼有問題，請到設定確認。', 'say.stt.default': '語音辨識服務現在連不上，請稍後再試。',
    'say.offline': '現在沒有網路連線。', 'say.serverOffline': '現在連不上伺服器。', 'say.aiNotReady': 'AI 還沒有設定好。', 'say.contextError': '整理上下文時出了問題。',
    'say.refusal': '抱歉，這個問題我沒辦法回答。', 'say.empty': '我沒有想到可以回答的內容。',
    'say.ai.402': 'AI 帳戶的額度用完了，請到服務商的帳單頁面儲值。', 'say.ai.401': 'AI 的金鑰或存取密碼有問題。', 'say.ai.429': 'AI 現在太忙了，請稍後再問一次。', 'say.ai.default': 'AI 現在沒辦法回答，請稍後再試。',

    // ---- file import (parsers)
    'part.n': '第 {n} 部分', 'section.n': '第 {n} 節',
    'err.loadComponent': '無法載入元件：{url}', 'err.xml': '檔案內的 XML 格式有問題', 'err.empty': '這個檔案是空的。', 'err.noReadable': '這個檔案裡找不到可以朗讀的文字。',
    'err.noTextIn': '這個 {kind} 檔裡沒有找到文字', 'err.invalidFile': '不是有效的 {kind} 檔',
    'err.mobi': 'MOBI / AZW 格式暫不支援。請先用 Calibre 之類的工具轉成 EPUB 再匯入。', 'err.azw3': 'AZW3 格式暫不支援。請先用 Calibre 之類的工具轉成 EPUB 再匯入。',
    'err.kfx': 'KFX 格式暫不支援。請先轉成 EPUB 再匯入。', 'err.doc': '舊版 Word (.doc) 暫不支援。請在 Word 裡另存成 .docx 再匯入。',
    'err.presentation': '不支援簡報檔。', 'err.spreadsheet': '不支援試算表。', 'err.zip': '請直接選擇 EPUB / PDF / 文字檔，而不是壓縮檔。', 'err.rar': '請先解壓縮後再匯入。',
    'err.audio': '這是音訊檔，本程式是用來朗讀文字書籍的。', 'err.zipUnknown': '無法辨識這個壓縮檔的內容格式。',
    'err.drm': '這本電子書有 DRM 保護，無法讀取。請使用沒有 DRM 的版本。', 'err.epubContainer': '不是有效的 EPUB（找不到 container.xml）', 'err.epubOpf': 'EPUB 缺少 OPF 描述檔',
    'err.pdfPassword': '這個 PDF 有密碼保護，無法讀取。', 'err.pdfOpen': '無法開啟 PDF：{msg}',
    'err.pdfScanned': '這個 PDF 幾乎沒有可選取的文字，可能是掃描圖片檔。目前不支援 OCR，請改用有文字層的版本（或先用 OCR 工具轉換）。',
    'warn.pdfGarbled': '這個 PDF 的文字看起來是亂碼（可能是中文字型沒有嵌入檔案）。建議改用 EPUB／其他版本，或先用別的軟體轉成文字檔再匯入。',
    'progress.readingFile': '讀取檔案', 'progress.chapter': '讀取章節 {i}/{n}', 'progress.pdfPage': '讀取 PDF 第 {p}/{n} 頁', 'progress.chapters': '整理章節',
  },

  // ==================================================================== English
  en: {
    'app.title': 'Audiobook Companion', 'quote': '“{s}”',
    'lib.aria': 'Library', 'picker.aria': 'Choose chapter', 'picker.ariaCurrent': 'Choose chapter, currently {title}',
    'book.none': 'No book selected', 'settings.title': 'Settings', 'progress.aria': 'Reading progress',
    'ask.idle.label': 'Tap to ask', 'ask.idle.sub': 'Ask about the plot, or a sentence you didn\'t get', 'ask.idle.subShake': 'You can also shake the phone to ask', 'ask.idle.aria': 'Tap to ask the AI a question',
    'ask.typed.label': 'Tap to type a question', 'ask.typed.sub': 'This browser doesn\'t support voice input',
    'ask.listen.label': 'Speak now…', 'ask.listen.prep': 'Getting the microphone ready…', 'ask.listen.sub': 'It sends when you stop talking, or tap again to send now', 'ask.listen.aria': 'Listening, tap to send',
    'ask.think.label': 'Thinking…', 'ask.think.sub': 'Tap to cancel', 'ask.think.aria': '{label} Tap to cancel', 'ask.recognizing': 'Recognizing speech…',
    'ask.answer.label': 'AI is answering', 'ask.answer.sub': 'Tap to ask a follow-up, or press "Resume book"', 'ask.answer.aria': 'AI is answering, tap to ask a follow-up',
    'status.listening': 'Listening', 'status.thinking': 'Thinking', 'status.answering': 'AI is answering',
    'caption.aria': 'Current text (scrollable)', 'transport.aria': 'Playback controls',
    'back.aria': 'Previous paragraph (long-press: previous chapter)', 'back.label': 'Previous', 'fwd.aria': 'Next paragraph (long-press: next chapter)', 'fwd.label': 'Next',
    'play.play': 'Play', 'play.pause': 'Pause', 'play.resume': 'Resume book',
    'chip.speed.aria': 'Reading speed', 'chip.sleep.aria': 'Sleep timer', 'chip.text': 'Text/Q&A', 'chip.text.aria': 'Show text and Q&A history',
    'chip.type': '⌨ Type', 'chip.type.aria': 'Type a question with the keyboard',
    'sleep.off': 'Sleep: off', 'sleep.minutes': 'Sleep {n} min', 'sleep.chapter': 'Sleep: chapter end',
    'sleep.toastOff': 'Sleep timer off', 'sleep.toastChapter': 'Stops at the end of this chapter', 'sleep.toastMinutes': 'Stops in {n} minutes',
    // voice commands (spoken and shown after the AI has chosen a player action)
    'cmd.rewind': (p) => (p.n === 1 ? 'Back one sentence' : `Back ${p.n} sentences`), 'cmd.atStart': 'Already at the very beginning', 'cmd.skip': (p) => (p.n === 1 ? 'Skipping one sentence' : `Skipping ${p.n} sentences`), 'cmd.atEnd': 'Already at the very end',
    'cmd.chapter': 'Going to chapter {n}', 'cmd.noChapter': 'This book has only {count} chapters, so there is no chapter {n}', 'cmd.passage': 'Back to that passage', 'cmd.passageNone': 'I couldn\'t find that in what you\'ve heard so far',
    'cmd.percent': 'Jumping to {p} percent', 'cmd.stop': 'Okay, stopping here', 'cmd.resume': 'Continuing', 'cmd.speed': 'Speed {rate}x',
    'cmd.unknown': 'I can\'t do that yet', 'cmd.invalid': 'I didn\'t catch that command, please say it again', 'cmd.askAgain': 'I didn\'t catch that, please say it again', 'cmd.join': '. ',
    'time.left': 'About {t} left', 'time.done': 'Finished',
    'dur.lt1': 'under 1 minute', 'dur.min': (p) => `${p.m} min`, 'dur.hour': (p) => `${p.h} h${p.rem ? ` ${p.rem} min` : ''}`,

    'lib.back.aria': 'Back to the player', 'lib.title': 'My library', 'lib.add': '＋ Add books', 'lib.paste': 'Paste text',
    'lib.empty1': 'No books yet.', 'lib.empty2': 'Choose an e-book or document, or drag a file here. Your text stays on your phone; only the part you have already heard is sent to the AI when you ask a question.',
    'lib.formats': 'Supported formats: {list}', 'lib.formatsList': 'EPUB, PDF, TXT, Markdown, HTML, Word (docx), ODT, FB2, RTF',
    'lib.untitled': 'Untitled', 'lib.chaptersN': (p) => `${p.n} chapter${p.n === 1 ? '' : 's'}`, 'lib.delete.aria': 'Delete {title}',
    'lib.delete.confirm': 'Delete "{title}"? Its progress and AI memory will be deleted too.',
    'import.working': 'Working…', 'import.organizing': 'Processing text…', 'import.reading': 'Reading "{name}"…', 'import.added': 'Added: {title}',
    'book.missing': 'Couldn\'t find this book', 'book.finished': 'Finished the whole book 🎉',

    'sheet.text.aria': 'Text', 'tab.text': 'Book text', 'tab.qa': 'Q&A history', 'close': 'Close', 'cancel': 'Cancel',
    'chapters.title': 'Chapters', 'chapters.sheetTitle': 'Chapters ({n})', 'chapters.playFrom': 'Playing from this chapter',
    'ask.sheet': 'Type a question', 'ask.placeholder': 'e.g. What did that last sentence mean? / Why did he do that?', 'ask.submit': 'Send',
    'paste.title': 'Paste text', 'paste.titlePh': 'Title (optional)', 'paste.textPh': 'Paste the text you want to listen to here', 'paste.submit': 'Add to library',
    'qa.empty': 'No questions asked about this book yet.', 'qa.q': 'Q: {q}', 'qa.meta': '{chapter} · about {pct}%',

    'set.language': '介面語言 / Language / 言語',
    'set.rate': 'Reading speed', 'set.voice': 'Reading voice', 'set.answerVoice': 'Voice for AI answers (by question language)',
    'set.testVoice': 'Preview reading', 'set.testAnswer': 'Preview answer', 'voice.auto': 'Automatic (recommended)', 'voice.online': ' · online',
    'set.sec.voice': 'Voice questions', 'set.sttMode': 'Recognition method',
    'set.sttMode.auto': 'Automatic (cloud when it is set up)', 'set.sttMode.cloud': 'Cloud recognition (uploads the recording; handles mixed languages)', 'set.sttMode.device': 'Phone\'s built-in recognition (one language at a time)',
    'set.cloudLang': 'Language for cloud recognition', 'set.cloudLang.auto': 'Auto-detect (recommended; handles mixed languages)',
    'set.sttHint': 'Also send text from near the current position to the recognizer (can improve names, but may make English questions be mistaken for book text; usually not recommended, since the AI already corrects misheard names from the story)',
    'set.askLang': 'Language for the phone\'s built-in recognition (only used by that method)', 'set.askLang.auto': 'Same as the phone', 'set.askLang.book': 'Same as the book',
    'set.wake': 'Keep the screen on while playing (phones usually stop reading once the screen locks)', 'set.earcons': 'Sounds', 'set.haptics': 'Vibration feedback',
    'set.sendTitle': 'Tell the AI the title and author (more accurate, but the AI may remember what happens later in the book)',
    'set.sec.gesture': 'Gestures', 'set.shake': 'Shake the phone to start asking (off by default). Same as tapping the big button; the screen must be on.', 'set.shakeSens': 'Shake sensitivity',
    'shake.low': 'Low (needs a hard shake; fewest false triggers)', 'shake.normal': 'Medium', 'shake.high': 'High (a light shake triggers; may misfire when walking or jogging)',
    'set.sec.advanced': 'Advanced', 'set.token': 'Access password (only needed if the server sets one)',
    'set.chapters': 'Chapter list', 'set.clearMemory': 'Clear this book\'s AI memory', 'set.restart': 'Start over',
    'confirm.clearMemory': 'Clear this book\'s AI memory (summaries and Q&A history)? It will be rebuilt as you keep listening, which may use some API credit again.', 'toast.cleared': 'Cleared', 'confirm.restart': 'Go back to the beginning of this book?',
    'preview.narration.zh': '這是朗讀聲音的試聽，你覺得速度合適嗎？', 'preview.narration.ja': 'これは読み上げ音声の試聴です。速さはちょうど良いですか？', 'preview.narration.en': 'This is a preview of the narration voice. How does the speed feel?',
    'preview.answer.zh': '這是 AI 回答的聲音。我會盡量簡短地回答你的問題。', 'preview.answer.ja': 'これはAIの回答の声です。できるだけ簡潔にお答えします。', 'preview.answer.en': 'This is the voice of the AI. I will keep my answers short.',

    'sttInfo.now.cloud': 'Currently using: cloud recognition', 'sttInfo.now.device': 'Currently using: the phone\'s built-in recognition', 'sttInfo.now.typed': 'This browser has no usable speech recognition, so you can only type questions',
    'sttInfo.connected': 'Cloud recognition is connected: {who}. {now}.', 'sttInfo.mock': 'test mock',
    'sttInfo.notSet': 'Cloud recognition isn\'t set up (set OPENAI_API_KEY or GROQ_API_KEY in the server\'s .env). {now}.',
    'aiInfo.connected': 'AI is connected{detail}.', 'aiInfo.mock': ' (test mock mode)', 'aiInfo.models': ': answers by {qa}, memory by {summary}', 'aiInfo.notSet': 'AI is not set up.',
    'mem.summary': 'AI memory: {done}/{total} sections of what you have heard are summarized{running}', 'mem.running': ' (working…)',
    'mem.auth': 'A key or access-password problem paused the summarizing.', 'mem.config': 'The server has no AI configured, so summarizing is paused.', 'mem.credit': 'The AI account is out of credit, so summarizing is paused (add credit, then reload the page).',
    'mem.failures': (p) => `Failed ${p.n} time${p.n === 1 ? '' : 's'} for now; it will retry shortly.`,
    'shake.ok': 'The motion sensor works. Try shaking; when detected, this line shows "Shake detected" and the phone vibrates.', 'shake.waiting': 'Checking the motion sensor…',
    'shake.none': 'No motion-sensor data received. Computers usually don\'t have one; on a phone, make sure the browser allows "Motion & Orientation".',
    'shake.denied': 'Permission for the motion sensor wasn\'t granted. iPhone: Settings → Safari → Motion & Orientation Access, turn it on, then switch this option on again.',
    'shake.unsupported': 'This browser doesn\'t support motion sensors.', 'shake.needsPermission': 'iPhone needs your permission: tap anywhere on the screen and the "Motion & Orientation" prompt will appear.',
    'shake.detected': '✓ Shake detected!', 'shake.announce': 'Shake detected, starting to listen', 'shake.deniedToast': 'Motion-sensor permission wasn\'t granted, so shake-to-ask stays off.',

    'banner.noTts': 'This browser doesn\'t support speech; please use Chrome or Safari.', 'banner.offline': 'Can\'t reach the server, so AI Q&A is unavailable for now (reading still works).',
    'banner.noAi': 'AI is not set up: set ANTHROPIC_API_KEY in the server\'s .env (or use OpenAI: AI_PROVIDER=openai and OPENAI_API_KEY; see the README). Reading is not affected.', 'banner.needToken': 'The server requires an access password: enter it in Settings.',
    'toast.blocked': 'The browser blocked autoplay; please tap Play again.', 'toast.ttsError': 'Speech problem ({detail}). Try another voice in Settings.',
    'toast.cloudFallback': 'Cloud recognition isn\'t set up; using the phone\'s built-in recognition this time.',
    'toast.micDenied': 'Microphone permission was denied. Allow the microphone in the site settings next to the address bar, or use "⌨ Type".',
    'toast.sttFailed': 'Speech recognition failed ({err}). You can use "⌨ Type" instead.', 'toast.sttError': 'A speech recognition error occurred', 'toast.aiError': 'An AI error occurred',
    'say.micDenied': 'No microphone permission. Please allow it in the browser settings.', 'say.sttFailed': 'Speech recognition didn\'t work.',
    'say.stt.402': 'The speech recognition account is out of credit. Please add credit on the provider\'s billing page.', 'say.stt.429': 'Speech recognition is busy right now. Please ask again in a moment.', 'say.stt.503': 'Cloud speech recognition isn\'t set up yet.',
    'say.stt.400': 'I couldn\'t recognize that recording. Please say it again.', 'say.stt.401': 'There\'s a problem with the access password. Please check it in Settings.', 'say.stt.default': 'The speech recognition service is unreachable. Please try again later.',
    'say.offline': 'There\'s no network connection right now.', 'say.serverOffline': 'Can\'t reach the server right now.', 'say.aiNotReady': 'The AI isn\'t set up yet.', 'say.contextError': 'Something went wrong while preparing the context.',
    'say.refusal': 'Sorry, I can\'t answer that question.', 'say.empty': 'I couldn\'t come up with an answer.',
    'say.ai.402': 'The AI account is out of credit. Please add credit on the provider\'s billing page.', 'say.ai.401': 'There\'s a problem with the AI key or the access password.', 'say.ai.429': 'The AI is busy right now. Please ask again in a moment.', 'say.ai.default': 'The AI can\'t answer right now. Please try again later.',

    'part.n': 'Part {n}', 'section.n': 'Section {n}',
    'err.loadComponent': 'Couldn\'t load a component: {url}', 'err.xml': 'The XML inside the file is malformed', 'err.empty': 'This file is empty.', 'err.noReadable': 'No text to read aloud was found in this file.',
    'err.noTextIn': 'No text was found in this {kind} file', 'err.invalidFile': 'Not a valid {kind} file',
    'err.mobi': 'MOBI / AZW isn\'t supported yet. Please convert it to EPUB first with a tool such as Calibre.', 'err.azw3': 'AZW3 isn\'t supported yet. Please convert it to EPUB first with a tool such as Calibre.',
    'err.kfx': 'KFX isn\'t supported yet. Please convert it to EPUB first.', 'err.doc': 'Old Word (.doc) files aren\'t supported. Please save it as .docx in Word first.',
    'err.presentation': 'Presentation files aren\'t supported.', 'err.spreadsheet': 'Spreadsheets aren\'t supported.', 'err.zip': 'Please choose the EPUB / PDF / text file itself, not an archive.', 'err.rar': 'Please extract it first, then import the file.',
    'err.audio': 'This is an audio file; this app reads text books aloud.', 'err.zipUnknown': 'Couldn\'t recognize the contents of this archive.',
    'err.drm': 'This e-book is DRM-protected and can\'t be read. Please use a DRM-free version.', 'err.epubContainer': 'Not a valid EPUB (container.xml not found)', 'err.epubOpf': 'The EPUB is missing its OPF file',
    'err.pdfPassword': 'This PDF is password-protected and can\'t be read.', 'err.pdfOpen': 'Couldn\'t open the PDF: {msg}',
    'err.pdfScanned': 'This PDF has almost no selectable text; it is probably a scanned image. OCR isn\'t supported yet: please use a version with a text layer (or run it through an OCR tool first).',
    'warn.pdfGarbled': 'The text in this PDF looks garbled (Chinese fonts may not be embedded in the file). Try an EPUB or another version, or convert it to a text file with other software first.',
    'progress.readingFile': 'Reading file', 'progress.chapter': 'Reading chapter {i}/{n}', 'progress.pdfPage': 'Reading PDF page {p}/{n}', 'progress.chapters': 'Organizing chapters',
  },

  // ==================================================================== 日本語
  ja: {
    'app.title': 'オーディオブック・コンパニオン', 'quote': '「{s}」',
    'lib.aria': '本棚', 'picker.aria': 'チャプターを選ぶ', 'picker.ariaCurrent': 'チャプターを選ぶ（現在：{title}）',
    'book.none': '本が選ばれていません', 'settings.title': '設定', 'progress.aria': '読書の進み具合',
    'ask.idle.label': 'タップして質問', 'ask.idle.sub': '展開や、聞き取れなかった文について', 'ask.idle.subShake': 'スマホを振っても質問できます', 'ask.idle.aria': 'タップしてAIに質問',
    'ask.typed.label': 'タップして質問を入力', 'ask.typed.sub': 'このブラウザは音声入力に対応していません',
    'ask.listen.label': 'どうぞ話してください…', 'ask.listen.prep': 'マイクを準備中…', 'ask.listen.sub': '話し終えると自動で送信されます。もう一度タップして送信もできます', 'ask.listen.aria': '聞き取り中。タップで送信',
    'ask.think.label': '考え中…', 'ask.think.sub': 'タップでキャンセル', 'ask.think.aria': '{label}。タップでキャンセル', 'ask.recognizing': '音声を認識中…',
    'ask.answer.label': 'AIが回答中', 'ask.answer.sub': 'タップで追加質問、または「本に戻る」を押す', 'ask.answer.aria': 'AIが回答中。タップで追加質問',
    'status.listening': 'どうぞ話してください', 'status.thinking': '考え中', 'status.answering': 'AIが回答中',
    'caption.aria': '現在のテキスト（スクロールできます）', 'transport.aria': '再生コントロール',
    'back.aria': '前の段落（長押し：前の章）', 'back.label': '前へ', 'fwd.aria': '次の段落（長押し：次の章）', 'fwd.label': '次へ',
    'play.play': '再生', 'play.pause': '一時停止', 'play.resume': '本に戻る',
    'chip.speed.aria': '読み上げ速度', 'chip.sleep.aria': 'スリープタイマー', 'chip.text': 'テキスト/Q&A', 'chip.text.aria': 'テキストと質問履歴を表示',
    'chip.type': '⌨ 入力', 'chip.type.aria': 'キーボードで質問を入力',
    'sleep.off': 'スリープ: オフ', 'sleep.minutes': 'スリープ {n}分', 'sleep.chapter': 'スリープ: 章の終わり',
    'sleep.toastOff': 'スリープタイマーをオフにしました', 'sleep.toastChapter': 'この章の終わりで停止します', 'sleep.toastMinutes': '{n}分後に停止します',
    // voice commands (spoken and shown after the AI has chosen a player action)
    'cmd.rewind': (p) => `${p.n}文戻ります`, 'cmd.atStart': 'もう一番最初です', 'cmd.skip': (p) => `${p.n}文進みます`, 'cmd.atEnd': 'もう一番最後です',
    'cmd.chapter': '第{n}章へ移動します', 'cmd.noChapter': 'この本は{count}章までなので、第{n}章はありません', 'cmd.passage': 'その場面に戻ります', 'cmd.passageNone': 'これまで聞いた部分には見つかりませんでした',
    'cmd.percent': '{p}%の位置へ移動します', 'cmd.stop': 'はい、ここで止めます', 'cmd.resume': '続けます', 'cmd.speed': '速度は{rate}倍です',
    'cmd.unknown': 'その操作はまだできません', 'cmd.invalid': 'よく聞き取れませんでした。もう一度お願いします', 'cmd.askAgain': 'よく聞き取れませんでした。もう一度お願いします', 'cmd.join': '。',
    'time.left': '残り約{t}', 'time.done': '読了',
    'dur.lt1': '1分未満', 'dur.min': (p) => `${p.m}分`, 'dur.hour': (p) => `${p.h}時間${p.rem ? `${p.rem}分` : ''}`,

    'lib.back.aria': 'プレーヤーに戻る', 'lib.title': 'マイ本棚', 'lib.add': '＋ 本を追加', 'lib.paste': 'テキストを貼り付け',
    'lib.empty1': 'まだ本がありません。', 'lib.empty2': '電子書籍や文書ファイルを選ぶか、ここにドラッグしてください。テキストはお使いの端末に残り、質問したときに「すでに聞いた部分」だけがAIに送られます。',
    'lib.formats': '対応形式：{list}', 'lib.formatsList': 'EPUB、PDF、TXT、Markdown、HTML、Word (docx)、ODT、FB2、RTF',
    'lib.untitled': '無題', 'lib.chaptersN': (p) => `${p.n}章`, 'lib.delete.aria': '{title}を削除',
    'lib.delete.confirm': '「{title}」を削除しますか？進行状況とAIメモリも一緒に削除されます。',
    'import.working': '処理中…', 'import.organizing': 'テキストを整理中…', 'import.reading': '「{name}」を読み込み中…', 'import.added': '追加しました：{title}',
    'book.missing': 'この本が見つかりません', 'book.finished': '最後まで再生しました 🎉',

    'sheet.text.aria': 'テキスト', 'tab.text': '本文', 'tab.qa': '質問履歴', 'close': '閉じる', 'cancel': 'キャンセル',
    'chapters.title': 'チャプター', 'chapters.sheetTitle': 'チャプター（全{n}章）', 'chapters.playFrom': 'この章から再生します',
    'ask.sheet': '質問を入力', 'ask.placeholder': '例：今の文はどういう意味？／なぜ彼はそうしたの？', 'ask.submit': '送信',
    'paste.title': 'テキストを貼り付け', 'paste.titlePh': 'タイトル（任意）', 'paste.textPh': '聞きたい文章をここに貼り付けてください', 'paste.submit': '本棚に追加',
    'qa.empty': 'この本にはまだ質問していません。', 'qa.q': '質問：{q}', 'qa.meta': '{chapter} · 約{pct}%の地点',

    'set.language': '介面語言 / Language / 言語',
    'set.rate': '読み上げ速度', 'set.voice': '読み上げの声', 'set.answerVoice': 'AI回答の声（質問の言語に応じて）',
    'set.testVoice': '読み上げを試聴', 'set.testAnswer': '回答を試聴', 'voice.auto': '自動（推奨）', 'voice.online': '・オンライン',
    'set.sec.voice': '音声での質問', 'set.sttMode': '認識方法',
    'set.sttMode.auto': '自動（クラウドが設定済みならクラウドを使用）', 'set.sttMode.cloud': 'クラウド認識（録音全体をアップロード。言語の混在OK）', 'set.sttMode.device': '端末内蔵の認識（一度に1言語のみ）',
    'set.cloudLang': 'クラウド認識の言語', 'set.cloudLang.auto': '自動検出（推奨。複数言語の混在OK）',
    'set.sttHint': '現在位置付近の本文も認識サービスに送る（人名の精度が上がる場合がありますが、英語の質問が本文と誤認されることがあります。通常はオフを推奨。AIが回答時に物語から聞き間違いを補正します）',
    'set.askLang': '端末内蔵認識の言語（「端末内蔵の認識」でのみ使用）', 'set.askLang.auto': '端末の言語に合わせる', 'set.askLang.book': '本の言語に合わせる',
    'set.wake': '再生中は画面を点灯したままにする（画面ロックすると通常は読み上げが止まります）', 'set.earcons': '効果音', 'set.haptics': '振動フィードバック',
    'set.sendTitle': 'AIに書名と著者を伝える（回答は正確になりますが、AIが先の展開を覚えている可能性があります）',
    'set.sec.gesture': 'ジェスチャー', 'set.shake': 'スマホを振って質問を開始（デフォルトはオフ）。大きなボタンをタップするのと同じです。画面がついている必要があります。', 'set.shakeSens': '振る強さの感度',
    'shake.low': '低（強く振る必要あり。誤作動が最も少ない）', 'shake.normal': '中', 'shake.high': '高（軽く振るだけで反応。歩行やジョギング中に誤作動することがあります）',
    'set.sec.advanced': '詳細設定', 'set.token': 'アクセスパスワード（サーバーで設定されている場合のみ）',
    'set.chapters': 'チャプター一覧', 'set.clearMemory': 'この本のAIメモリを消去', 'set.restart': '最初から',
    'confirm.clearMemory': 'この本のAIメモリ（要約と質問履歴）を消去しますか？聞き進めると再び整理され、APIの利用料がかかる場合があります。', 'toast.cleared': '消去しました', 'confirm.restart': 'この本の最初に戻りますか？',
    'preview.narration.zh': '這是朗讀聲音的試聽，你覺得速度合適嗎？', 'preview.narration.ja': 'これは読み上げ音声の試聴です。速さはちょうど良いですか？', 'preview.narration.en': 'This is a preview of the narration voice. How does the speed feel?',
    'preview.answer.zh': '這是 AI 回答的聲音。我會盡量簡短地回答你的問題。', 'preview.answer.ja': 'これはAIの回答の声です。できるだけ簡潔にお答えします。', 'preview.answer.en': 'This is the voice of the AI. I will keep my answers short.',

    'sttInfo.now.cloud': '現在の認識：クラウド', 'sttInfo.now.device': '現在の認識：端末内蔵', 'sttInfo.now.typed': 'このブラウザには使える音声認識がなく、入力での質問のみです',
    'sttInfo.connected': 'クラウド認識に接続済み：{who}。{now}。', 'sttInfo.mock': 'テスト用モック',
    'sttInfo.notSet': 'クラウド認識は未設定です（サーバーの .env に OPENAI_API_KEY または GROQ_API_KEY を設定すると使えます）。{now}。',
    'aiInfo.connected': 'AIに接続済み{detail}。', 'aiInfo.mock': '（テスト用モックモード）', 'aiInfo.models': '：回答は{qa}、メモリ整理は{summary}', 'aiInfo.notSet': 'AIは未設定です。',
    'mem.summary': 'AIメモリ：聞いた内容の要約を{done}/{total}区間まで整理済み{running}', 'mem.running': '（整理中…）',
    'mem.auth': 'キーまたはアクセスパスワードの問題により、整理を一時停止しました。', 'mem.config': 'サーバーにAIが設定されていないため、整理を一時停止しました。', 'mem.credit': 'AIアカウントのクレジットが尽きたため、整理を一時停止しました（チャージ後にページを再読み込みしてください）。',
    'mem.failures': (p) => `一時的に${p.n}回失敗しました。まもなく再試行します。`,
    'shake.ok': 'モーションセンサーは正常です。振ってみてください。検出するとここに「振りを検出」と表示され、振動します。', 'shake.waiting': 'モーションセンサーを確認中…',
    'shake.none': 'モーションセンサーのデータが届きません。パソコンには通常ありません。スマホではブラウザの「モーションと画面の向き」を許可しているか確認してください。',
    'shake.denied': 'モーションセンサーの許可が得られませんでした。iPhone：設定 → Safari → モーションと画面の向きのアクセス をオンにしてから、このスイッチをもう一度オンにしてください。',
    'shake.unsupported': 'このブラウザはモーションセンサーに対応していません。', 'shake.needsPermission': 'iPhoneでは許可が必要です：画面のどこかをタップすると「モーションと画面の向き」の確認が表示されます。',
    'shake.detected': '✓ 振りを検出しました！', 'shake.announce': '振りを検出。質問を開始します', 'shake.deniedToast': 'モーションセンサーの許可が得られなかったため、振って質問はオンになりませんでした。',

    'banner.noTts': 'このブラウザは音声読み上げに対応していません。ChromeまたはSafariをお使いください。', 'banner.offline': 'サーバーに接続できないため、AIへの質問は一時的に使えません（読み上げは動作します）。',
    'banner.noAi': 'AIが未設定です：サーバーの .env に ANTHROPIC_API_KEY を設定してください（OpenAIを使う場合は AI_PROVIDER=openai と OPENAI_API_KEY。READMEを参照）。読み上げには影響しません。', 'banner.needToken': 'サーバーにアクセスパスワードが必要です：「設定」で入力してください。',
    'toast.blocked': 'ブラウザが自動再生をブロックしました。もう一度「再生」をタップしてください。', 'toast.ttsError': '音声読み上げで問題が発生しました（{detail}）。設定で別の声を試してください。',
    'toast.cloudFallback': 'クラウド音声認識が未設定のため、今回は端末内蔵の認識を使います。',
    'toast.micDenied': 'マイクの許可が拒否されました。アドレスバー横のサイト設定でマイクを許可するか、「⌨ 入力」を使ってください。',
    'toast.sttFailed': '音声認識に失敗しました（{err}）。「⌨ 入力」もお使いいただけます。', 'toast.sttError': '音声認識でエラーが発生しました', 'toast.aiError': 'AIでエラーが発生しました',
    'say.micDenied': 'マイクの許可がありません。ブラウザの設定で許可してください。', 'say.sttFailed': '音声認識がうまくいきませんでした。',
    'say.stt.402': '音声認識アカウントのクレジットが尽きました。提供元の請求ページでチャージしてください。', 'say.stt.429': '音声認識が混み合っています。しばらくしてからもう一度質問してください。', 'say.stt.503': 'クラウド音声認識がまだ設定されていません。',
    'say.stt.400': 'この録音は認識できませんでした。もう一度話してください。', 'say.stt.401': 'アクセスパスワードに問題があります。設定で確認してください。', 'say.stt.default': '音声認識サービスに接続できません。しばらくしてからもう一度お試しください。',
    'say.offline': '現在ネットワークに接続されていません。', 'say.serverOffline': '現在サーバーに接続できません。', 'say.aiNotReady': 'AIがまだ設定されていません。', 'say.contextError': 'コンテキストの準備中に問題が発生しました。',
    'say.refusal': 'すみません、その質問には答えられません。', 'say.empty': '答えが思いつきませんでした。',
    'say.ai.402': 'AIアカウントのクレジットが尽きました。提供元の請求ページでチャージしてください。', 'say.ai.401': 'AIのキーまたはアクセスパスワードに問題があります。', 'say.ai.429': 'AIが混み合っています。しばらくしてからもう一度質問してください。', 'say.ai.default': '現在AIは回答できません。しばらくしてからもう一度お試しください。',

    'part.n': '第{n}部', 'section.n': '第{n}節',
    'err.loadComponent': 'コンポーネントを読み込めません：{url}', 'err.xml': 'ファイル内のXMLの形式に問題があります', 'err.empty': 'このファイルは空です。', 'err.noReadable': 'このファイルには読み上げられるテキストが見つかりません。',
    'err.noTextIn': 'この{kind}ファイルにテキストが見つかりません', 'err.invalidFile': '有効な{kind}ファイルではありません',
    'err.mobi': 'MOBI / AZW形式は未対応です。Calibreなどのツールで先にEPUBに変換してから取り込んでください。', 'err.azw3': 'AZW3形式は未対応です。Calibreなどのツールで先にEPUBに変換してから取り込んでください。',
    'err.kfx': 'KFX形式は未対応です。先にEPUBに変換してから取り込んでください。', 'err.doc': '旧形式のWord（.doc）は未対応です。Wordで.docxとして保存してから取り込んでください。',
    'err.presentation': 'プレゼンテーションファイルには対応していません。', 'err.spreadsheet': 'スプレッドシートには対応していません。', 'err.zip': '圧縮ファイルではなく、EPUB / PDF / テキストファイルそのものを選んでください。', 'err.rar': '先に展開してから取り込んでください。',
    'err.audio': '音声ファイルです。このアプリはテキストの本を読み上げるためのものです。', 'err.zipUnknown': 'この圧縮ファイルの内容を認識できません。',
    'err.drm': 'この電子書籍はDRMで保護されており、読み込めません。DRMのないバージョンをお使いください。', 'err.epubContainer': '有効なEPUBではありません（container.xmlが見つかりません）', 'err.epubOpf': 'EPUBにOPFファイルがありません',
    'err.pdfPassword': 'このPDFはパスワードで保護されており、読み込めません。', 'err.pdfOpen': 'PDFを開けません：{msg}',
    'err.pdfScanned': 'このPDFには選択できるテキストがほとんどなく、スキャン画像の可能性があります。OCRは未対応です。テキスト層のあるバージョンをお使いください（または先にOCRツールで変換してください）。',
    'warn.pdfGarbled': 'このPDFのテキストは文字化けしているようです（中国語フォントがファイルに埋め込まれていない可能性があります）。EPUBなど別のバージョンを使うか、他のソフトでテキストファイルに変換してから取り込んでください。',
    'progress.readingFile': 'ファイルを読み込み中', 'progress.chapter': '章を読み込み中 {i}/{n}', 'progress.pdfPage': 'PDFを読み込み中 {p}/{n}ページ', 'progress.chapters': 'チャプターを整理中',
  },
};

let current = 'zh';
export const getLang = () => current;
export const isLang = (code) => Object.prototype.hasOwnProperty.call(STRINGS, code);
export function setLang(code) { current = isLang(code) ? code : 'zh'; return current; }

/** `lang` may be a full BCP-47 tag ("ja-JP"); anything unsupported means "the current language". */
export function tIn(lang, key, params) {
  const code = String(lang || '').toLowerCase().split('-')[0];
  const table = STRINGS[code] ? code : current;
  let s = STRINGS[table]?.[key] ?? STRINGS.zh[key];
  if (s === undefined) return key;
  if (typeof s === 'function') return s(params || {});
  return params ? s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? '')) : s;
}

export const t = (key, params) => tIn(current, key, params);

/** Fill every marked element of the document with the current language. */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.setAttribute('placeholder', t(el.dataset.i18nPh));
  const lang = LANGS.find((l) => l.code === current);
  document.documentElement.lang = lang?.html || 'zh-Hant';
  document.title = t('app.title');
  const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (appleTitle) appleTitle.setAttribute('content', t('app.title'));
}
