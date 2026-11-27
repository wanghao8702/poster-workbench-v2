"""Subset Alibaba PuHuiTi 3.0 to the characters the workbench shows, as woff2, into static/fonts/.

Run again when interface text gains characters outside GB2312 level 1. Development tool only: it needs
fontTools and brotli (pip install fonttools brotli); the app itself still uses the standard library.

usage: python tools/subset_fonts.py <folder with the AlibabaPuHuiTi-3-*.otf files> [project dir]"""
import json, os, re, sys
from fontTools import subset
from fontTools.ttLib import TTFont

src = sys.argv[1]
project = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out_dir = os.path.join(project, 'static', 'fonts')
os.makedirs(out_dir, exist_ok=True)

# 1. GB2312 level 1: the 3,755 most common characters (rows 0xB0-0xD7).
chars = set()
for hi in range(0xB0, 0xD8):
    for lo in range(0xA1, 0xFF):
        try: chars.add(bytes([hi, lo]).decode('gb2312'))
        except UnicodeDecodeError: pass
level1 = len(chars)
# 2. ASCII, Latin-1 punctuation, CJK punctuation, full-width forms, general punctuation and arrows/math used in the UI.
for a, b in [(0x20, 0x7E), (0xA0, 0xFF), (0x2000, 0x206F), (0x2190, 0x21FF), (0x2212, 0x2212), (0x3000, 0x303F), (0xFF00, 0xFFEF), (0x2460, 0x2473)]:
    chars.update(chr(c) for c in range(a, b + 1))
# 3. Everything the interface itself can show: page, scripts (labels, messages, prompt templates) and the cover style library.
ui = set()
for name in ['index.html', 'app.js', 'editor.js', 'editor-panel.js', 'editor-core.js', 'training-form.js', 'training-prompt.js', 'punk-cover.js', 'punk-styles.json', 'config.js']:
    p = os.path.join(project, 'static', name)
    if os.path.exists(p):
        ui.update(re.findall(r'[　-鿿＀-￯]', open(p, encoding='utf-8').read()))
extra = ui - chars
chars |= ui
text = ''.join(sorted(chars))
print(f'GB2312 level 1: {level1}; extra from the UI: {len(extra)}; total code points: {len(chars)}')

def make(font_file, out_name, text):
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['*']      # keep kerning, proportional punctuation etc.
    opts.name_IDs = ['*']             # keep the copyright and licence records in the font
    opts.name_languages = ['*']
    opts.hinting = False
    opts.desubroutinize = True
    f = TTFont(os.path.join(src, font_file))
    s = subset.Subsetter(opts); s.populate(text=text); s.subset(f)
    out = os.path.join(out_dir, out_name)
    f.flavor = 'woff2'; f.save(out)
    missing = [c for c in text if ord(c) not in f.getBestCmap()]
    print(f'{out_name}: {os.path.getsize(out)//1024} KB, glyphs for {len(f.getBestCmap())} code points, {len(missing)} requested not in font')

make('AlibabaPuHuiTi-3-55-Regular.otf', 'PuHuiTi-Regular.woff2', text)
make('AlibabaPuHuiTi-3-65-Medium.otf', 'PuHuiTi-Medium.woff2', text)
make('AlibabaPuHuiTi-3-85-Bold.otf', 'PuHuiTi-Bold.woff2', text)
make('AlibabaPuHuiTi-3-105-Heavy.otf', 'PuHuiTi-Heavy-brand.woff2', 'p.V2')
