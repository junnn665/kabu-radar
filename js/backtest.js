// バックテスト・ウォークフォワード学習・売買シミュレーション。
// ブラウザ（デモ／銘柄別）と GitHub Actions（全上場銘柄）の両方から使う。
//
// 成績は「市場平均との差（超過リターン）」でも測る。相場全体が上がった日は何を買っても勝つため、
// 銘柄選びの腕前は市場平均を引いた値で見ないと分からない。
import { atr } from './indicators.js';
import { SIGNALS, BASE_WEIGHTS, SIGNAL_BIT, computeIndicators, signalsAt, scoreOf, isLiquid, MIN_TURNOVER, idsToMask, STRONG, WATCH } from './signals.js';

export const WARMUP = 75; // 75日線が揃うまでは評価しない
const NS = SIGNALS.length;

export function summarize(rets) {
  const n = rets.length;
  if (!n) return { n: 0, win: null, avg: null, median: null };
  const s = Float64Array.from(rets).sort();
  let sum = 0, win = 0;
  for (const r of rets) { sum += r; if (r > 0) win++; }
  return { n, win: win / n, avg: sum / n, median: s[Math.floor(n / 2)] };
}

// 全銘柄・全日の「点灯シグナル・その後のリターン」を1つの表にまとめる（メモリ節約のため型付き配列）
export function buildPanel(series, { horizon = 5, minTurnover = MIN_TURNOVER, penaltyOf = null } = {}) {
  const syms = [];
  const dateSet = new Set();
  const tmp = [];
  for (const [sym, candles] of Object.entries(series)) {
    if (!candles || candles.length < WARMUP + 2) continue;
    const ind = computeIndicators(candles);
    const si = syms.push(sym) - 1;
    for (let i = WARMUP; i < candles.length; i++) {
      if (!isLiquid(ind, i, minTurnover)) continue;
      const d = candles[i].date;
      dateSet.add(d);
      const mask = idsToMask(signalsAt(ind, i).map((f) => f.id));
      const fwd = i + horizon < candles.length ? candles[i + horizon].close / candles[i].close - 1 : NaN;
      tmp.push([si, d, mask, fwd, penaltyOf ? penaltyOf(sym, d) : 0]);
    }
  }
  const dates = [...dateSet].sort();
  const di = new Map(dates.map((d, i) => [d, i]));
  const n = tmp.length;
  const P = {
    horizon, syms, dates, n,
    sym: new Int32Array(n), date: new Int32Array(n), mask: new Int32Array(n),
    fwd: new Float64Array(n), ex: new Float64Array(n), pen: new Float64Array(n),
    mkt: new Float64Array(dates.length),
  };
  const msum = new Float64Array(dates.length), mcnt = new Int32Array(dates.length);
  tmp.forEach(([s, d, m, f, p], k) => {
    const j = di.get(d);
    P.sym[k] = s; P.date[k] = j; P.mask[k] = m; P.fwd[k] = f; P.pen[k] = p;
    if (!Number.isNaN(f)) { msum[j] += f; mcnt[j]++; }
  });
  for (let j = 0; j < dates.length; j++) P.mkt[j] = mcnt[j] ? msum[j] / mcnt[j] : NaN;
  for (let k = 0; k < n; k++) P.ex[k] = P.fwd[k] - P.mkt[P.date[k]];
  return P;
}

const maskScore = (mask, w) => {
  let s = 0;
  for (let b = 0; b < NS; b++) if (mask & (1 << b)) s += w[SIGNALS[b].id] ?? 0;
  return Math.max(-100, Math.min(100, s));
};

// パネル全体（または日付範囲）でのシグナル別成績
export function panelStats(P, { from = 0, to = P.dates.length, weights = BASE_WEIGHTS } = {}) {
  const raw = SIGNALS.map(() => []), exc = SIGNALS.map(() => []);
  const all = [], allEx = [];
  const strong = [], strongEx = [], watch = [], watchEx = [];
  const good = [], bad = [];
  for (let k = 0; k < P.n; k++) {
    const j = P.date[k];
    if (j < from || j >= to || Number.isNaN(P.fwd[k])) continue;
    const f = P.fwd[k], e = P.ex[k], m = P.mask[k];
    all.push(f); allEx.push(e);
    for (let b = 0; b < NS; b++) if (m & (1 << b)) { raw[b].push(f); exc[b].push(e); }
    const sc = maskScore(m, weights);
    if (sc >= STRONG) { strong.push(f); strongEx.push(e); (P.pen[k] > 0 ? bad : good).push(f); }
    else if (sc >= WATCH) { watch.push(f); watchEx.push(e); }
  }
  const withEx = (r, e) => ({ ...summarize(r), excess: e.length ? e.reduce((a, b) => a + b, 0) / e.length : null, exWin: e.length ? e.filter((x) => x > 0).length / e.length : null });
  return {
    horizon: P.horizon,
    baseline: withEx(all, allEx),
    stats: Object.fromEntries(SIGNALS.map((s, b) => [s.id, withEx(raw[b], exc[b])])),
    byVerdict: { strong: withEx(strong, strongEx), watch: withEx(watch, watchEx) },
    byRegime: { good: summarize(good), bad: summarize(bad) },
  };
}

