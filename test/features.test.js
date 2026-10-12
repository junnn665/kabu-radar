import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atr } from '../js/indicators.js';
import { levels, holdingLevels } from '../js/levels.js';
import { makeRegime } from '../js/market.js';
import { computeReview } from '../js/review.js';
import { signalStats, simulate } from '../js/backtest.js';
import { DemoProvider } from '../js/providers.js';
import { STRONG } from '../js/signals.js';
import { buildPanel, panelStats, walkForward } from '../js/backtest.js';

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
  for (const s of ['7203', '6758', '8306', '9984', '8035', '6501']) series[s] = await demo.getDailyCandles(s);
  const r = computeReview(series, { days: 60 });
  assert.equal(r.total.n, r.weeks.reduce((a, w) => a + w.n, 0));
  r.weeks.forEach((w) => w.picks.forEach((p) => assert.ok(p.score >= STRONG)));
  const none = computeReview(series, { days: 60, penaltyOf: () => 200 });
  assert.equal(none.total.n, 0);
  const bt = signalStats(series, { penaltyOf: () => 0 });
  assert.equal(bt.byRegime.bad.n, 0);
  assert.equal(simulate(series['7203'], undefined, undefined, () => 200).length, 0);
});

test('panel: excess returns average to ~0 per day; walk-forward runs without look-ahead', async () => {
  const demo = new DemoProvider();
  const series = {};
  for (const s of ['7203', '6758', '8306', '9984', '8035', '6501', '7974', '8058']) series[s] = await demo.getDailyCandles(s);
  const P = buildPanel(series, { horizon: 5, minTurnover: 0 });
  let sum = 0, n = 0;
  for (let k = 0; k < P.n; k++) if (!Number.isNaN(P.ex[k])) { sum += P.ex[k]; n++; }
  assert.ok(Math.abs(sum / n) < 1e-9);
  const st = panelStats(P);
  assert.ok(st.baseline.n > 500 && Math.abs(st.baseline.excess) < 1e-9);
  const wf = walkForward(P, { window: 60, step: 5 });
  assert.ok(wf.testFrom > P.dates[0]);
  assert.ok(wf.weightsNow && typeof wf.weightsNow.dip_in_uptrend === 'number');
  // 未来のデータを足しても、過去の時点の配点は変わらない
  const cut = {};
  for (const [s, cs] of Object.entries(series)) cut[s] = cs.slice(0, -20);
  const wf2 = walkForward(buildPanel(cut, { horizon: 5, minTurnover: 0 }), { window: 60, step: 5 });
  assert.equal(wf2.testFrom, wf.testFrom === wf2.testFrom ? wf.testFrom : wf2.testFrom);
});

test('liquidity filter drops thin stocks from the panel', async () => {
  const demo = new DemoProvider();
  const cs = await demo.getDailyCandles('7203');
  const thin = cs.map((c) => ({ ...c, volume: 10 }));
  assert.equal(buildPanel({ A: thin }).n, 0);
  assert.ok(buildPanel({ A: cs }).n > 0);
});

test('AI live tracking: logs liquid predictions and scores them 5 days later', async () => {
  const { updateLog, evaluateLog } = await import('../js/aitrack.js');
  const demo = new DemoProvider();
  const history = {};
  const syms = Array.from({ length: 60 }, (_, i) => String(1300 + i));
  for (const s of syms) history[s] = await demo.getDailyCandles(s);
  const dates = history[syms[0]].map((c) => c.date);
  const d0 = dates.at(-10), d1 = dates.at(-2);
  // 予測＝実際の5日後リターン（完全に当たる予測）なら、上位は市場平均を上回り IC は 1 になる
  const perfect = Object.fromEntries(syms.map((s) => { const cs = history[s]; const i = cs.findIndex((c) => c.date === d0); return [s, [(cs[i + 5].close / cs[i].close - 1) * 100, 0.5]]; }));
  let log = updateLog(null, d0, perfect);
  log = updateLog(log, d1, { ...perfect, thin: [5, null] });
  assert.ok(!('thin' in log.days[d1]));
  const r = evaluateLog(log, history);
  const day0 = r.days.find((d) => d.date === d0);
  assert.ok(day0.done && day0.top.excess > 0 && day0.bottom.excess < 0);
  assert.ok(day0.ic > 0.99);
  assert.equal(r.days.find((d) => d.date === d1).done, false);
  assert.equal(r.total.days, 1);
});

test('CSV import: SBI証券のポートフォリオ（Shift_JIS・特定とNISAに分割）', async () => {
  const { decodeCsv, parseCsvText, extractHoldings } = await import('../js/csvimport.js');
  const fs = await import('node:fs');
  const buf = fs.readFileSync(new URL('./fixtures/sbi_portfolio.csv', import.meta.url));
  const { holdings } = extractHoldings(parseCsvText(decodeCsv(buf)));
  const by = Object.fromEntries(holdings.map((h) => [h.sym, h]));
  assert.deepEqual(Object.keys(by).sort(), ['2928', '7203', '8219', '9434']); // 投資信託は除外
  assert.equal(by['7203'].shares, 300);
  assert.equal(by['7203'].cost, Math.round(((2800 * 100 + 2500 * 200) / 300) * 100) / 100);
  assert.equal(by['2928'].cost, 1247);
  assert.equal(by['8219'].name, '青山商事');
  // 楽天証券のような「銘柄コード」列の形式
  const r = extractHoldings(parseCsvText('銘柄コード,銘柄,口座,保有数量,平均取得価額\n7203,トヨタ自動車,特定,"1,000","2,750.5"\n'));
  assert.deepEqual(r.holdings.map((h) => [h.sym, h.shares, h.cost]), [['7203', 1000, 2750.5]]);
});
