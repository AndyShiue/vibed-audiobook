"""Builds sample books in every supported format into ./fixtures (dev/testing tool).

The story deliberately ends with a 'spoiler' sentence containing the marker 管家老周 — tests check it
never reaches the AI while the listener is earlier in the book.

    python scripts/make-fixtures.py          (PDF output needs `pip install reportlab`)
"""
import random, zipfile, io, os, sys, textwrap

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fixtures')
os.makedirs(OUT, exist_ok=True)
random.seed(7)

TITLE = '失蹤的懷錶'
AUTHOR = '測試作者'
SPOILER = '真相大白：偷走懷錶的兇手其實就是管家老周，他在第一天晚上就把它藏進了鐘樓。'

NAMES = ['林曉晴', '陳志遠', '老周', '艾莉絲', '王大明', '蘇太太']
PLACES = ['老茶館', '港口', '山腳下的鐘樓', '北門市場', '舊書店', '海邊的燈塔']
OBJECTS = ['銅製懷錶', '藍色信封', '泛黃的地圖', '生鏽的鑰匙', '黑皮筆記本']
ACTS = ['低聲說著', '皺起眉頭', '沉默了很久', '把茶杯放回桌上', '望向窗外', '輕輕嘆了一口氣']
EARLY = [
    '清晨的霧還沒有散，林曉晴推開老茶館的木門，聞到一股熟悉的桂花香。',
    '她的祖父上個月過世了，留下的遺物只有一只銅製懷錶，而懷錶如今不見了。',
    '「你確定昨晚最後一個離開的人是老周嗎？」陳志遠壓低聲音問道。',
    '曉晴點點頭，卻又搖了搖頭。她記得老周提著燈走向鐘樓，但那只是她的印象。',
    '「不積跬步，無以至千里」，祖父生前最愛掛在嘴邊的這句話，如今被刻在懷錶的背面。',
]


def paragraph(ch, k):
    n = random.sample(NAMES, 2)
    p = random.choice(PLACES)
    o = random.choice(OBJECTS)
    a = random.choice(ACTS)
    s = [
        f'第{ch}章的第{k}個下午，{n[0]}在{p}遇見了{n[1]}，兩人為了那只{o}爭論不休。',
        f'{n[1]}{a}，說他昨天晚上什麼也沒有看見。',
        f'{n[0]}並不相信，她想起祖父曾經說過，真正重要的東西往往就藏在最不起眼的地方。',
        f'窗外下起了細雨，雨聲敲在屋簷上，讓整個房間顯得更加安靜。',
    ]
    return ''.join(s[: random.randint(3, 4)])


def build():
    chapters = []
    for ch in range(1, 11):
        paras = []
        if ch == 1:
            paras += EARLY
        for k in range(1, 15):
            paras.append(paragraph(ch, k))
        if ch == 10:
            paras.append(SPOILER)
        chapters.append((f'第{ch}章　{["霧中茶館","消失的懷錶","夜半鐘聲","陌生的來信","港口的秘密","老周的沉默","地圖上的記號","暴雨之前","鐘樓頂端","真相"][ch-1]}', paras))
    return chapters


CH = build()
ALL_TEXT = '\n\n'.join(t + '\n\n' + '\n\n'.join(p) for t, p in CH)


def w(name, data, mode='wb'):
    with open(os.path.join(OUT, name), mode) as f:
        f.write(data)


# ---------------------------------------------------------------- txt / md / html / rtf
w('novel-zh.txt', f'{TITLE}\n\n' + ALL_TEXT, 'wb') if False else w('novel-zh.txt', (f'{TITLE}\n\n' + ALL_TEXT).encode('utf-8'))
w('novel-zh-big5.txt', (f'{TITLE}\n\n' + ALL_TEXT).encode('big5', errors='ignore'))
w('novel-zh.md', ((f'# {TITLE}\n\n' + '\n\n'.join(f'## {t}\n\n' + '\n\n'.join(p) for t, p in CH)).encode('utf-8')))
html = f'<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>{TITLE}</title></head><body><h1>{TITLE}</h1>' + ''.join(
    f'<h2>{t}</h2>' + ''.join(f'<p>{x}</p>' for x in p) for t, p in CH) + '</body></html>'