// 成績から配点を作る：市場平均を上回った分（%）×10点を、標準配点と半々で混ぜる。サンプルが少なければ標準のまま。
// 点数の大きさは標準配点に揃える（市場平均との差は0.数%と小さいため、そのままだと「強い買い」に届かない）
export function tuneWeights(bt, { minN = 40, blend = 0.5 } = {}) {
  const learned = {};
  for (const s of SIGNALS) {
    const st = bt.stats[s.id];
    const edge = st?.excess ?? (st?.avg != null && bt.baseline?.avg != null ? st.avg - bt.baseline.avg : null);
    if (st && st.n >= minN && edge != null) learned[s.id] = edge;
  }
  const maxEdge = Math.max(...Object.values(learned).map(Math.abs), 1e-9);
  const maxBase = Math.max(...SIGNALS.map((s) => Math.abs(s.base)));
  const out = {};
  for (const s of SIGNALS) {
    if (!(s.id in learned)) { out[s.id] = s.base; continue; }
    const l = (learned[s.id] / maxEdge) * maxBase;
    out[s.id] = Math.round((1 - blend) * s.base + blend * l);
  }
  return out;
}

// ウォークフォワード：毎週、直近 window 営業日の成績だけで配点を学び直し、その後の1週間に当てはめる。
// 学習に使っていない期間の成績（＝本番に近い成績）が分かる。
export function walkForward(P, { window = 120, step = 5, minN = 40 } = {}) {
  const H = P.horizon;
  const D = P.dates.length;
  // 日付ごと・シグナルごとの超過リターン合計と件数（窓の集計を速くするため）
  const sum = Array.from({ length: D }, () => new Float64Array(NS));
  const cnt = Array.from({ length: D }, () => new Int32Array(NS));
  for (let k = 0; k < P.n; k++) {
    if (Number.isNaN(P.fwd[k])) continue;
    const j = P.date[k], m = P.mask[k];
    for (let b = 0; b < NS; b++) if (m & (1 << b)) { sum[j][b] += P.ex[k]; cnt[j][b]++; }
  }
  const weightsAt = (t) => {
    // t 日の時点で結果が分かっているのは t-H 日まで
    const end = t - H, start = Math.max(0, end - window);
    const stats = {};
    SIGNALS.forEach((s, b) => {
      let S = 0, C = 0;
      for (let j = start; j < end; j++) { S += sum[j][b]; C += cnt[j][b]; }
      stats[s.id] = { n: C, excess: C ? S / C : null };
    });
    return tuneWeights({ stats, baseline: {} }, { minN });
  };
  const firstTest = Math.min(D, Math.max(40 + H, Math.floor(D * 0.35)));
  const tuned = { r: [], e: [] }, base = { r: [], e: [] };
  const byDate = new Map();
  for (let k = 0; k < P.n; k++) {
    if (Number.isNaN(P.fwd[k]) || P.date[k] < firstTest) continue;
    if (!byDate.has(P.date[k])) byDate.set(P.date[k], []);
    byDate.get(P.date[k]).push(k);
  }
  let w = null;
  for (let t = firstTest; t < D; t++) {
    if (!w || (t - firstTest) % step === 0) w = weightsAt(t);
    for (const k of byDate.get(t) || []) {
      const m = P.mask[k];
      if (maskScore(m, w) >= STRONG) { tuned.r.push(P.fwd[k]); tuned.e.push(P.ex[k]); }
      if (maskScore(m, BASE_WEIGHTS) >= STRONG) { base.r.push(P.fwd[k]); base.e.push(P.ex[k]); }
    }
  }
  const pack = (x) => ({ ...summarize(x.r), excess: x.e.length ? x.e.reduce((a, b) => a + b, 0) / x.e.length : null, exWin: x.e.length ? x.e.filter((v) => v > 0).length / x.e.length : null });
  return {
    window, step,
    testFrom: P.dates[firstTest] || null, testTo: P.dates[D - 1] || null,
    tuned: pack(tuned), base: pack(base),
    weightsNow: weightsAt(D + H), // 最新までの成績で学んだ配点
  };
}

