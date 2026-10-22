#!/usr/bin/env python3
"""Local/preview static server for RegisterBook.

The production site lives at https://mahicouragw.github.io/Register-book/, so
people naturally open the preview with a "/Register-book/" path. Plain
`python -m http.server` answers 404 there. This server serves the same files at:

    /                        (root)
    /index.html
    /Register-book/          (path prefix stripped)
    /Register-book/index.html
    /<any-prefix>/app.js ... (prefix stripped, so relative assets work)

It is a development helper only — GitHub Pages serves the static files directly.
"""
import os
import posixpath
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREFIXES = ("/Register-book",)


def normalize(path):
    """Strip a /Register-book prefix so the app also works under that path."""
    for prefix in PREFIXES:
        if path == prefix or path.startswith(prefix + "/"):
            path = path[len(prefix):] or "/"
            break
    return path


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        clean = unquote(urlsplit(path).path)
        clean = normalize(clean)
        clean = posixpath.normpath(clean)
        parts = [p for p in clean.split("/") if p and p not in (".", "..")]
        full = os.path.join(ROOT, *parts)
        if os.path.isdir(full) and not clean.endswith("/"):
            # keep directory handling predictable
            return full
        return full

    def do_GET(self):
        self._serve(head_only=False)

    def do_HEAD(self):
        self._serve(head_only=True)

    def _serve(self, head_only):
        raw = urlsplit(self.path).path
        clean = normalize(unquote(raw))
        target = self.translate_path(raw)
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target) and clean in ("/", ""):
            target = os.path.join(ROOT, "index.html")
        if not os.path.isfile(target):
            body = (
                "<!doctype html><meta charset='utf-8'>"
                "<title>404 — RegisterBook preview</title>"
                "<div style=\"font-family:system-ui;padding:28px;max-width:620px;margin:auto\">"
                "<h2>404 — that file is not here</h2>"
                "<p>Open the app at the <b>root</b> of this preview:</p>"
                "<p><a href=\"/\">/</a> or <a href=\"/Register-book/\">/Register-book/</a></p>"
                f"<p style='color:#6b7280;font-size:13px'>Requested: <code>{raw}</code></p>"
                "</div>"
            ).encode("utf-8")
            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)
            return
        rel = os.path.relpath(target, ROOT)
        self.path = "/" + rel.replace(os.sep, "/")
        super().do_HEAD() if head_only else super().do_GET()

    def end_headers(self):
        # the Arena preview embeds the page in an iframe
        self.send_header("X-Frame-Options", "ALLOWALL")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"RegisterBook preview on http://0.0.0.0:{port}/ (also /Register-book/)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
