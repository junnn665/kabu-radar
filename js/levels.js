// 損切り・利確の目安（ATR＝その銘柄の普段の値幅を基準にする）
import { atr } from './indicators.js';

export const STOP_ATR = 2;   // 損切り：普段の値幅の2倍下
export const TARGET_ATR = 3; // 利確：普段の値幅の3倍上（損益比 1.5）

export function levels(candles) {
  if (!candles || candles.length < 20) return null;
  const a = atr(candles).at(-1);
  if (!a) return null;
  const price = candles.at(-1).close;
  const stop = price - STOP_ATR * a, target = price + TARGET_ATR * a;
  return { atr: a, atrPct: a / price, price, stop, target, stopPct: stop / price - 1, targetPct: target / price - 1 };
}

// 保有株用：買値基準の損切りと、直近高値から下がったら利益を守るトレーリングの高い方
export function holdingLevels(candles, cost) {
  const lv = levels(candles);
  if (!lv) return null;
  const recentHigh = Math.max(...candles.slice(-22).map((c) => c.close));
  const fromCost = cost - STOP_ATR * lv.atr;
  const trailing = recentHigh - 3 * lv.atr;
  const stop = Math.max(fromCost, trailing);
  return {
    ...lv,
    stop,
    stopKind: trailing > fromCost ? '直近高値からのトレーリング' : '買値から',
    target: cost + TARGET_ATR * lv.atr,
  };
}
