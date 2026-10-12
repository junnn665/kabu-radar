// GitHub Actions のデータ生成（build_data.mjs）をシミュレーション価格で通しで実行する
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DemoProvider } from '../js/providers.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('build_data generates all files and keeps paper-trade state between runs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-'));
  const raw = path.join(tmp, 'raw'), out1 = path.join(tmp, 'out1'), out2 = path.join(tmp, 'out2');
  fs.mkdirSync(raw);
  const uni = read(path.join(root, 'config/universe.json')).symbols.slice(0, 20);
  const demo = new DemoProvider();
  const history = {};
  for (const u of uni) history[u.sym] = await demo.getDailyCandles(u.sym);
  const soon = new Date(Date.now() + 9 * 3600e3 + 2 * 86400e3).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(raw, 'history.json'), JSON.stringify(history));
  fs.writeFileSync(path.join(raw, 'events.json'), JSON.stringify({ date: 'x', events: { [uni[0].sym]: { earnings: soon, exDiv: null } } }));
  const market = {};
  for (const k of ['N225', 'SPX', 'VIX', 'USDJPY']) market[k] = await demo.getDailyCandles(k);
  fs.writeFileSync(path.join(raw, 'market.json'), JSON.stringify(market));
  fs.writeFileSync(path.join(raw, 'fundamentals.json'), JSON.stringify({ date: 'x', fundamentals: { [uni[0].sym]: { per: 12.3, pbr: 0.9, divYield: 0.035 } } }));
  fs.writeFileSync(path.join(raw, 'news.json'), JSON.stringify({ date: 'x', news: { [uni[0].sym]: [{ title: 'テスト' }] } }));

  const run = (prev, out) => execFileSync('node', ['scripts/build_data.mjs', '--raw', raw, '--prev', prev, '--out', out], {
    cwd: root, env: { ...process.env, ANTHROPIC_API_KEY: '', NTFY_TOPIC: '', AI_PROVIDER: 'none' }, encoding: 'utf8',
  });
  run(path.join(tmp, 'none'), out1);
  for (const f of ['quotes', 'screener', 'backtest', 'paper', 'events', 'news', 'ai', 'meta', 'market', 'fundamentals', 'review']) {
    assert.ok(fs.existsSync(path.join(out1, `${f}.json`)), f);
  }
  assert.ok(fs.existsSync(path.join(out1, 'candles', `${uni[0].sym}.json`)));
  const scr = read(path.join(out1, 'screener.json'));
  assert.equal(scr.rows.length, 20);
  const first = scr.rows.find((r) => r.sym === uni[0].sym);
  assert.equal(first.events.earnings, soon);
  assert.equal(first.pbr, 0.9);
  assert.ok(first.stop < first.price && first.target > first.price);
  for (const r of scr.rows) assert.equal(r.score, Math.max(-100, r.rawScore - r.penalty));
  const mk = read(path.join(out1, 'market.json'));
  assert.ok(mk.regime.JP && mk.regime.US && mk.indices.N225);
  const rv = read(path.join(out1, 'review.json'));
  assert.ok(Array.isArray(rv.weeks));
  const bt = read(path.join(out1, 'backtest.json'));
  assert.ok(bt.tuned && bt.strategy.base && bt.strategy.filtered && bt.stats.golden_cross && bt.byRegime);

  const p1 = read(path.join(out1, 'paper.json'));
  const strongNow = scr.rows.filter((r) => r.score >= 40).length;
  assert.equal(p1.open.length, strongNow);

  run(out1, out2); // 2回目：同じ価格なら二重に買わない
  const p2 = read(path.join(out2, 'paper.json'));
  assert.equal(p2.startedAt, p1.startedAt);
  assert.equal(p2.open.length + p2.closed.length, p1.open.length + p1.closed.length);
});
