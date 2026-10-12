import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, bollinger, crossWithin } from '../js/indicators.js';
import { analyze, computeIndicators, signalsAt, scoreOf, applyStyle, BASE_WEIGHTS, SIGNALS } from '../js/signals.js';
import { signalStats, tuneWeights, simulate, tradeSummary } from '../js/backtest.js';
import { buildPrompt } from '../js/ai.js';
import { DemoProvider } from '../js/providers.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('sma', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('ema seeds with sma', () => {
  const e = ema([1, 2, 3, 4], 2);
  near(e[1], 1.5);
  near(e[2], 3 * (2 / 3) + 1.5 / 3);
});

test('rsi extremes', () => {
  const upOnly = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.equal(rsi(upOnly)[29], 100);
  near(rsi(upOnly.slice().reverse())[29], 0);
});

test('bollinger on constant series collapses', () => {
  const b = bollinger(new Array(25).fill(10));
  near(b.upper[24], 10); near(b.lower[24], 10);
});

test('crossWithin detects golden cross', () => {
  assert.equal(crossWithin([1, 1, 3], [2, 2, 2], 3), 1);
  assert.equal(crossWithin([3, 3, 1], [2, 2, 2], 3), -1);
  assert.equal(crossWithin([3, 3, 3], [2, 2, 2], 3), 0);
});

const demo = new DemoProvider();
const series = {};
for (const s of ['7203', '6758', '8306', '9984', '9999']) series[s] = await demo.getDailyCandles(s);

test('analyze: bounded score, labels, honours weights', () => {
  for (const cs of Object.values(series)) {
    const a = analyze(cs);
    assert.ok(a.score >= -100 && a.score <= 100);
    a.signals.forEach((x) => assert.ok(x.label && x.id));
    const zero = Object.fromEntries(SIGNALS.map((s) => [s.id, 0]));
    assert.equal(analyze(cs, zero).score, 0);
  }
});

test('signals do not look ahead: evaluating a prefix gives the same result', () => {
  const cs = series['7203'];
  const full = computeIndicators(cs);
  const i = 150;
  const prefix = computeIndicators(cs.slice(0, i + 1));
  assert.deepEqual(signalsAt(full, i), signalsAt(prefix, i));
});

test('scoreOf clamps', () => {
  assert.equal(scoreOf(['dip_in_uptrend', 'gap_up_volume', 'vol_surge_up', 'bb_lower', 'short_oversold', 'sharp_drop', 'hammer', 'golden_cross', 'breakout', 'uptrend']), 100);
  assert.equal(scoreOf(['trend_break', 'short_overbought', 'dead_cross', 'vol_surge_down', 'bb_upper', 'overheated', 'downtrend']), -70);
});

test('style multipliers', () => {
  const c = applyStyle(BASE_WEIGHTS, 'contrarian');
  assert.ok(c.dip_in_uptrend > BASE_WEIGHTS.dip_in_uptrend);
  assert.ok(c.gap_up_volume < BASE_WEIGHTS.gap_up_volume);
});

test('backtest stats, tuning and simulation', () => {
  const bt = signalStats(series);
  assert.ok(bt.baseline.n > 300);
  const tuned = tuneWeights(bt);
  for (const s of SIGNALS) assert.ok(Math.abs(tuned[s.id]) <= 40);
  const trades = simulate(series['7203']);
  for (const t of trades) {
    assert.ok(t.entryDate < (t.exitDate || '9999'));
    if (t.reason === '利確') assert.ok(t.ret >= 0.1);
    if (t.reason === '損切り') assert.ok(t.ret <= -0.05);
  }
  const sum = tradeSummary(trades);
  assert.equal(sum.trades, trades.length);
});

test('AI prompt contains the essentials', () => {
  const p = buildPrompt({ sym: '7203', name: 'トヨタ', price: 3000, changePct: 1.2, score: 45, verdict: '強い買いシグナル',
    signals: [{ label: 'ゴールデンクロス', weight: 25, detail: 'x' }], events: { earnings: '2026-11-05' }, news: [{ title: '新型車' }] });
  assert.match(p, /トヨタ/); assert.match(p, /ゴールデンクロス/); assert.match(p, /2026-11-05/); assert.match(p, /新型車/);
});

test('rule-based explanation: 3 lines, mentions earnings when close', async () => {
  const { ruleExplain } = await import('../js/explain.js');
  const t = ruleExplain({
    score: 40, verdict: '強い買いシグナル', today: '2026-10-12',
    signals: [{ id: 'golden_cross', label: 'ゴールデンクロス', weight: 25 }, { id: 'macd_up', label: 'MACD 好転', weight: 15 }],
    stats: { golden_cross: { n: 700, win: 0.48, avg: -0.0012 } },
    events: { earnings: '2026-10-20' },
  });
  const lines = t.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^なぜ今？：ゴールデンクロスとMACD 好転/);
  assert.match(lines[1], /勝率48%/);
  assert.match(lines[2], /10\/20に決算/);
});
