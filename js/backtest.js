// バックテスト・戦略シミュレーション・配点の自動チューニング。
// ブラウザ（デモ／銘柄別）と GitHub Actions（全ユニバース）の両方から使う。
import { SIGNALS, BASE_WEIGHTS, computeIndicators, signalsAt, scoreOf } from './signals.js';

export const WARMUP = 75; // 75日線が揃うまでは評価しない

// シグナルごとの「点灯後 h 日のリターン」統計。series: { sym: candles[] }
export function signalStats(series, { horizon = 5 } = {}) {
  const acc = Object.fromEntries(SIGNALS.map((s) => [s.id, []]));
  const all = [];
  const scored = { strong: [], watch: [] };
  for (const candles of Object.values(series)) {
    if (!candles || candles.length < WARMUP + horizon + 1) continue;
    const ind = computeIndicators(candles);
    for (let i = WARMUP; i < candles.length - horizon; i++) {
      const ret = candles[i + horizon].close / candles[i].close - 1;
      all.push(ret);
      const ids = signalsAt(ind, i).map((f) => f.id);
      ids.forEach((id) => acc[id].push(ret));
      const sc = scoreOf(ids);
      if (sc >= 40) scored.strong.push(ret);
      else if (sc >= 20) scored.watch.push(ret);
    }
  }
  const stats = {};
  for (const [id, rets] of Object.entries(acc)) stats[id] = summarize(rets);
  return {
    horizon,
    baseline: summarize(all),
    stats,
    byVerdict: { strong: summarize(scored.strong), watch: summarize(scored.watch) },
  };
}

export function summarize(rets) {
  const n = rets.length;
  if (!n) return { n: 0, win: null, avg: null, median: null };
  const s = [...rets].sort((a, b) => a - b);
  return {
    n,
    win: rets.filter((r) => r > 0).length / n,
    avg: rets.reduce((a, b) => a + b, 0) / n,
    median: s[Math.floor(n / 2)],
  };
}

// 過去成績から配点を調整：基準（全日平均）を上回った分を点数に換算し、標準配点と半々で混ぜる。
// サンプルが少ないシグナルは標準配点のまま。
export function tuneWeights(bt, { minN = 30 } = {}) {
  const out = {};
  const base = bt.baseline.avg ?? 0;
  for (const s of SIGNALS) {
    const st = bt.stats[s.id];
    if (!st || st.n < minN) { out[s.id] = s.base; continue; }
    const edgePct = (st.avg - base) * 100; // 例: +1% の上振れ
    const learned = Math.max(-30, Math.min(30, edgePct * 10));
    out[s.id] = Math.round(0.5 * s.base + 0.5 * learned);
  }
  return out;
}

export const DEFAULT_RULES = { entry: 40, hold: 10, takeProfit: 0.1, stopLoss: -0.05, exitScore: -30 };

// 「スコアが entry 以上になったら終値で買い、利確・損切り・保有期限・スコア悪化で売る」を過去に適用
export function simulate(candles, weights = BASE_WEIGHTS, rules = DEFAULT_RULES) {
  const trades = [];
  if (!candles || candles.length < WARMUP + 2) return trades;
  const ind = computeIndicators(candles);
  let pos = null;
  for (let i = WARMUP; i < candles.length; i++) {
    const ids = signalsAt(ind, i).map((f) => f.id);
    const sc = scoreOf(ids, weights);
    const px = candles[i].close;
    if (pos) {
      const ret = px / pos.entryPrice - 1;
      const held = i - pos.idx;
      let reason = null;
      if (ret >= rules.takeProfit) reason = '利確';
      else if (ret <= rules.stopLoss) reason = '損切り';
      else if (sc <= rules.exitScore) reason = 'スコア悪化';
      else if (held >= rules.hold) reason = '保有期限';
      if (reason) {
        trades.push({ entryDate: pos.date, entryPrice: pos.entryPrice, exitDate: candles[i].date, exitPrice: px, ret, reason, signals: pos.signals });
        pos = null;
      }
    } else if (sc >= rules.entry) {
      pos = { idx: i, date: candles[i].date, entryPrice: px, signals: ids };
    }
  }
  if (pos) {
    const lastC = candles[candles.length - 1];
    trades.push({ entryDate: pos.date, entryPrice: pos.entryPrice, exitDate: null, exitPrice: lastC.close, ret: lastC.close / pos.entryPrice - 1, reason: '保有中', signals: pos.signals });
  }
  return trades;
}

export function tradeSummary(trades, notional = 100000) {
  const closed = trades.filter((t) => t.exitDate);
  const s = summarize(closed.map((t) => t.ret));
  return { ...s, trades: trades.length, pnl: Math.round(trades.reduce((a, t) => a + t.ret * notional, 0)) };
}
