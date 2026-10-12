// AI予測の本番答え合わせ。毎日の予測を記録しておき、5営業日後の実際の値動きと比べる。
// （学習時の検証と違い、実際に公開した予測そのものを採点するので「本番でも効いているか」が分かる）

const KEEP_DAYS = 90;

// preds: { sym: [予測(%), 順位] }。順位がある（売買代金1億円以上）銘柄だけ記録する
export function updateLog(log, date, preds) {
  const out = { days: { ...(log?.days || {}) } };
  if (!date || !preds) return out;
  const day = {};
  for (const [s, [p, r]] of Object.entries(preds)) if (r != null && Number.isFinite(p)) day[s] = Math.round(p * 1000) / 1000;
  if (Object.keys(day).length) out.days[date] = day;
  const keep = Object.keys(out.days).sort().slice(-KEEP_DAYS);
  out.days = Object.fromEntries(keep.map((d) => [d, out.days[d]]));
  return out;
}

const rankPct = (vals) => {
  const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(vals.length);
  idx.forEach(([, i], k) => { r[i] = (k + 1) / vals.length; });
  return r;
};

function spearman(a, b) {
  if (a.length < 10) return null;
  const ra = rankPct(a), rb = rankPct(b);
  const n = ra.length, ma = ra.reduce((x, y) => x + y, 0) / n, mb = rb.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (ra[i] - ma) * (rb[i] - mb); saa += (ra[i] - ma) ** 2; sbb += (rb[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// history: { sym: candles[] }, names: { sym: name }
export function evaluateLog(log, history, names = {}, { horizon = 5, topPct = 0.02 } = {}) {
  const idxCache = new Map();
  const indexOf = (s, d) => {
    if (!idxCache.has(s)) idxCache.set(s, new Map((history[s] || []).map((c, i) => [c.date, i])));
    return idxCache.get(s).get(d);
  };
  const days = [];
  const all = { top: [], topWin: [], bottom: [], ic: [] };
  for (const date of Object.keys(log?.days || {}).sort().reverse()) {
    const preds = log.days[date];
    const rows = [];
    let elapsed = null;
    for (const [s, p] of Object.entries(preds)) {
      const cs = history[s];
      const i = indexOf(s, date);
      if (!cs || i == null) continue;
      const j = Math.min(i + horizon, cs.length - 1);
      elapsed = elapsed == null ? j - i : Math.max(elapsed, j - i);
      rows.push({ s, p, ret: cs[j].close / cs[i].close - 1, days: j - i });
    }
    if (!rows.length || !elapsed) { days.push({ date, n: Object.keys(preds).length, elapsed: 0, done: false }); continue; }
    const mkt = mean(rows.map((r) => r.ret));
    rows.forEach((r) => { r.ex = r.ret - mkt; });
    rows.sort((a, b) => b.p - a.p);
    const k = Math.max(1, Math.round(rows.length * topPct));
    const top = rows.slice(0, k), bottom = rows.slice(-k);
    const done = elapsed >= horizon;
    const d = {
      date, n: rows.length, elapsed, done,
      top: { n: top.length, excess: mean(top.map((r) => r.ex)), win: top.filter((r) => r.ret > 0).length / top.length, avg: mean(top.map((r) => r.ret)) },
      bottom: { n: bottom.length, excess: mean(bottom.map((r) => r.ex)) },
      ic: spearman(rows.map((r) => r.p), rows.map((r) => r.ex)),
      picks: top.slice(0, 10).map((r) => ({ sym: r.s, name: names[r.s] || r.s, pred: r.p, ret: r.ret, ex: r.ex })),
    };
    days.push(d);
    if (done) {
      all.top.push(...top.map((r) => r.ex)); all.topWin.push(...top.map((r) => (r.ret > 0 ? 1 : 0)));
      all.bottom.push(...bottom.map((r) => r.ex));
      if (d.ic != null) all.ic.push(d.ic);
    }
  }
  return {
    horizon, topPct,
    total: {
      days: all.ic.length, topN: all.top.length,
      topExcess: mean(all.top), topWin: mean(all.topWin), bottomExcess: mean(all.bottom),
      ic: mean(all.ic), icPositive: all.ic.length ? all.ic.filter((x) => x > 0).length / all.ic.length : null,
    },
    days,
  };
}
