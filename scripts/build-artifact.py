"""Build dist/artifact.html for publishing as a claude.ai Artifact.

The Artifact host wraps the page in its own <html>/<head>/<body> skeleton, so
this strips those tags and inlines style.css. JS modules are published as
supporting files next to the page (main.js, src/*.js).
"""
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
html = (root / 'index.html').read_text(encoding='utf-8')
css = (root / 'style.css').read_text(encoding='utf-8')

html = re.sub(r'<!doctype html>\s*', '', html, flags=re.I)
html = re.sub(r'</?html[^>]*>\s*', '', html)
html = re.sub(r'</?head>\s*', '', html)
html = re.sub(r'</?body>\s*', '', html)
html = re.sub(r'<meta charset[^>]*>\s*', '', html)
html = re.sub(r'<meta name="viewport"[^>]*>\s*', '', html)
html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + css + '</style>')

out = root / 'dist'
out.mkdir(exist_ok=True)
(out / 'artifact.html').write_text(html, encoding='utf-8')
print('wrote', out / 'artifact.html', len(html), 'chars')
