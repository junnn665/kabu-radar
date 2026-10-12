// 狙い目判定エンジン。日足ローソク足から複数のテクニカルシグナルを採点する。
import { sma, rsi, bollinger, macd, crossWithin, last } from './indicators.js';

export const VERDICTS = [
  { min: 40, key: 'strong', label: '強い買いシグナル' },
  { min: 20, key: 'watch', label: '注目' },
  { min: -29, key: 'neutral', label: '中立' },
  { min: -Infinity, key: 'caution', label: '警戒' },
];

export function analyze(candles) {
  if (!candles || candles.length < 30) {
    return { score: 0, signals: [], verdict: VERDICTS[2], ind: null };
  }
  const close = candles.map((c) => c.close);
  const vol = candles.map((c) => c.volume || 0);
  const price = last(close);

  const ind = {
    sma5: sma(close, 5),
    sma25: sma(close, 25),
    sma75: sma(close, 75),
    rsi: rsi(close, 14),
    bb: bollinger(close, 20, 2),
    macd: macd(close),
  };

  const signals = [];
  const add = (weight, label, detail) => signals.push({ weight, label, detail });

  // 1. RSI
  const r = last(ind.rsi);
  if (r != null) {
    if (r < 30) add(25, '売られすぎ (RSI)', `RSI ${r.toFixed(1)} — 反発の余地`);
    else if (r < 40) add(8, 'やや売られ気味', `RSI ${r.toFixed(1)}`);
    else if (r > 75) add(-20, '買われすぎ (RSI)', `RSI ${r.toFixed(1)} — 高値掴み注意`);
    else if (r > 70) add(-10, 'やや過熱', `RSI ${r.toFixed(1)}`);
  }

  // 2. ゴールデンクロス / デッドクロス（5日線と25日線、直近3本）
  const gc = crossWithin(ind.sma5, ind.sma25, 3);
  if (gc === 1) add(25, 'ゴールデンクロス', '5日線が25日線を上抜け');
  if (gc === -1) add(-25, 'デッドクロス', '5日線が25日線を下抜け');

  // 3. ボリンジャーバンド
  const lo = last(ind.bb.lower), up = last(ind.bb.upper);
  if (lo != null && price <= lo) add(15, 'ボリンジャー下限タッチ', `-2σ (${lo.toFixed(2)}) 以下 — 逆張り候補`);
  if (up != null && price >= up) add(-10, 'ボリンジャー上限', `+2σ (${up.toFixed(2)}) 以上`);

  // 4. MACD ヒストグラムの符号転換（直近3本）
  const h = ind.macd.hist;
  for (let i = h.length - 1; i > 0 && i >= h.length - 3; i--) {
    if (h[i] == null || h[i - 1] == null) continue;
    if (h[i - 1] <= 0 && h[i] > 0) { add(15, 'MACD 好転', 'MACDがシグナルを上抜け'); break; }
    if (h[i - 1] >= 0 && h[i] < 0) { add(-15, 'MACD 悪化', 'MACDがシグナルを下抜け'); break; }
  }

  // 5. 出来高急増 × 上昇
  if (vol.length >= 21) {
    const avg = vol.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const ratio = avg > 0 ? last(vol) / avg : 0;
    const chg = (price - close[close.length - 2]) / close[close.length - 2];
    if (ratio >= 2 && chg > 0) add(15, '出来高急増', `20日平均の ${ratio.toFixed(1)} 倍・上昇`);
    else if (ratio >= 2 && chg < 0) add(-10, '出来高を伴う下落', `20日平均の ${ratio.toFixed(1)} 倍`);
  }

  // 6. 高値ブレイク（取得期間内の最高値更新）
  const prevHigh = Math.max(...candles.slice(0, -1).map((c) => c.high));
  if (price > prevHigh) add(10, '高値ブレイク', `期間高値 ${prevHigh.toFixed(2)} を更新`);

  // 7. 中期トレンド
  const s25 = ind.sma25, s75 = last(ind.sma75);
  const s25up = s25.length > 5 && last(s25) != null && s25[s25.length - 6] != null && last(s25) > s25[s25.length - 6];
  if (s75 != null && price > s75 && s25up) add(10, '上昇トレンド', '75日線の上・25日線が上向き');
  if (s75 != null && price < s75 && !s25up) add(-10, '下降トレンド', '75日線の下・25日線が下向き');

  const score = Math.max(-100, Math.min(100, signals.reduce((a, s) => a + s.weight, 0)));
  const verdict = VERDICTS.find((v) => score >= v.min);
  signals.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return { score, signals, verdict, ind };
}
