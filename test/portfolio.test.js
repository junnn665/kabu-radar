import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dividendPlan, concentration, upcoming, TAX } from '../js/portfolio.js';

test('配当の見込み：過去12か月の1株配当×株数、月別に集計', () => {
  const divs = {
    '7203': [['2025-03-28', 40], ['2025-09-29', 45], ['2026-03-30', 45]], // 2026年9月分はまだデータに無い想定
    '9434': [['2026-03-30', 4.3], ['2026-09-29', 4.3]],
    '2928': [],
  };
  const holdings = [{ sym: '7203', shares: 300, cost: 2500 }, { sym: '9434', shares: 100, cost: 200 }, { sym: '2928', shares: 200, cost: 300 }];
  const p = dividendPlan(holdings, divs, '2026-10-12');
  const toyota = p.rows.find((r) => r.sym === '7203');
  assert.equal(toyota.perShare, 90); // 3月は新しい2026年分、9月は去年の分で補う
  assert.equal(toyota.annual, 27000);
  assert.deepEqual(toyota.months, [3, 9]);
  assert.ok(Math.abs(p.total - (27000 + 860)) < 1e-6);
  assert.ok(Math.abs(p.afterTax - p.total * (1 - TAX)) < 1e-6);
  assert.equal(p.months[2], 45 * 300 + 4.3 * 100);
  assert.equal(p.rows.find((r) => r.sym === '2928').annual, 0);
});

test('偏りチェック：業種40%超・1銘柄30%超を警告', () => {
  const c = concentration([
    { sym: 'A', sector: '情報・通信業', value: 500 },
    { sym: 'B', sector: '情報・通信業', value: 200 },
    { sym: 'C', sector: '輸送用機器', value: 300 },
  ]);
  assert.equal(c.sectors[0].name, '情報・通信業');
  assert.ok(Math.abs(c.sectors[0].w - 0.7) < 1e-9);
  assert.ok(c.warns.some((w) => w.kind === 'sector'));
  assert.ok(c.warns.some((w) => w.kind === 'stock' && w.sym === 'A'));
  assert.ok(c.effectiveN > 2 && c.effectiveN < 3);
  const even = concentration([{ sym: 'A', sector: 'x', value: 1 }, { sym: 'B', sector: 'y', value: 1 }, { sym: 'C', sector: 'z', value: 1 }, { sym: 'D', sector: 'w', value: 1 }]);
  assert.equal(even.warns.length, 0);
  assert.ok(Math.abs(even.effectiveN - 4) < 1e-9);
});

test('予定カレンダー：期間内の決算と権利落ちを日付順に', () => {
  const ev = upcoming([
    { sym: '7203', tag: 'hold', events: { earnings: '2026-11-05', exDiv: '2027-03-29' } },
    { sym: '9434', tag: 'watch', events: { earnings: '2026-10-01', exDiv: '2026-10-20', exDivEstimated: true } },
  ], '2026-10-12', 60);
  assert.deepEqual(ev.map((x) => [x.date, x.sym, x.kind]), [['2026-10-20', '9434', 'exdiv'], ['2026-11-05', '7203', 'earnings']]);
  assert.equal(ev[0].days, 8);
  assert.equal(ev[0].estimated, true);
});
