// AI予測の本番答え合わせ。毎日の予測を記録しておき、5営業日後の実際の値動きと比べる。
// （学習時の検証と違い、実際に公開した予測そのものを採点するので「本番でも効いているか」が分かる）

import { PICK_N, PICK_PER_SECTOR } from './picks.js';

const KEEP_DAYS = 90;
export const COST_RT = 0.002; // 売買コストの目安（往復）。scripts/model.py の COST_RT と同じ

// preds: { sym: [予測(%), 順位] }。順位がある（売買代金1億円以上）銘柄だけ記録する
// picks: その日ホームに出したAIピック（js/picks.js selectPicks の結果のコード）。答え合わせはこれをそのまま採点する
export function updateLog(log, date, preds, picks = null) {
  const out = { days: { ...(log?.days || {}) }, picks: { ...(log?.picks || {}) } };
  if (date && picks) out.picks[date] = picks;
  if (!date || !preds) return trimLog(out);
  const day = {};
  for (const [s, [p, r]] of Object.entries(preds)) if (r != null && Number.isFinite(p)) day[s] = Math.round(p * 1000) / 1000;
  if (Object.keys(day).length) out.days[date] = day;
  return trimLog(out);
}

function trimLog(out) {
  const keep = Object.keys(out.days).sort().slice(-KEEP_DAYS);
  out.days = Object.fromEntries(keep.map((d) => [d, out.days[d]]));
  out.picks = Object.fromEntries(Object.entries(out.picks).filter(([d]) => d >= (keep[0] || '')));
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

// 記録の無い日（2026-11 より前）用：予測の高い順に、同じ業種は2銘柄まで・5銘柄（scripts/model.py の PICK_* と同じ）
export function pickTop(rows, sectorOf, n = PICK_N, perSector = PICK_PER_SECTOR) {
  const out = [], per = {};
  for (const r of rows) {
    const k = sectorOf(r.s) || '-';
    if ((per[k] || 0) >= perSector) continue;
    per[k] = (per[k] || 0) + 1;
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

// history: { sym: candles[] }, names: { sym: name }, sectors: { sym: 業種 }
export function evaluateLog(log, history, names = {}, { horizon = 5, topPct = 0.02, sectors = {} } = {}) {
  const idxCache = new Map();
  const indexOf = (s, d) => {
    if (!idxCache.has(s)) idxCache.set(s, new Map((history[s] || []).map((c, i) => [c.date, i])));
    return idxCache.get(s).get(d);
  };
  const days = [];
  const all = { top: [], topWin: [], bottom: [], ic: [], pick: [], pickWin: [], pickO: [] };
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
      // retO：翌朝の寄り付きで買った場合（朝に予測を見てから買う人の実際に近い）
      const retO = i + 1 <= j && cs[i + 1].open > 0 ? cs[j].close / cs[i + 1].open - 1 : null;
      rows.push({ s, p, ret: cs[j].close / cs[i].close - 1, retO, days: j - i });
    }
    if (!rows.length || !elapsed) { days.push({ date, n: Object.keys(preds).length, elapsed: 0, done: false }); continue; }
    const mkt = mean(rows.map((r) => r.ret));
    rows.forEach((r) => { r.ex = r.ret - mkt; });
    const oRows = rows.filter((r) => r.retO != null);
    const mktO = mean(oRows.map((r) => r.retO));
    oRows.forEach((r) => { r.exO = r.retO - mktO; });
    rows.sort((a, b) => b.p - a.p);
    const k = Math.max(1, Math.round(rows.length * topPct));
    const top = rows.slice(0, k), bottom = rows.slice(-k);
    // ホームに出したピックの記録があればそれを（決算前・荒れ相場の除外も反映済み）、無ければ同じ考え方で選び直す
    const logged = log.picks?.[date];
    const bySym = logged ? new Map(rows.map((r) => [r.s, r])) : null;
    const pk = logged ? logged.map((s) => bySym.get(s)).filter(Boolean) : pickTop(rows, (x) => sectors[x]);
    const done = elapsed >= horizon;
    const d = {
      date, n: rows.length, elapsed, done,
      top: { n: top.length, excess: mean(top.map((r) => r.ex)), win: top.filter((r) => r.ret > 0).length / top.length, avg: mean(top.map((r) => r.ret)) },
      bottom: { n: bottom.length, excess: mean(bottom.map((r) => r.ex)) },
      // ホームに実際に出したAIピック（業種の偏りを抑えた選び方）の成績
      pick: { n: pk.length, logged: !!logged, excess: mean(pk.map((r) => r.ex)),
        excessNet: pk.length ? mean(pk.map((r) => r.ex)) - COST_RT : null,
        excessOpen: mean(pk.filter((r) => r.exO != null).map((r) => r.exO)), win: pk.length ? pk.filter((r) => r.ret > 0).length / pk.length : null, avg: mean(pk.map((r) => r.ret)),
        syms: pk.map((r) => ({ sym: r.s, name: names[r.s] || r.s, sector: sectors[r.s] || null, pred: r.p, ret: r.ret, ex: r.ex })) },
      ic: spearman(rows.map((r) => r.p), rows.map((r) => r.ex)),
      picks: top.slice(0, 10).map((r) => ({ sym: r.s, name: names[r.s] || r.s, pred: r.p, ret: r.ret, ex: r.ex })),
    };
    days.push(d);
    if (done) {
      all.top.push(...top.map((r) => r.ex)); all.topWin.push(...top.map((r) => (r.ret > 0 ? 1 : 0)));
      all.bottom.push(...bottom.map((r) => r.ex));
      all.pick.push(...pk.map((r) => r.ex)); all.pickWin.push(...pk.map((r) => (r.ret > 0 ? 1 : 0)));
      all.pickO.push(...pk.filter((r) => r.exO != null).map((r) => r.exO));
      if (d.ic != null) all.ic.push(d.ic);
    }
  }
  return {
    horizon, topPct,
    total: {
      days: all.ic.length, topN: all.top.length,
      topExcess: mean(all.top), topWin: mean(all.topWin), bottomExcess: mean(all.bottom),
      pickN: all.pick.length, pickExcess: mean(all.pick), pickWin: mean(all.pickWin),
      pickExcessNet: all.pick.length ? mean(all.pick) - COST_RT : null, pickExcessOpen: mean(all.pickO), cost: COST_RT,
      ic: mean(all.ic), icPositive: all.ic.length ? all.ic.filter((x) => x > 0).length / all.ic.length : null,
    },
    days,
  };
}

// 本番で外れ続けているか（ホームのAIピックを止めるかどうか）。実際に出したAIピックの成績で判断する。
// 5営業日の確定を待つと止まるのが遅い（確定まで1週間以上、外れた予測を出し続ける）ので、途中経過も使う：
//   直近の予測のうち、minElapsed 営業日以上たった日（最大 lookback 日分）の平均が
//   ・確定した日が2日以上あれば 0% 未満、・確定がまだ少なければ cut（−1%）未満 なら「外れている」
export function liveHealth(track, { minDays = 3, minElapsed = 2, lookback = 10, cut = -0.01 } = {}) {
  const days = (track?.days || []).filter((d) => d.pick?.excess != null && d.elapsed >= minElapsed).slice(0, lookback);
  const done = days.filter((d) => d.done).length;
  const excess = mean(days.map((d) => d.pick.excess));
  const win = mean(days.map((d) => d.pick.win));
  const limit = done >= 2 ? 0 : cut;
  const failing = days.length >= minDays && excess != null && excess < limit;
  return { failing, days: days.length, done, excess, win, limit, minDays, from: days.at(-1)?.date || null, to: days[0]?.date || null };
}

// 銘柄ごとの「AIの順位の推移」：記録した毎日の予測から、その日の中での順位（0〜1、1＝最上位）を出す
// 返り値 { sym: [[date, rank], ...] }（古い順、直近 days 日分）
export function rankHistory(log, days = 60) {
  const out = {};
  for (const date of Object.keys(log?.days || {}).sort().slice(-days)) {
    const e = Object.entries(log.days[date]).sort((a, b) => a[1] - b[1]);
    e.forEach(([s], i) => { (out[s] = out[s] || []).push([date, Math.round(((i + 1) / e.length) * 1000) / 1000]); });
  }
  return out;
}

// 業種の流れ：毎日の予測の上位 topPct に、どの業種が何割入っていたか（偏り始めにすぐ気づけるように）
export function sectorFlow(log, sectors, { days = 30, topPct = 0.05, keep = 8 } = {}) {
  const dates = Object.keys(log?.days || {}).sort().slice(-days);
  const share = {};
  dates.forEach((date, di) => {
    const e = Object.entries(log.days[date]).sort((a, b) => b[1] - a[1]);
    const top = e.slice(0, Math.max(1, Math.round(e.length * topPct)));
    for (const [s] of top) {
      const k = sectors[s] || 'その他';
      (share[k] = share[k] || new Array(dates.length).fill(0))[di] += 1 / top.length;
    }
  });
  // 直近10日の平均が大きい業種から
  const recent = (a) => a.slice(-10).reduce((x, y) => x + y, 0) / Math.min(10, a.length);
  const order = Object.keys(share).sort((a, b) => recent(share[b]) - recent(share[a])).slice(0, keep);
  return { dates, topPct, sectors: order.map((k) => ({ name: k, share: share[k].map((v) => Math.round(v * 1000) / 1000) })) };
}
