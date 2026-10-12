// 答え合わせ：過去の各営業日に「強い買い」だった銘柄が、その後5営業日でどうなったか。
// シグナルは日足だけで決まるので、過去分もその場で再現できる（記録を待たずに見られる）。
import { computeIndicators, signalsAt, scoreOf, BASE_WEIGHTS } from './signals.js';

const weekStart = (d) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); // 月曜
  return t.toISOString().slice(0, 10);
};

// series: {sym: candles}, meta: {sym: {name, market}}, index: {JP: candles, US: candles}
export function computeReview(series, { meta = {}, index = {}, weights = BASE_WEIGHTS, penaltyOf = null, days = 40, horizon = 5, threshold = 40 } = {}) {
  const picks = [];
  const idxClose = Object.fromEntries(Object.entries(index).map(([m, cs]) => [m, new Map((cs || []).map((c) => [c.date, c.close]))]));
  for (const [sym, cs] of Object.entries(series)) {
    if (!cs || cs.length < 80) continue;
    const ind = computeIndicators(cs);
    const mkt = meta[sym]?.market || (/^\d/.test(sym) ? 'JP' : 'US');
    for (let i = Math.max(75, cs.length - days); i < cs.length; i++) {
      const ids = signalsAt(ind, i).map((f) => f.id);
      const pen = penaltyOf ? penaltyOf(sym, cs[i].date) : 0;
      const score = Math.max(-100, scoreOf(ids, weights) - pen);
      if (score < threshold) continue;
      const j = Math.min(i + horizon, cs.length - 1);
      const done = i + horizon <= cs.length - 1;
      const ret = cs[j].close / cs[i].close - 1;
      const ic = idxClose[mkt];
      const a = ic?.get(cs[i].date), b = ic?.get(cs[j].date);
      picks.push({
        date: cs[i].date, sym, name: meta[sym]?.name || sym, market: mkt, score, ids,
        price: cs[i].close, ret, idxRet: a && b ? b / a - 1 : null, done, days: j - i,
      });
    }
  }
  const weeks = {};
  for (const p of picks) (weeks[weekStart(p.date)] ||= []).push(p);
  const summarize = (list) => {
    const d = list.filter((p) => p.done);
    const ex = d.filter((p) => p.idxRet != null);
    return {
      n: list.length, done: d.length,
      win: d.length ? d.filter((p) => p.ret > 0).length / d.length : null,
      avg: d.length ? d.reduce((a, p) => a + p.ret, 0) / d.length : null,
      beat: ex.length ? ex.filter((p) => p.ret > p.idxRet).length / ex.length : null,
      avgExcess: ex.length ? ex.reduce((a, p) => a + p.ret - p.idxRet, 0) / ex.length : null,
    };
  };
  return {
    horizon, threshold,
    total: summarize(picks),
    weeks: Object.entries(weeks).sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([week, list]) => ({
      week, ...summarize(list), picks: list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.score - a.score)),
    })),
  };
}
