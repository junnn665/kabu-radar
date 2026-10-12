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

PATH = "config/universe_extra.json"
PUBLISHED = "prev/universe.json"  # data ブランチにある自動取得の銘柄一覧


def out(result, message):
    with open(os.environ.get("GITHUB_OUTPUT", "/dev/null"), "a", encoding="utf-8") as f:
        f.write(f"result={result}\n")
        f.write("message<<EOF\n" + message + "\nEOF\n")
    print(result, message)


# 東証 → 名証 → 札証 → 福証 の順に探す（Yahoo Finance の接尾辞）
EXCHANGES = [(".T", "東証"), (".N", "名証"), (".S", "札証"), (".F", "福証")]


def to_yf(code):
    """日本株のコード（4桁の数字、または 130A のような英数字4桁）なら候補を返す"""
    if re.fullmatch(r"\d{3}[0-9A-Z]", code):
        return [(code + suf, ex) for suf, ex in EXCHANGES]
    return []


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
    try:
        with open(PUBLISHED, encoding="utf-8") as f:
            listed = next((u for u in json.load(f)["symbols"] if u["sym"] == code), None)
    except (OSError, ValueError, KeyError):
        listed = None
    if listed and action == "add":
        return out("noop", f"{listed['name']}（{code}）はすでに自動取得の対象です（東証上場銘柄はすべて対象）。")
    if listed and action == "remove" and not exists:
        return out("noop", f"{listed['name']}（{code}）は東証上場銘柄なので外せません。ウォッチリストから外してください。")

    if action == "remove":
        if not exists:
            return out("noop", f"{code} は対象銘柄に入っていません。")
        doc["symbols"] = [u for u in syms if u["sym"] != code]
        msg = f"{exists['name']}（{code}）を対象銘柄から外しました。"
    else:
        if exists:
            return out("noop", f"{exists['name']}（{code}）はすでに対象銘柄です。")
        cands = to_yf(code)
        if not cands:
            return out("error", f"{code} は日本株のコード（4桁）ではありません。日本株のみ対応しています。")
        yft = ex = t = None
        for cand, exname in cands:
            tk = yf.Ticker(cand)
            try:
                if not tk.history(period="1mo").empty:
                    yft, ex, t = cand, exname, tk
                    break
            except Exception:  # noqa: BLE001
                continue
        if not yft:
            return out("error", f"{code} の株価が東証・名証・札証・福証のどこでも見つかりませんでした。コードを確認してください。")
        if not name:
            try:
                info = t.info or {}
                name = info.get("shortName") or info.get("longName") or code
            except Exception:  # noqa: BLE001
                name = code
        syms.append({"sym": code, "yf": yft, "name": name, "seg": "X", "exchange": ex})
        msg = f"{name}（{code}・{ex}）を対象銘柄に追加しました。数分後のデータ更新から表示されます。"

    with open(PATH, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    out("changed", msg)


if __name__ == "__main__":
    sys.exit(main())
