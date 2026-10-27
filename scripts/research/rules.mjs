// 売り方のルール比較（買いは「点数30以上」で同じ）。使い方: node scripts/research/rules.mjs history.json
import fs from 'node:fs';
import { simulate, tradeSummary, RULE_SETS } from '../../js/backtest.js';
import { BASE_WEIGHTS } from '../../js/signals.js';

const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const history = {};
for (const [s, b] of Object.entries(raw)) {
  if (!b?.d || b.d.length < 120) continue;
  history[s] = b.d.map((d, i) => ({ date: d, open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i], volume: b.v[i] }));
}
const dates = [...new Set(Object.values(history).flatMap((cs) => cs.slice(-80).map((c) => c.date)))].sort();
const cut60 = dates[Math.max(0, dates.length - 60)], cut250 = dates[Math.max(0, dates.length - 250)];
for (const [k, { label, rules }] of Object.entries(RULE_SETS)) {
  const all = [];
  for (const cs of Object.values(history)) all.push(...simulate(cs, BASE_WEIGHTS, rules));
  const f = (t) => `平均${((t.avg || 0) * 100).toFixed(2)}% 勝率${Math.round((t.win || 0) * 100)}% ${t.n}回 保有${(t.avgHeld || 0).toFixed(1)}日`;
  console.log(`RULES ${k}（${label}）: 3年 ${f(tradeSummary(all))} ｜直近1年 ${f(tradeSummary(all.filter((t) => t.entryDate >= cut250)))} ｜直近60日 ${f(tradeSummary(all.filter((t) => t.entryDate >= cut60)))}`);
}