w('novel-zh.html', html.encode('utf-8'))


def rtf_escape(s):
    return ''.join(c if ord(c) < 128 and c not in '\\{}' else ('\\u%d?' % (ord(c) if ord(c) < 32768 else ord(c) - 65536)) if ord(c) >= 128 else '\\' + c for c in s)


rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\n' + ''.join(f'\\pard {rtf_escape(t)}\\par\n' + ''.join(f'\\pard {rtf_escape(x)}\\par\n' for x in p) for t, p in CH) + '}'
w('novel-zh.rtf', rtf.encode('ascii'))

# English plain text (hard-wrapped, Gutenberg style)
EN = [
    ('CHAPTER I. The Tea House', ['The morning fog had not yet lifted when Lin pushed open the door of the old tea house. Mr. Chen was already waiting inside, and he did not look up.',
                                  '"Was it Zhou who locked up last night?" he asked quietly. Lin nodded, then shook her head. She remembered a lantern moving toward the clock tower, but that was all.']),
    ('CHAPTER II. The Missing Watch', ['Her grandfather had died the month before, leaving only a brass pocket watch. Now the watch was gone.',
                                       'It was 3.5 miles to the harbour, and the rain had started again. Dr. Alice Wang met them at the door.']),
    ('CHAPTER III. The Truth', ['The culprit was the butler, Zhou. He had hidden the watch in the clock tower on the very first night.']),
]
en = 'THE MISSING WATCH\n\n' + '\n\n'.join(t + '\n\n' + '\n\n'.join(textwrap.fill(x, 70) for x in p) for t, p in EN)
w('novel-en.txt', en.encode('utf-8'))

# ---------------------------------------------------------------- EPUB
def make_epub(path):
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        items, spine, nav = [], [], []
        for i, (t, p) in enumerate(CH, 1):
            body = f'<h2>{t}</h2>' + ''.join(f'<p>{x}</p>' for x in p)
            if i == 2:
                body = body.replace('老周', '<ruby>老周<rt>lǎo zhōu</rt></ruby>', 1) + '<p><sup>1</sup></p>'
            z.writestr(f'OEBPS/text/ch{i:02d}.xhtml', f'<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>{t}</title></head><body>{body}</body></html>')
            items.append(f'<item id="c{i}" href="text/ch{i:02d}.xhtml" media-type="application/xhtml+xml"/>')
            spine.append(f'<itemref idref="c{i}"/>')
            nav.append(f'<li><a href="text/ch{i:02d}.xhtml">{t}</a></li>')
        z.writestr('OEBPS/cover.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><img src="c.png" alt=""/></body></html>')
        items.insert(0, '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>')
        spine.insert(0, '<itemref idref="cover"/>')
        z.writestr('OEBPS/nav.xhtml', f'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>{"".join(nav)}</ol></nav></body></html>')
        z.writestr('OEBPS/content.opf', f'<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:1234</dc:identifier><dc:title>{TITLE}</dc:title><dc:creator>{AUTHOR}</dc:creator><dc:language>zh-Hant</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>{"".join(items)}</manifest><spine>{"".join(spine)}</spine></package>')


make_epub(os.path.join(OUT, 'novel-zh.epub'))