// 互換用：銘柄群のシグナル成績（ブラウザの銘柄別表示などで使う）
export function signalStats(series, { horizon = 5, penaltyOf = null, minTurnover = 0 } = {}) {
  const P = buildPanel(series, { horizon, minTurnover, penaltyOf: penaltyOf ? (s, d) => penaltyOf(s, d) : null });
  const st = panelStats(P);
  return { ...st, byRegime: penaltyOf ? st.byRegime : null };
}

export const DEFAULT_RULES = { entry: STRONG, hold: 10, takeProfit: 0.1, stopLoss: -0.05, exitScore: -20 };

// 「スコアが entry 以上になったら終値で買い、利確・損切り・保有期限・スコア悪化で売る」を過去に適用
// penaltyOf(date) を渡すと地合いフィルターをかけたスコアで売買する。売買代金が少ない日は買わない
export function simulate(candles, weights = BASE_WEIGHTS, rules = DEFAULT_RULES, penaltyOf = null, minTurnover = MIN_TURNOVER) {
  const trades = [];
  if (!candles || candles.length < WARMUP + 2) return trades;
  const ind = computeIndicators(candles);
  const atrs = rules.atrStop ? atr(candles, 14) : null;
  let pos = null;
  for (let i = WARMUP; i < candles.length; i++) {
    const ids = signalsAt(ind, i).map((f) => f.id);
    const sc = Math.max(-100, scoreOf(ids, weights) - (penaltyOf ? penaltyOf(candles[i].date) : 0));
    const px = candles[i].close;
    if (pos) {
      const ret = px / pos.entryPrice - 1;
      const held = i - pos.idx;
      let reason = null;
      if (pos.target != null ? px >= pos.target : rules.takeProfit != null && ret >= rules.takeProfit) reason = '利確';
      else if (pos.stop != null ? px <= pos.stop : rules.stopLoss != null && ret <= rules.stopLoss) reason = '損切り';
      else if (rules.exitScore != null && sc <= rules.exitScore) reason = 'スコア悪化';
      else if (held >= rules.hold) reason = '保有期限';
      if (reason) {
        trades.push({ entryDate: pos.date, entryPrice: pos.entryPrice, exitDate: candles[i].date, exitPrice: px, ret, reason, signals: pos.signals, held });
        pos = null;
      }
    } else if (sc >= rules.entry && isLiquid(ind, i, minTurnover)) {
      pos = { idx: i, date: candles[i].date, entryPrice: px, signals: ids };
      // ATR（ふだんの値幅）を基準にした損切り・利確（サイトに表示している目安と同じ考え方）
      if (atrs?.[i]) { pos.stop = px - rules.atrStop * atrs[i]; pos.target = rules.atrTarget ? px + rules.atrTarget * atrs[i] : null; }
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
  const held = closed.filter((t) => t.held != null);
  const reasons = {};
  for (const t of closed) reasons[t.reason] = (reasons[t.reason] || 0) + 1;
  return { ...s, trades: trades.length, pnl: Math.round(trades.reduce((a, t) => a + t.ret * notional, 0)),
    avgHeld: held.length ? held.reduce((a, t) => a + t.held, 0) / held.length : null, reasons };
}

// 損切り・利確のルールの比較（同じ買いシグナルで、売り方だけ変える）
export const RULE_SETS = {
  fixed: { label: '−5%損切り・+10%利確（従来）', rules: { entry: STRONG, hold: 10, takeProfit: 0.1, stopLoss: -0.05, exitScore: -20 } },
  atr: { label: 'ATR×2損切り・ATR×3利確（サイトの目安）', rules: { entry: STRONG, hold: 10, atrStop: 2, atrTarget: 3, exitScore: -20 } },
  wide: { label: '−10%損切り・+15%利確', rules: { entry: STRONG, hold: 10, takeProfit: 0.15, stopLoss: -0.1, exitScore: -20 } },
  hold10: { label: '損切りなし・10日保有', rules: { entry: STRONG, hold: 10, takeProfit: null, stopLoss: null, exitScore: null } },
  hold5: { label: '損切りなし・5日保有', rules: { entry: STRONG, hold: 5, takeProfit: null, stopLoss: null, exitScore: null } },
};

export { SIGNAL_BIT };
