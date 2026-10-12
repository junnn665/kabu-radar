// 狙い目判定エンジン v2（日本株向け）。
// 指標は全期間で一度だけ計算し（未来の値は使わない因果的な指標のみ）、任意の日 i 時点のシグナルを評価できる。
// これにより「今の判定」と「過去の成績（バックテスト）」が同じロジックで計算される。
//
// 配点の根拠（「5営業日後のリターン − 同じ日の全銘柄平均」で検証）
//  v2: 日本株40銘柄で設計 → MACD 好転・RSI(14)<30 は市場平均に負けていたため除外
//  v3: 東証3,682銘柄・188営業日（約30万件）で再検証し、全銘柄では効かなかった
//      出来高急増・上昇／60日高値ブレイク／下ヒゲ反発／25日線からの上振れ／ゴールデンクロス を 0 点に。
//      押し目・短期の売られすぎ・ボリンジャー下限・急落 がプラス、過熱・上限・崩れ・デッドクロス・投げ売りがマイナス
import { sma, rsi, bollinger } from './indicators.js';

// base は標準配点、kind は配点スタイル（逆張り / 順張り）の分類
export const SIGNALS = [
  { id: 'dip_in_uptrend', label: '上昇トレンド中の押し目', base: 25, kind: 'contrarian', desc: '75日線が上向きの銘柄で、RSI(2)が10未満まで急落' },
  { id: 'short_oversold', label: '短期の売られすぎ', base: 10, kind: 'contrarian', desc: 'RSI(2)が10未満' },
  { id: 'bb_lower', label: 'ボリンジャー下限', base: 10, kind: 'contrarian', desc: '終値が−2σ以下' },
  { id: 'sharp_drop', label: '5日で急落', base: 8, kind: 'contrarian', desc: '5営業日で−7%以上' },
  { id: 'hammer', label: '下ヒゲ反発', base: 0, kind: 'contrarian', desc: '下落後に安値から大きく戻して引けた' },
  { id: 'vol_surge_up', label: '出来高急増・上昇', base: 0, kind: 'trend', desc: '出来高が20日平均の2倍以上で上昇' },
  { id: 'gap_up_volume', label: '大商いの窓開け上昇', base: 10, kind: 'trend', desc: '前日終値より3%以上高く始まり、出来高2倍以上（材料・決算サプライズなど）' },
  { id: 'golden_cross', label: 'ゴールデンクロス', base: 0, kind: 'trend', desc: '5日線が25日線を上抜け（直近3日）' },
  { id: 'breakout', label: '60日高値ブレイク', base: 0, kind: 'trend', desc: '直近60日の高値を更新' },
  { id: 'uptrend', label: '上昇トレンド', base: 5, kind: 'trend', desc: '75日線の上で75日線が上向き' },
  { id: 'short_overbought', label: '短期の過熱', base: -10, kind: 'contrarian', desc: 'RSI(2)が90超' },
  { id: 'bb_upper', label: 'ボリンジャー上限', base: -10, kind: 'contrarian', desc: '終値が+2σ以上' },
  { id: 'overheated', label: '25日線から大きく上振れ', base: 0, kind: 'contrarian', desc: '25日移動平均乖離率が+15%以上' },
  { id: 'trend_break', label: '上昇トレンドの急な崩れ', base: -10, kind: 'trend', desc: '75日線の上にいるのに25日線を5%以上割り込んだ' },
  { id: 'dead_cross', label: 'デッドクロス', base: -10, kind: 'trend', desc: '5日線が25日線を下抜け（直近3日）' },
  { id: 'vol_surge_down', label: '出来高を伴う下落', base: -10, kind: 'trend', desc: '出来高が20日平均の2倍以上で下落' },
  { id: 'downtrend', label: '下降トレンド', base: -5, kind: 'trend', desc: '75日線の下で25日線が下向き' },
];
export const SIGNAL_MAP = Object.fromEntries(SIGNALS.map((s) => [s.id, s]));
export const SIGNAL_BIT = Object.fromEntries(SIGNALS.map((s, i) => [s.id, 1 << i]));
export const BASE_WEIGHTS = Object.fromEntries(SIGNALS.map((s) => [s.id, s.base]));

