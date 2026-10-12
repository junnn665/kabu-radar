import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, bollinger, crossWithin } from '../js/indicators.js';
import { analyze } from '../js/signals.js';
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
  const downOnly = upOnly.slice().reverse();
  near(rsi(downOnly)[29], 0);
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

test('analyze works on demo data and score is bounded', async () => {
  const p = new DemoProvider();
  for (const s of ['AAPL', '7203', 'ZZZ']) {
    const cs = await p.getDailyCandles(s);
    assert.ok(cs.length > 150);
    const a = analyze(cs);
    assert.ok(a.score >= -100 && a.score <= 100);
    assert.ok(a.verdict.label);
  }
});
