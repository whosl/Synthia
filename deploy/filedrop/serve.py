#!/usr/bin/env python3
"""
filedrop —— download.wenzhuolin.xyz 的双向文件服务（单文件，零依赖，Python 3.8+）。

  GET  /                自定义目录列表 + 上传界面（浏览器直接拖拽/选文件）
  GET  /<file>          下载（沿用 SimpleHTTPRequestHandler 语义：子目录、Range 均支持）
  POST /upload          上传：body=文件原始字节，头 X-Filename=名字（URL 编码）

访问控制：环境变量 FILEDROP_KEY 设置后，所有请求需带 ?k=<key>（或头 X-Access-Key）。
          目录里若有敏感文件（token/env），必须设 key。
覆盖策略：默认拒绝覆盖已存在文件（409）；POST 头 X-Overwrite: 1 允许覆盖。
限制：MAX_BYTES（默认 500MB）；文件名 basename 化，路径穿越直接 400。

用法：FILEDROP_KEY=<密钥> python3 serve.py <目录> [端口] [绑定地址]
"""
import html
import json
import os
import sys
import unicodedata
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse, parse_qs

ROOT = os.path.realpath(sys.argv[1] if len(sys.argv) > 1 else ".")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
BIND = sys.argv[3] if len(sys.argv) > 3 else "0.0.0.0"
KEY = os.environ.get("FILEDROP_KEY", "")
MAX_BYTES = int(os.environ.get("FILEDROP_MAX_BYTES", 500 * 1024 * 1024))

PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>filedrop</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;background:#0f1115;color:#e6e6e6}
 h1{font-size:1.2rem} a{color:#7ab0ff;text-decoration:none} a:hover{text-decoration:underline}
 table{width:100%;border-collapse:collapse}td{padding:.35rem .5rem;border-bottom:1px solid #22262e}
 td.sz{text-align:right;color:#888;white-space:nowrap}
 #drop{margin:1rem 0;padding:1.4rem;border:2px dashed #3a4150;border-radius:10px;text-align:center;color:#9aa3b1}
 #drop.on{border-color:#7ab0ff;color:#cfe0ff;background:#141a24}
 #bar{font-size:.85rem;color:#9aa3b1;margin-top:.5rem;white-space:pre-wrap}
 button{background:#24437a;color:#fff;border:0;border-radius:6px;padding:.45rem 1rem;cursor:pointer}
</style></head><body>
<h1>filedrop</h1>
<div id="drop">拖拽文件到此处，或 <button onclick="pick()">选择文件</button> 上传到服务器</div>
<div id="bar"></div>
<table id="list"><tbody></tbody></table>
<input type="file" id="f" multiple hidden>
<script>
const KEY = new URLSearchParams(location.search).get("k") || "";
const BASE = location.pathname.replace(/\\/$/, "");
async function refresh(){
  const rows = await (await fetch(BASE + "/list.json" + (KEY ? "?k=" + KEY : ""))).json();
  document.querySelector("#list tbody").innerHTML = rows.map(f =>
    `<tr><td><a href="${BASE}/${f.name}${KEY ? "?k=" + KEY : ""}">${f.name}</a></td>` +
    `<td class="sz">${f.size}</td></tr>`).join("");
}
function pick(){ document.getElementById("f").click(); }
async function upload(file){
  const bar = document.getElementById("bar");
  bar.textContent = `上传 ${file.name} …`;
  const r = await fetch(BASE + "/upload" + (KEY ? "?k=" + KEY : ""), {
    method: "POST",
    headers: { "X-Filename": encodeURIComponent(file.name), "X-Overwrite": "0" },
    body: file,
  });
  const t = await r.text();
  bar.textContent = `${r.status == 201 ? "✓" : "✗"} ${file.name} → ${t}\n` + bar.textContent;
  refresh();
}
document.getElementById("f").onchange = e => { for (const f of e.target.files) upload(f); };
const drop = document.getElementById("drop");
drop.ondragover = e => { e.preventDefault(); drop.classList.add("on"); };
drop.ondragleave = () => drop.classList.remove("on");
drop.ondrop = e => { e.preventDefault(); drop.classList.remove("on");
  for (const f of e.dataTransfer.files) upload(f); };
refresh();
</script></body></html>
"""


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n/1024:.1f}{unit}"
        n /= 1024
    return f"{n}B"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---- access control -------------------------------------------------------
    def _authorized(self) -> bool:
        if not KEY:
            return True
        query = parse_qs(urlparse(self.path).query)
        supplied = query.get("k", [""])[0] or self.headers.get("X-Access-Key", "")
        return supplied == KEY

    def _reject(self, code: int, message: str) -> None:
        body = json.dumps({"error": message}, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- GET ------------------------------------------------------------------
    def do_GET(self):  # noqa: N802
        if not self._authorized():
            self._reject(401, "unauthorized")
            return
        path = urlparse(self.path).path
        if path.rstrip("/") == "" or path == "/index.html":
            self._page()
            return
        if path == "/list.json":
            self._list()
            return
        super().do_GET()

    def _page(self) -> None:
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _list(self) -> None:
        entries = []
        try:
            for name in sorted(os.listdir(ROOT)):
                target = os.path.join(ROOT, name)
                if os.path.isfile(target):
                    entries.append({"name": name, "size": human(os.path.getsize(target))})
        except OSError:
            pass
        body = json.dumps(entries, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- POST /upload ----------------------------------------------------------
    def do_POST(self):  # noqa: N802
        if not self._authorized():
            self._reject(401, "unauthorized")
            return
        if urlparse(self.path).path != "/upload":
            self._reject(404, "unknown path")
            return
        raw_name = self.headers.get("X-Filename", "")
        decoded = unquote(raw_name)
        # 先拒后收：原始名含路径成分直接 400（basename 兜底只是第二道防线）
        if not decoded or "/" in decoded or "\\" in decoded or "\x00" in decoded:
            self._reject(400, "invalid filename")
            return
        name = os.path.basename(unicodedata.normalize("NFC", decoded))
        if not name or name in {".", ".."}:
            self._reject(400, "invalid filename")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._reject(400, "invalid length")
            return
        if length <= 0:
            self._reject(400, "empty body")
            return
        if length > MAX_BYTES:
            self._reject(413, f"too large (max {human(MAX_BYTES)})")
            return
        target = os.path.join(ROOT, name)
        overwrite = self.headers.get("X-Overwrite", "0") == "1"
        if os.path.exists(target) and not overwrite:
            self._reject(409, "exists (X-Overwrite: 1 to replace)")
            return
        remaining = length
        with open(target + ".part", "wb") as out:
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1024 * 1024))
                if not chunk:
                    break
                out.write(chunk)
                remaining -= len(chunk)
        if remaining != 0:
            os.unlink(target + ".part")
            self._reject(400, "truncated body")
            return
        os.replace(target + ".part", target)
        body = json.dumps({"saved": name, "size": human(length)}, ensure_ascii=False).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    os.makedirs(ROOT, exist_ok=True)
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"filedrop on http://{BIND}:{PORT} root={ROOT} key={'on' if KEY else 'OFF'}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