// しきい値は日本株の実データで「スコア帯ごとの市場平均との差」を見て決めた（30点以上が前後半とも市場平均を上回った）
export const STRONG = 30, WATCH = 20, CAUTION = -10;
export const VERDICTS = [
  { min: STRONG, key: 'strong', label: '強い買いシグナル' },
  { min: WATCH, key: 'watch', label: '注目' },
  { min: CAUTION + 1, key: 'neutral', label: '中立' },
  { min: -Infinity, key: 'caution', label: '警戒' },
];
export const verdictOf = (score) => VERDICTS.find((v) => score >= v.min);

// 売買代金（20日平均）がこれ未満の銘柄はサジェスト・成績集計から外す（値動きが荒く、売買しにくいため）
export const MIN_TURNOVER = 1e8; // 1億円

// スタイル補正：逆張り派なら逆張りシグナルを強め、順張りシグナルを弱める（逆も同様）
export const STYLES = {
  balanced: { label: 'バランス', contrarian: 1, trend: 1 },
  contrarian: { label: '逆張り派（押し目・反発狙い）', contrarian: 1.5, trend: 0.6 },
  trend: { label: '順張り派（勢い・ブレイク狙い）', contrarian: 0.6, trend: 1.5 },
};
export function applyStyle(weights, style = 'balanced') {
  const st = STYLES[style] || STYLES.balanced;
  const out = {};
  for (const s of SIGNALS) out[s.id] = Math.round((weights[s.id] ?? s.base) * st[s.kind]);
  return out;
}

export function computeIndicators(candles) {
  const n = candles.length;
  const close = candles.map((c) => c.close);
  const vol = candles.map((c) => c.volume || 0);
  const volAvg20 = new Array(n).fill(null);   // 当日を除く直近20日平均
  const turnover20 = new Array(n).fill(null); // 当日を含む直近20日の平均売買代金
  let vs = 0, ts = 0;
  for (let i = 0; i < n; i++) {
    if (i >= 20) volAvg20[i] = vs / 20;
    vs += vol[i];
    if (i >= 20) vs -= vol[i - 20];
    ts += close[i] * vol[i];
    if (i >= 20) ts -= close[i - 20] * vol[i - 20];
    if (i >= 19) turnover20[i] = ts / 20;
  }
  const high60 = new Array(n).fill(null); // 当日を除く直近60日の高値
  for (let i = 60; i < n; i++) {
    let m = -Infinity;
    for (let j = i - 60; j < i; j++) if (candles[j].high > m) m = candles[j].high;
    high60[i] = m;
  }
  return {
    candles, close, vol, volAvg20, turnover20, high60,
    sma5: sma(close, 5), sma25: sma(close, 25), sma75: sma(close, 75),
    rsi: rsi(close, 14), rsi2: rsi(close, 2), bb: bollinger(close, 20, 2),
  };
}

function crossAt(a, b, i, n) {
  for (let k = i; k > 0 && k > i - n; k--) {
    if ([a[k], b[k], a[k - 1], b[k - 1]].some((v) => v == null)) continue;
    if (a[k - 1] <= b[k - 1] && a[k] > b[k]) return 1;
    if (a[k - 1] >= b[k - 1] && a[k] < b[k]) return -1;
  }
  return 0;
}

