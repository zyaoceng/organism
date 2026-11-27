#!/usr/bin/env python3
"""把一篇寫好的文章放上有機體網站的 Research 分頁。

用法（在 repo 根目錄執行）：
  python3 scripts/publish.py --type deep --ticker CRWD --name CrowdStrike \
      --title "CrowdStrike：平台化帶動 ARR 成長" --date 2026-11-23 --source 文章.md

  --type    deep / preview / review
  --ticker  標的代號（多檔用逗號分開，第一個決定資料夾）
  --name    標的名稱（代號第一次出現時需要）
  --source  文章檔：.md（Obsidian 筆記可直接用）或已排版好的 .html
  --assets  圖片所在資料夾（可重複指定；預設找文章旁邊）

做三件事：
  1. 把文章轉成網頁，存到 research/<代號>/<日期>-<類型>.html，圖片複製到同層 img/
  2. 更新 research/reports.json 與 research/reports.js（同一篇重跑會覆蓋，不會重複）
  3. 印出網址。之後 git add / commit / push 才會上線。
需要套件：pip install markdown
"""
import argparse, html, json, re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "research"
TYPES = {"deep": "Deep", "preview": "Preview", "review": "Review"}
ZH = {"Deep": "個股深度", "Preview": "財報前瞻", "Review": "財報檢討"}
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}

PAGE = """<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}｜有機體 ORGANISM</title>
<meta name="description" content="{desc}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@400;700&family=Zen+Antique&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../../assets/article.css?v=2">
</head>
<body>
<header class="bar">
  <a class="mark" href="../../">ORGANISM</a>
  <nav><a href="../">← Research</a></nav>
</header>
<main>
  <p class="meta"><span class="ty">{type}</span><span>{zh}</span><span>{tickers}</span><time>{date}</time></p>
  <h1>{title}</h1>
  <article>
{body}
  </article>
</main>
<footer>© {year} ORGANISM　研究紀錄，非投資建議</footer>
</body>
</html>
"""


def strip_frontmatter(text):
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            return text[end + 4:].lstrip("\n")
    return text


def find_image(name, dirs):
    name = name.split("|")[0].split("#")[0].strip()
    for d in dirs:
        p = d / name
        if p.is_file():
            return p
        hits = [h for h in d.rglob(Path(name).name) if h.is_file()]
        if hits:
            return hits[0]
    return None


def convert_markdown(src, out_dir, asset_dirs):
    import markdown
    text = strip_frontmatter(src.read_text(encoding="utf-8"))
    missing = []

    def place(name):
        p = find_image(name, asset_dirs)
        if not p:
            missing.append(name)
            return None
        (out_dir / "img").mkdir(parents=True, exist_ok=True)
        safe = re.sub(r"[^\w.\-]+", "-", p.name)
        shutil.copy2(p, out_dir / "img" / safe)
        return "img/" + safe

    def embed(m):  # Obsidian ![[圖.png]]
        name = m.group(1)
        if Path(name.split("|")[0]).suffix.lower() not in IMG_EXT:
            return ""
        rel = place(name)
        return f"![]({rel})" if rel else ""

    def std(m):  # ![alt](path)
        alt, path = m.group(1), m.group(2).strip()
        if re.match(r"https?://|data:", path):
            return m.group(0)
        rel = place(path.replace("%20", " "))
        return f"![{alt}]({rel})" if rel else ""

    text = re.sub(r"!\[\[([^\]]+)\]\]", embed, text)
    text = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", std, text)
    text = re.sub(r"\[\[([^\]|]+)\|([^\]]+)\]\]", r"\2", text)  # [[筆記|顯示文字]]
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", text)              # [[筆記]]
    # 文章第一個大標題與頁面標題重複時拿掉
    text = re.sub(r"\A\s*#\s+.+\n", "", text, count=1)
    body = markdown.markdown(text, extensions=["tables", "fenced_code", "sane_lists", "footnotes"])
    body = body.replace("<table>", '<div class="tbl"><table>').replace("</table>", "</table></div>")
    return body, missing


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--type", required=True, choices=TYPES)
    ap.add_argument("--ticker", required=True)
    ap.add_argument("--name", default="")
    ap.add_argument("--title", required=True)
    ap.add_argument("--date", required=True, help="YYYY-MM-DD")
    ap.add_argument("--source", required=True)
    ap.add_argument("--assets", action="append", default=[])
    a = ap.parse_args()

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", a.date):
        sys.exit("日期格式要是 YYYY-MM-DD")
    src = Path(a.source).resolve()
    if not src.is_file():
        sys.exit(f"找不到文章檔：{src}")
    tickers = [t.strip().upper() for t in a.ticker.split(",") if t.strip()]
    typ = TYPES[a.type]
    out_dir = RES / tickers[0]
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{a.date}-{a.type}.html"

    data = json.loads((RES / "reports.json").read_text(encoding="utf-8"))
    if a.name:
        data["tickers"][tickers[0]] = a.name
    missing_names = [t for t in tickers if t not in data["tickers"]]

    if src.suffix.lower() in (".html", ".htm"):
        shutil.copy2(src, out)
        missing = []
    else:
        dirs = [Path(d).resolve() for d in a.assets] + [src.parent]
        body, missing = convert_markdown(src, out_dir, dirs)
        plain = re.sub(r"<[^>]+>", "", body)
        desc = re.sub(r"\s+", " ", plain).strip()[:110]
        out.write_text(PAGE.format(
            title=html.escape(a.title), desc=html.escape(desc), type=typ, zh=ZH[typ],
            tickers=" ".join("#" + t for t in tickers), date=a.date.replace("-", "."),
            body=body, year=a.date[:4]), encoding="utf-8")

    href = out.relative_to(ROOT).as_posix()
    data["reports"] = [r for r in data["reports"] if r["href"] != href]
    data["reports"].append({"type": typ, "date": a.date, "title": a.title, "tickers": tickers, "href": href})
    data["reports"].sort(key=lambda r: r["date"], reverse=True)
    (RES / "reports.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    js = "/* 個人研究文章清單。由 scripts/publish.py 從 reports.json 產生，請勿手改。 */\n"
    js += "const MY_TICKERS = " + json.dumps(data["tickers"], ensure_ascii=False) + ";\n"
    js += "const MY_REPORTS = [\n" + ",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in data["reports"]) + "\n];\n"
    (RES / "reports.js").write_text(js, encoding="utf-8")

    print("已產生：", href)
    print("上線後網址：https://zyaoceng.github.io/organism/" + href)
    for m in missing:
        print("⚠ 找不到圖片，已略過：", m)
    for t in missing_names:
        print(f"⚠ 代號 {t} 還沒有名稱，下次加 --name 補上")


if __name__ == "__main__":
    main()
