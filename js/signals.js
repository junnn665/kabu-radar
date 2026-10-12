// 狙い目判定エンジン。
// 指標は全期間で一度だけ計算し（未来の値は使わない因果的な指標のみ）、任意の日 i 時点のシグナルを評価できる。
// これにより「今の判定」と「過去の成績（バックテスト）」が同じロジックで計算される。
import { sma, rsi, bollinger, macd } from './indicators.js';

// シグナル定義。base は標準配点、kind は配点スタイル（逆張り / 順張り）の分類。
export const SIGNALS = [
  { id: 'rsi_oversold', label: '売られすぎ (RSI<30)', base: 25, kind: 'contrarian' },
  { id: 'rsi_low', label: 'やや売られ気味 (RSI<40)', base: 8, kind: 'contrarian' },
  { id: 'rsi_overbought', label: '買われすぎ (RSI>75)', base: -20, kind: 'contrarian' },
  { id: 'rsi_high', label: 'やや過熱 (RSI>70)', base: -10, kind: 'contrarian' },
  { id: 'golden_cross', label: 'ゴールデンクロス', base: 25, kind: 'trend' },
  { id: 'dead_cross', label: 'デッドクロス', base: -25, kind: 'trend' },
  { id: 'bb_lower', label: 'ボリンジャー下限タッチ', base: 15, kind: 'contrarian' },
  { id: 'bb_upper', label: 'ボリンジャー上限', base: -10, kind: 'contrarian' },
  { id: 'macd_up', label: 'MACD 好転', base: 15, kind: 'trend' },
  { id: 'macd_down', label: 'MACD 悪化', base: -15, kind: 'trend' },
  { id: 'vol_surge_up', label: '出来高急増・上昇', base: 15, kind: 'trend' },
  { id: 'vol_surge_down', label: '出来高を伴う下落', base: -10, kind: 'trend' },
  { id: 'breakout', label: '高値ブレイク (120日)', base: 10, kind: 'trend' },
  { id: 'uptrend', label: '上昇トレンド', base: 10, kind: 'trend' },
  { id: 'downtrend', label: '下降トレンド', base: -10, kind: 'trend' },
];
export const SIGNAL_MAP = Object.fromEntries(SIGNALS.map((s) => [s.id, s]));
export const BASE_WEIGHTS = Object.fromEntries(SIGNALS.map((s) => [s.id, s.base]));

export const VERDICTS = [
  { min: 40, key: 'strong', label: '強い買いシグナル' },
  { min: 20, key: 'watch', label: '注目' },
  { min: -29, key: 'neutral', label: '中立' },
  { min: -Infinity, key: 'caution', label: '警戒' },
];
export const verdictOf = (score) => VERDICTS.find((v) => score >= v.min);

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
  const close = candles.map((c) => c.close);
  const high = candles.map((c) => c.high);
  const vol = candles.map((c) => c.volume || 0);
  const n = candles.length;
  const volAvg20 = new Array(n).fill(null);
  let vs = 0;
  for (let i = 0; i < n; i++) {
    if (i >= 20) volAvg20[i] = vs / 20; // 当日を除く直近20日平均
    vs += vol[i];
    if (i >= 20) vs -= vol[i - 20];
  }
  const high120 = new Array(n).fill(null); // 当日を除く直近120日の高値
  for (let i = 20; i < n; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - 120); j < i; j++) if (high[j] > m) m = high[j];
    high120[i] = m;
  }
  return {
    close, vol, volAvg20, high120,
    sma5: sma(close, 5), sma25: sma(close, 25), sma75: sma(close, 75),
    rsi: rsi(close, 14), bb: bollinger(close, 20, 2), macd: macd(close),
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

const f2 = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2));

// i 日目時点で点灯しているシグナル [{id, detail}]
export function signalsAt(ind, i) {
  const out = [];
  const add = (id, detail) => out.push({ id, detail });
  const price = ind.close[i];

  const r = ind.rsi[i];
  if (r != null) {
    if (r < 30) add('rsi_oversold', `RSI ${r.toFixed(1)} — 反発の余地`);
    else if (r < 40) add('rsi_low', `RSI ${r.toFixed(1)}`);
    else if (r > 75) add('rsi_overbought', `RSI ${r.toFixed(1)} — 高値掴み注意`);
    else if (r > 70) add('rsi_high', `RSI ${r.toFixed(1)}`);
  }

  const gc = crossAt(ind.sma5, ind.sma25, i, 3);
  if (gc === 1) add('golden_cross', '5日線が25日線を上抜け（直近3日）');
  if (gc === -1) add('dead_cross', '5日線が25日線を下抜け（直近3日）');

  const lo = ind.bb.lower[i], up = ind.bb.upper[i];
  if (lo != null && price <= lo) add('bb_lower', `-2σ (${f2(lo)}) 以下 — 逆張り候補`);
  if (up != null && price >= up) add('bb_upper', `+2σ (${f2(up)}) 以上`);

  const h = ind.macd.hist;
  for (let k = i; k > 0 && k > i - 3; k--) {
    if (h[k] == null || h[k - 1] == null) continue;
    if (h[k - 1] <= 0 && h[k] > 0) { add('macd_up', 'MACDがシグナルを上抜け'); break; }
    if (h[k - 1] >= 0 && h[k] < 0) { add('macd_down', 'MACDがシグナルを下抜け'); break; }
  }

  const va = ind.volAvg20[i];
  if (va && i > 0) {
    const ratio = ind.vol[i] / va;
    const chg = price - ind.close[i - 1];
    if (ratio >= 2 && chg > 0) add('vol_surge_up', `20日平均の ${ratio.toFixed(1)} 倍・上昇`);
    else if (ratio >= 2 && chg < 0) add('vol_surge_down', `20日平均の ${ratio.toFixed(1)} 倍・下落`);
  }

  const ph = ind.high120[i];
  if (ph != null && i >= 60 && price > ph) add('breakout', `直近高値 ${f2(ph)} を更新`);

  const s75 = ind.sma75[i], s25 = ind.sma25[i], s25p = ind.sma25[i - 5];
  if (s75 != null && s25 != null && s25p != null) {
    if (price > s75 && s25 > s25p) add('uptrend', '75日線の上・25日線が上向き');
    if (price < s75 && s25 < s25p) add('downtrend', '75日線の下・25日線が下向き');
  }
  return out;
}

export function scoreOf(ids, weights = BASE_WEIGHTS) {
  const sum = ids.reduce((a, id) => a + (weights[id] ?? BASE_WEIGHTS[id] ?? 0), 0);
  return Math.max(-100, Math.min(100, sum));
}

// 最新日（または指定日）の総合判定
export function analyze(candles, weights = BASE_WEIGHTS, ind = null) {
  if (!candles || candles.length < 30) {
    return { score: 0, signals: [], verdict: verdictOf(0), ind: null };
  }
  ind = ind || computeIndicators(candles);
  const fired = signalsAt(ind, candles.length - 1);
  const signals = fired
    .map((f) => ({ ...f, label: SIGNAL_MAP[f.id].label, weight: weights[f.id] ?? SIGNAL_MAP[f.id].base }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const score = scoreOf(fired.map((f) => f.id), weights);
  return { score, signals, verdict: verdictOf(score), ind };
}