const f2 = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(1));
const pc = (v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

export const isLiquid = (ind, i, min = MIN_TURNOVER) => (ind.turnover20[i] ?? 0) >= min;

// i 日目時点で点灯しているシグナル [{id, detail}]
export function signalsAt(ind, i) {
  const out = [];
  const add = (id, detail) => out.push({ id, detail });
  const c = ind.close, cs = ind.candles;
  const price = c[i];
  if (i < 1) return out;

  const s25 = ind.sma25[i], s75 = ind.sma75[i], s75p = ind.sma75[i - 10], s25p = ind.sma25[i - 5];
  const up = s75 != null && s75p != null && price > s75 && s75 > s75p;
  const down = s75 != null && s25 != null && s25p != null && price < s75 && s25 < s25p;
  const r2 = ind.rsi2[i];
  const dev25 = s25 ? price / s25 - 1 : null;

  if (r2 != null && r2 < 10) {
    if (up) add('dip_in_uptrend', `RSI(2) ${r2.toFixed(0)}・75日線は上向き`);
    else add('short_oversold', `RSI(2) ${r2.toFixed(0)}`);
  }
  if (r2 != null && r2 > 90) add('short_overbought', `RSI(2) ${r2.toFixed(0)}`);

  const lo = ind.bb.lower[i], hi = ind.bb.upper[i];
  if (lo != null && price <= lo) add('bb_lower', `−2σ (${f2(lo)}) 以下`);
  if (hi != null && price >= hi) add('bb_upper', `+2σ (${f2(hi)}) 以上`);

  if (i >= 5) {
    const r5 = price / c[i - 5] - 1;
    if (r5 <= -0.07) add('sharp_drop', `5日で${pc(r5)}`);
    const bar = cs[i], range = bar.high - bar.low;
    if (r5 < -0.03 && range > 0 && (price - bar.low) / range > 0.7 && price >= bar.open) add('hammer', '安値から大きく戻して陽線引け');
  }

  const va = ind.volAvg20[i];
  if (va) {
    const ratio = ind.vol[i] / va;
    const chg = price / c[i - 1] - 1;
    const gap = cs[i].open / c[i - 1] - 1;
    if (ratio >= 2 && gap >= 0.03 && price >= cs[i].open * 0.99) add('gap_up_volume', `窓開け${pc(gap)}・出来高${ratio.toFixed(1)}倍`);
    else if (ratio >= 2 && chg > 0) add('vol_surge_up', `出来高${ratio.toFixed(1)}倍・${pc(chg)}`);
    else if (ratio >= 2 && chg < 0) add('vol_surge_down', `出来高${ratio.toFixed(1)}倍・${pc(chg)}`);
  }

  const gc = crossAt(ind.sma5, ind.sma25, i, 3);
  if (gc === 1) add('golden_cross', '5日線が25日線を上抜け');
  if (gc === -1) add('dead_cross', '5日線が25日線を下抜け');

  const ph = ind.high60[i];
  if (ph != null && price > ph) add('breakout', `60日高値 ${f2(ph)} を更新`);

  if (dev25 != null && dev25 >= 0.15) add('overheated', `25日線乖離 ${pc(dev25)}`);
  if (dev25 != null && s75 != null && price > s75 && dev25 <= -0.05) add('trend_break', `25日線乖離 ${pc(dev25)}`);

  if (up) add('uptrend', '75日線の上・75日線が上向き');
  if (down) add('downtrend', '75日線の下・25日線が下向き');
  return out;
}

export const idsToMask = (ids) => ids.reduce((m, id) => m | (SIGNAL_BIT[id] || 0), 0);

export function scoreOf(ids, weights = BASE_WEIGHTS) {
  const sum = ids.reduce((a, id) => a + (weights[id] ?? BASE_WEIGHTS[id] ?? 0), 0);
  return Math.max(-100, Math.min(100, sum));
}

// 最新日の総合判定
export function analyze(candles, weights = BASE_WEIGHTS, ind = null) {
  if (!candles || candles.length < 30) {
    return { score: 0, signals: [], verdict: verdictOf(0), ind: null, liquid: true, turnover: null };
  }
  ind = ind || computeIndicators(candles);
  const i = candles.length - 1;
  const fired = signalsAt(ind, i).filter((f) => SIGNAL_MAP[f.id]);
  const signals = fired
    .map((f) => ({ ...f, label: SIGNAL_MAP[f.id].label, weight: weights[f.id] ?? SIGNAL_MAP[f.id].base }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const score = scoreOf(fired.map((f) => f.id), weights);
  return { score, signals, verdict: verdictOf(score), ind, liquid: isLiquid(ind, i), turnover: ind.turnover20[i] };
}
