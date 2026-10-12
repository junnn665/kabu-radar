import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atr } from '../js/indicators.js';
import { levels, holdingLevels } from '../js/levels.js';
import { makeRegime } from '../js/market.js';
import { computeReview } from '../js/review.js';
import { signalStats, simulate } from '../js/backtest.js';
import { DemoProvider } from '../js/providers.js';

const bars = (closes, start = '2026-01-01') => closes.map((c, i) => {
  const d = new Date(Date.parse(start) + i * 86400e3).toISOString().slice(0, 10);
  return { date: d, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 };
});

test('ATR of constant 2-wide bars is 2', () => {
  const a = atr(bars(new Array(30).fill(100)));
  assert.equal(a.at(-1), 2);
});

test('levels: stop below, target above, ratio 2:3', () => {
  const lv = levels(bars(new Array(30).fill(100)));
  assert.equal(lv.stop, 96); assert.equal(lv.target, 106);
  const h = holdingLevels(bars(new Array(30).fill(100)), 90);
  assert.equal(h.stop, Math.max(90 - 4, 100 - 6));
  assert.equal(h.target, 96);
});

test('regime: falling index + high VIX gives a penalty, calm market none', () => {
  const down = bars(Array.from({ length: 60 }, (_, i) => 1000 - i * 5));
  const flat = bars(Array.from({ length: 60 }, () => 1000));
  const vixHigh = bars(new Array(60).fill(32));
  const vixLow = bars(new Array(60).fill(14));
  const bad = makeRegime({ N225: down, SPX: down, VIX: vixHigh })('US', down.at(-1).date);
  assert.ok(bad.penalty >= 20 && bad.state.key === 'bad', JSON.stringify(bad));
  const good = makeRegime({ N225: flat, SPX: flat, VIX: vixLow })('JP', flat.at(-1).date);
  assert.equal(good.penalty, 0);
  assert.equal(makeRegime({})('JP', '2026-01-01').penalty, 0);
});

test('review groups strong picks by week and filters by penalty', async () => {
  const demo = new DemoProvider();
  const series = {};
  for (const s of ['AAPL', 'NVDA', '7203', '6758', 'MSFT', 'TSLA']) series[s] = await demo.getDailyCandles(s);
  const r = computeReview(series, { days: 60 });
  assert.equal(r.total.n, r.weeks.reduce((a, w) => a + w.n, 0));
  r.weeks.forEach((w) => w.picks.forEach((p) => assert.ok(p.score >= 40)));
  const none = computeReview(series, { days: 60, penaltyOf: () => 200 });
  assert.equal(none.total.n, 0);
  const bt = signalStats(series, { penaltyOf: () => 0 });
  assert.equal(bt.byRegime.bad.n, 0);
  assert.equal(simulate(series.AAPL, undefined, undefined, () => 200).length, 0);
});
