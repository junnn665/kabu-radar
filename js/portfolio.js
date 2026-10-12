// 保有株の集計：配当の見込み・偏り・予定カレンダー（画面に依存しない計算だけ）

export const TAX = 0.20315; // 特定口座の配当課税（所得税＋住民税＋復興特別所得税）

const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

// 過去12か月の配当実績（1株あたり）を、そのまま来年も出ると仮定して見込みを出す
// divs: { sym: [[権利落ち日, 1株配当], ...] }
export function dividendPlan(holdings, divs, today) {
  // 少し長め（400日）に取って、同じ月の配当は新しい方だけ使う（今年の分がまだ反映されていなくても去年の分で補う）
  const since = addDays(today, -400);
  const months = Array(12).fill(0);
  const rows = [];
  for (const h of holdings) {
    const byMonth = {};
    for (const [d, a] of divs?.[h.sym] || []) {
      if (d <= since || d > today) continue;
      const m = d.slice(5, 7);
      if (!byMonth[m] || byMonth[m][0] < d) byMonth[m] = [d, a];
    }
    const hist = Object.values(byMonth);
    const perShare = hist.reduce((s, [, a]) => s + a, 0);
    if (!perShare) { rows.push({ sym: h.sym, perShare: 0, annual: 0, months: [], yieldOnCost: null }); continue; }
    const annual = perShare * h.shares;
    const ms = [];
    for (const [d, a] of hist) {
      const m = Number(d.slice(5, 7)) - 1;
      months[m] += a * h.shares;
      ms.push(m + 1);
    }
    rows.push({ sym: h.sym, perShare, annual, months: [...new Set(ms)].sort((a, b) => a - b), yieldOnCost: h.cost > 0 ? perShare / h.cost : null });
  }
  const total = rows.reduce((s, r) => s + r.annual, 0);
  return { rows: rows.sort((a, b) => b.annual - a.annual), months, total, afterTax: total * (1 - TAX) };
}

// 偏り：業種ごと・銘柄ごとの評価額の割合
// items: [{ sym, value, sector }]
export function concentration(items, { sectorMax = 0.4, stockMax = 0.3 } = {}) {
  const valued = items.filter((x) => x.value > 0);
  const total = valued.reduce((s, x) => s + x.value, 0);
  if (!total) return { total: 0, sectors: [], stocks: [], warns: [] };
  const bySec = {};
  for (const x of valued) bySec[x.sector || 'その他'] = (bySec[x.sector || 'その他'] || 0) + x.value;
  const sectors = Object.entries(bySec).map(([name, v]) => ({ name, value: v, w: v / total })).sort((a, b) => b.w - a.w);
  const stocks = valued.map((x) => ({ sym: x.sym, value: x.value, w: x.value / total })).sort((a, b) => b.w - a.w);
  const warns = [];
  for (const s of sectors) if (s.w > sectorMax && valued.length > 1) warns.push({ kind: 'sector', name: s.name, w: s.w });
  for (const s of stocks) if (s.w > stockMax && stocks.length > 1) warns.push({ kind: 'stock', sym: s.sym, w: s.w });
  // 集中度（HHI）。1銘柄だけなら1、均等にN銘柄なら1/N
  const hhi = stocks.reduce((s, x) => s + x.w * x.w, 0);
  return { total, sectors, stocks, warns, hhi, effectiveN: hhi ? 1 / hhi : 0 };
}

// 予定：決算と権利落ち日を日付順に（今日から days 日先まで）
// list: [{ sym, tag, events: { earnings, exDiv, exDivEstimated } }]
export function upcoming(list, today, days = 60) {
  const end = addDays(today, days);
  const out = [];
  for (const { sym, tag, events: e } of list) {
    if (!e) continue;
    if (e.earnings && e.earnings >= today && e.earnings <= end) out.push({ date: e.earnings, sym, tag, kind: 'earnings' });
    if (e.exDiv && e.exDiv >= today && e.exDiv <= end) out.push({ date: e.exDiv, sym, tag, kind: 'exdiv', estimated: !!e.exDivEstimated });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.sym.localeCompare(b.sym)).map((x) => ({ ...x, days: daysBetween(today, x.date) }));
}