# ---------------------------------------------------------------- DOCX / ODT / FB2
def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def make_docx(path):
    body = f'<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>{TITLE}</w:t></w:r></w:p>'
    for t, p in CH:
        body += f'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>{esc(t)}</w:t></w:r></w:p>'
        body += ''.join(f'<w:p><w:r><w:t>{esc(x)}</w:t></w:r></w:p>' for x in p)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
        z.writestr('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
        z.writestr('word/styles.xml', '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>')
        z.writestr('word/document.xml', f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>')


def make_odt(path):
    body = ''.join(f'<text:h text:outline-level="1">{esc(t)}</text:h>' + ''.join(f'<text:p>{esc(x)}</text:p>' for x in p) for t, p in CH)
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('mimetype', 'application/vnd.oasis.opendocument.text', compress_type=zipfile.ZIP_STORED)
        z.writestr('content.xml', f'<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>{body}</office:text></office:body></office:document-content>')
        z.writestr('meta.xml', f'<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>{TITLE}</dc:title><dc:creator>{AUTHOR}</dc:creator><dc:language>zh-TW</dc:language></office:meta></office:document-meta>')


def make_fb2(path):
    secs = ''.join(f'<section><title><p>{esc(t)}</p></title>' + ''.join(f'<p>{esc(x)}</p>' for x in p) + '</section>' for t, p in CH)
    xml = f'<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><author><first-name>測試</first-name><last-name>作者</last-name></author><book-title>{TITLE}</book-title><lang>zh</lang></title-info></description><body>{secs}</body></FictionBook>'
    with open(path, 'wb') as f:
        f.write(xml.encode('utf-8'))


make_docx(os.path.join(OUT, 'novel-zh.docx'))
make_odt(os.path.join(OUT, 'novel-zh.odt'))
make_fb2(os.path.join(OUT, 'novel-zh.fb2'))

# ---------------------------------------------------------------- PDF (Traditional Chinese)
def build_pdf(path, font_name):
    from reportlab.lib.pagesizes import A5
    from reportlab.platypus import BaseDocTemplate, PageTemplate, Frame, Paragraph, PageBreak
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus.flowables import Flowable

    body = ParagraphStyle('b', fontName=font_name, fontSize=11, leading=19, wordWrap='CJK', firstLineIndent=22, spaceAfter=3)
    head = ParagraphStyle('h', fontName=font_name, fontSize=19, leading=28, wordWrap='CJK', spaceAfter=14)

    class Bookmark(Flowable):
        def __init__(self, key, title):
            super().__init__(); self.key, self.title = key, title
        def wrap(self, *a): return (0, 0)
        def draw(self):
            self.canv.bookmarkPage(self.key)
            self.canv.addOutlineEntry(self.title, self.key, 0, 0)

    def deco(canv, doc):
        canv.saveState()
        canv.setFont(font_name, 8)
        canv.drawCentredString(A5[0] / 2, A5[1] - 24, TITLE)
        canv.drawCentredString(A5[0] / 2, 22, f'第 {doc.page} 頁')
        canv.restoreState()

    doc = BaseDocTemplate(path, pagesize=A5, title=TITLE, author=AUTHOR)
    doc.addPageTemplates([PageTemplate(id='p', frames=[Frame(36, 40, A5[0] - 72, A5[1] - 84)], onPage=deco)])
    story = []
    for i, (t, p) in enumerate(CH):
        story += [Bookmark(f'c{i}', t), Paragraph(esc(t), head)] + [Paragraph(esc(x), body) for x in p] + [PageBreak()]
    doc.build(story)


try:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfbase.ttfonts import TTFont

    # (a) embedded TrueType font — what almost every real-world CJK PDF looks like
    ttf = os.environ.get('CJK_TTF', 'C:/Windows/Fonts/msjh.ttc')
    if os.path.exists(ttf):
        pdfmetrics.registerFont(TTFont('CJK', ttf, subfontIndex=0))
        build_pdf(os.path.join(OUT, 'novel-zh.pdf'), 'CJK')
        print('PDF (embedded font) written')
    else:
        print('no CJK TrueType font found (set CJK_TTF) - skipping embedded PDF')
    # (b) non-embedded CID font (relies on the viewer's CMaps) — an edge case worth keeping around
    pdfmetrics.registerFont(UnicodeCIDFont('MSung-Light'))
    build_pdf(os.path.join(OUT, 'novel-zh-cid.pdf'), 'MSung-Light')
    print('PDF (CID font) written')
except ImportError:
    print('reportlab not installed - skipping PDF fixtures')

print('fixtures written to', os.path.abspath(OUT))
for f in sorted(os.listdir(OUT)):
    print('  ', f, os.path.getsize(os.path.join(OUT, f)))
