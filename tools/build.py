"""
Builds single-file versions of the dashboard from index.html and assets/.

    python3 tools/build.py            -> dist/havlena-odeh-analyzer.html (everything inline, works offline)
    python3 tools/build.py --preview  -> dist/preview.html (libraries from cdnjs, downloads hidden;
                                         used for the hosted preview page)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
APP_JS = ["units.js", "xlsxio.js", "parser.js", "mbe.js", "charts.js", "app.js"]
VENDOR = [
    ("d3.v7.9.0.min.js", "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"),
    ("jszip.v3.10.1.min.js", "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"),
]


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def between(text, start, end):
    i, j = text.index(start), text.index(end)
    return text[i + len(start):j]


def script(code):
    # keep "</script" inside the code from closing the tag
    return "<script>\n" + code.replace("</script", "<\\/script") + "\n</script>"


def build(preview):
    html = read("index.html")
    body = between(html, "<!--BODY-START-->", "<!--BODY-END-->").strip()
    head = between(html, "<head>", "</head>")
    title = re.search(r"<title>.*?</title>", head, re.S).group(0)
    desc = re.search(r'<meta name="description"[^>]*>', head).group(0)
    icon = re.search(r'<link rel="icon"[^>]*>', head).group(0)
    fonts = "\n".join(re.findall(r'<link rel="(?:preconnect|stylesheet)" href="https://fonts[^>]*>', head))
    css = read("assets", "css", "styles.css")
    app = "\n".join(script(read("assets", "js", f)) for f in APP_JS)

    if preview:
        libs = "\n".join('<script src="%s"></script>' % url for _, url in VENDOR)
        parts = [
            title,
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
            '<meta name="claude:viewport-fit-sides" content="cover">',
            desc, icon, fonts,
            "<style>\n" + css + "\n</style>",
            body,
            libs,
            script("window.HO_PREVIEW = true;"),
            app,
        ]
        return "\n".join(parts) + "\n"

    libs = "\n".join(script(read("assets", "vendor", name)) for name, _ in VENDOR)
    return "\n".join([
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
        title, desc, icon, fonts,
        "<style>\n" + css + "\n</style>",
        "</head>",
        "<body>",
        body,
        libs,
        app,
        "</body>",
        "</html>",
    ]) + "\n"


def main():
    os.makedirs(DIST, exist_ok=True)
    preview = "--preview" in sys.argv
    name = "preview.html" if preview else "havlena-odeh-analyzer.html"
    out = os.path.join(DIST, name)
    with open(out, "w", encoding="utf-8") as f:
        f.write(build(preview))
    print("wrote %s (%.0f KB)" % (os.path.relpath(out, ROOT), os.path.getsize(out) / 1024))


if __name__ == "__main__":
    main()
