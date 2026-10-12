// 証券会社の保有証券CSVから「コード・株数・取得単価」を取り出す。
// SBI証券のポートフォリオCSV（Shift_JIS、特定・NISAなど預り区分ごとに見出し行が繰り返される）を主な対象に、
// 楽天証券などの「銘柄コード」「保有数量」「平均取得価額」形式にも対応する。

export function decodeCsv(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
  return new TextDecoder('shift_jis').decode(buf); // SBI証券などは Shift_JIS
}

export function parseCsvText(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

const num = (s) => {
  if (s == null) return NaN;
  const t = String(s).replace(/[,，株円\s]/g, '').replace(/^[+＋]/, '');
  return t === '' || /^-+$/.test(t) ? NaN : Number(t);
};
const CODE = /(?:^|[^0-9A-Z])(\d{3}[0-9A-Z])(?![0-9A-Z])/;

// 戻り値: { holdings: [{ sym, name, shares, cost, account }], skipped }
export function extractHoldings(rows) {
  let cols = null, account = '';
  const out = [];
  let skipped = 0;
  for (const r of rows) {
    const joined = r.join(' ');
    // 見出し行：数量と取得単価（または平均取得価額）の列を探す
    const qi = r.findIndex((c) => /^(数量|保有数量|保有株数|株数|残高数量)/.test(c));
    const ci = r.findIndex((c) => /(取得単価|平均取得価額|平均取得単価|取得価額\(単価\)|取得価格)/.test(c));
    if (qi >= 0 && ci >= 0) {
      const codeCol = r.findIndex((c) => /銘柄コード|^コード/.test(c));
      const nameCol = r.findIndex((c) => /^銘柄/.test(c));
      cols = { qi, ci, codeCol, nameCol };
      continue;
    }
    // 預り区分の見出し（例：「株式（現物/NISA預り（成長投資枠））」）
    if (r.filter(Boolean).length === 1 && /預り|口座|株式/.test(joined)) { account = r.find(Boolean); continue; }
    if (!cols) continue;
    const codeCell = cols.codeCol >= 0 ? r[cols.codeCol] : r[cols.nameCol >= 0 ? cols.nameCol : 0];
    const m = String(codeCell || '').toUpperCase().match(CODE);
    const shares = num(r[cols.qi]), cost = num(r[cols.ci]);
    if (!m || !(shares > 0) || !(cost > 0)) { if (m) skipped++; continue; }
    const name = String(r[cols.nameCol >= 0 ? cols.nameCol : 0] || '').replace(m[1], '').trim();
    out.push({ sym: m[1], name, shares, cost, account });
  }
  // 同じ銘柄が特定とNISAなどに分かれていれば、株数を合計して取得単価を加重平均する
  const merged = new Map();
  for (const h of out) {
    const g = merged.get(h.sym);
    if (!g) merged.set(h.sym, { ...h, accounts: [h.account].filter(Boolean) });
    else {
      const total = g.shares + h.shares;
      g.cost = (g.cost * g.shares + h.cost * h.shares) / total;
      g.shares = total;
      if (h.account) g.accounts.push(h.account);
    }
  }
  return { holdings: [...merged.values()].map((h) => ({ ...h, cost: Math.round(h.cost * 100) / 100 })), skipped };
}
