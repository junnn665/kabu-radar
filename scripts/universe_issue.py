"""Issue のタイトルから対象銘柄（config/universe.json）を追加・削除する。

タイトルの書き方:
  追加: 7011            追加: 7011 三菱重工業       add: COST
  削除: 7011            remove: COST
本文に「名前: ○○」と書けば表示名に使う（省略時は Yahoo Finance の名前）。
結果は GitHub Actions の出力（result, message）で返す。
"""
import json
import os
import re
import sys

import yfinance as yf

PATH = "config/universe.json"


def out(result, message):
    with open(os.environ.get("GITHUB_OUTPUT", "/dev/null"), "a", encoding="utf-8") as f:
        f.write(f"result={result}\n")
        f.write("message<<EOF\n" + message + "\nEOF\n")
    print(result, message)


def to_yf(code):
    # 4桁の数字（または 130A のような英数字4桁）は東証
    if re.fullmatch(r"\d{4}|\d{3}[A-Z]", code):
        return code + ".T", "JP"
    return code, "US"


def main():
    title = os.environ.get("ISSUE_TITLE", "").strip()
    body = os.environ.get("ISSUE_BODY", "") or ""
    m = re.match(r"^\s*(追加|削除|add|remove)\s*[:：]\s*([A-Za-z0-9.\-]+)\s*(.*)$", title, re.I)
    if not m:
        return out("skip", "タイトルが「追加: コード」「削除: コード」の形ではないため処理しませんでした。")
    action = "add" if m.group(1).lower() in ("追加", "add") else "remove"
    code = m.group(2).upper()
    name = m.group(3).strip()
    bm = re.search(r"名前\s*[:：]\s*(.+)", body)
    if bm and bm.group(1).strip():
        name = bm.group(1).strip()

    with open(PATH, encoding="utf-8") as f:
        doc = json.load(f)
    syms = doc["symbols"]
    exists = next((u for u in syms if u["sym"] == code), None)

    if action == "remove":
        if not exists:
            return out("noop", f"{code} は対象銘柄に入っていません。")
        doc["symbols"] = [u for u in syms if u["sym"] != code]
        msg = f"{exists['name']}（{code}）を対象銘柄から外しました。"
    else:
        if exists:
            return out("noop", f"{exists['name']}（{code}）はすでに対象銘柄です。")
        yft, market = to_yf(code)
        t = yf.Ticker(yft)
        hist = t.history(period="1mo")
        if hist.empty:
            return out("error", f"{code}（Yahoo Finance: {yft}）の株価が見つかりませんでした。コードを確認してください。")
        if not name:
            try:
                info = t.info or {}
                name = info.get("shortName") or info.get("longName") or code
            except Exception:  # noqa: BLE001
                name = code
        syms.append({"sym": code, "yf": yft, "name": name, "market": market})
        msg = f"{name}（{code}）を対象銘柄に追加しました。数分後のデータ更新から表示されます。"

    with open(PATH, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    out("changed", msg)


if __name__ == "__main__":
    sys.exit(main())
