// raw/（fetch_data.py の出力）と prev/（前回の公開データ）から、サイトが読む data/ を生成する。
//   candles/<sym>.json, quotes.json, screener.json, backtest.json, paper.json,
//   events.json, news.json, ai.json, meta.json
// 環境変数（任意）: ANTHROPIC_API_KEY, AI_MODEL, NTFY_TOPIC, SITE_URL
//
// 使い方: node scripts/build_data.mjs --raw raw --prev prev --out data
import fs from 'node:fs';
import path from 'node:path';
import { analyze, scoreOf, verdictOf, SIGNAL_MAP, BASE_WEIGHTS } from '../js/signals.js';
import { signalStats, tuneWeights, simulate, tradeSummary, DEFAULT_RULES } from '../js/backtest.js';
import { explain, explainGithub, AI_MODEL_DEFAULT, GH_MODEL_DEFAULT } from '../js/ai.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const RAW = args.raw || 'raw', PREV = args.prev || 'prev', OUT = args.out || 'data';
const UNIVERSE = args.universe || 'config/universe.json';
const NOTIONAL = 100000;

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); };

const now = new Date();
const jstDate = new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);

function marketOpen(market) {
  const tz = market === 'JP' ? 'Asia/Tokyo' : 'America/New_York';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  if (['Sat', 'Sun'].includes(parts.weekday)) return false;
  const m = +parts.hour * 60 + +parts.minute;
  return market === 'JP' ? m >= 540 && m < 930 : m >= 570 && m < 960;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.round((Date.parse(dateStr) - Date.parse(jstDate)) / 86400e3);
}

async function ntfy(title, message, tags = []) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic, title, message, tags, click: process.env.SITE_URL || undefined }),
    });
  } catch (e) {
    console.warn('ntfy failed:', e.message);
  }
}

async function main() {
  const universe = readJson(UNIVERSE, { symbols: [] }).symbols;
  const meta = Object.fromEntries(universe.map((u) => [u.sym, u]));
  const history = readJson(path.join(RAW, 'history.json'), {});
  const eventsDoc = readJson(path.join(RAW, 'events.json'), { events: {} });
  const newsDoc = readJson(path.join(RAW, 'news.json'), { news: {} });
  const prevScreener = readJson(path.join(PREV, 'screener.json'), { rows: [] });
  const prevAi = readJson(path.join(PREV, 'ai.json'), {});
  const prevNotified = readJson(path.join(PREV, 'notified.json'), {});
  const syms = Object.keys(history).filter((s) => meta[s]);
  if (!syms.length) throw new Error('history.json が空です');

  // 1) 日足とクォート
  const quotes = {};
  for (const s of syms) {
    const cs = history[s];
    writeJson(path.join(OUT, 'candles', `${s}.json`), cs);
    const last = cs[cs.length - 1], prev = cs[cs.length - 2] || last;
    quotes[s] = {
      price: last.close, prevClose: prev.close, change: last.close - prev.close,
      changePct: ((last.close - prev.close) / prev.close) * 100, volume: last.volume,
      name: meta[s].name, market: meta[s].market, marketOpen: marketOpen(meta[s].market), date: last.date,
    };
  }
  writeJson(path.join(OUT, 'quotes.json'), { updatedAt: now.toISOString(), quotes });

  // 2) バックテスト・自動チューニング
  const series = Object.fromEntries(syms.map((s) => [s, history[s]]));
  const bt = signalStats(series, { horizon: 5 });
  const tuned = tuneWeights(bt);
  const strategy = {};
  const recentTrades = [];
  for (const [mode, w] of [['base', BASE_WEIGHTS], ['tuned', tuned]]) {
    const all = [];
    for (const s of syms) {
      const tr = simulate(history[s], w, DEFAULT_RULES).map((t) => ({ ...t, sym: s, name: meta[s].name }));
      all.push(...tr);
      if (mode === 'base') recentTrades.push(...tr);
    }
    strategy[mode] = tradeSummary(all, NOTIONAL);
  }
  recentTrades.sort((a, b) => (b.entryDate > a.entryDate ? 1 : -1));
  writeJson(path.join(OUT, 'backtest.json'), {
    updatedAt: now.toISOString(), ...bt, tuned, rules: DEFAULT_RULES, notional: NOTIONAL, strategy,
    trades: recentTrades.slice(0, 120),
  });

  // 3) スクリーナー
  const events = eventsDoc.events || {};
  const news = newsDoc.news || {};
  const rows = syms.map((s) => {
    const a = analyze(history[s]);
    const ids = a.signals.map((x) => x.id);
    return {
      sym: s, name: meta[s].name, market: meta[s].market,
      price: quotes[s].price, changePct: quotes[s].changePct,
      score: a.score, tunedScore: scoreOf(ids, tuned), ids,
      details: Object.fromEntries(a.signals.map((x) => [x.id, x.detail])),
      events: events[s] || null,
    };
  }).sort((x, y) => y.score - x.score);
  writeJson(path.join(OUT, 'screener.json'), { updatedAt: now.toISOString(), rows });
  writeJson(path.join(OUT, 'events.json'), eventsDoc);
  writeJson(path.join(OUT, 'news.json'), newsDoc);

  // 4) ペーパートレード（実運用ログ。サジェスト通り＝標準配点で機械的に売買）
  const paper = readJson(path.join(PREV, 'paper.json'), null) || {
    startedAt: jstDate, notional: NOTIONAL, rules: DEFAULT_RULES, open: [], closed: [],
  };
  const R = paper.rules;
  const opened = [], closedNow = [];
  const scoreBySym = Object.fromEntries(rows.map((r) => [r.sym, r]));
  paper.open = paper.open.filter((p) => {
    const cs = history[p.sym];
    const row = scoreBySym[p.sym];
    if (!cs || !row) return true;
    const entryIdx = cs.findIndex((c) => c.date >= p.entryDate);
    const held = entryIdx < 0 ? 0 : cs.length - 1 - entryIdx;
    const px = cs[cs.length - 1].close;
    const ret = px / p.entryPrice - 1;
    p.lastPrice = px; p.ret = ret; p.held = held;
    let reason = null;
    if (ret >= R.takeProfit) reason = '利確';
    else if (ret <= R.stopLoss) reason = '損切り';
    else if (row.score <= R.exitScore) reason = 'スコア悪化';
    else if (held >= R.hold) reason = '保有期限';
    if (!reason) return true;
    const t = { ...p, exitDate: cs[cs.length - 1].date, exitPrice: px, ret, reason, pnl: Math.round(ret * paper.notional) };
    paper.closed.unshift(t); closedNow.push(t);
    return false;
  });
  const openSyms = new Set(paper.open.map((p) => p.sym));
  for (const r of rows) {
    if (r.score < R.entry || openSyms.has(r.sym)) continue;
    if (paper.closed.some((c) => c.sym === r.sym && c.exitDate === quotes[r.sym].date)) continue;
    const p = { sym: r.sym, name: r.name, market: r.market, entryDate: quotes[r.sym].date, entryPrice: r.price, score: r.score, signals: r.ids, lastPrice: r.price, ret: 0, held: 0 };
    paper.open.push(p); opened.push(p);
  }
  paper.closed = paper.closed.slice(0, 500);
  paper.updatedAt = now.toISOString();
  writeJson(path.join(OUT, 'paper.json'), paper);

  // 5) AI「なぜ今？」解説（上位5銘柄、シグナルの組み合わせが変わった時だけ再生成）
  //    ANTHROPIC_API_KEY があれば Claude（有料）、なければ GitHub Models の無料枠を使う
  const ai = { ...prevAi };
  const useClaude = !!process.env.ANTHROPIC_API_KEY;
  const useGithub = !useClaude && !!process.env.GITHUB_TOKEN && process.env.AI_PROVIDER !== 'none';
  const aiOn = useClaude || useGithub;
  let aiFailures = 0;
  if (aiOn) {
    for (const r of rows.filter((x) => x.score >= 20).slice(0, 5)) {
      const key = `${jstDate}:${[...r.ids].sort().join(',')}`;
      if (ai[r.sym]?.key === key) continue;
      if (aiFailures >= 2) break; // 無料枠の上限などで失敗が続いたら今回は諦める
      const ctx = {
        sym: r.sym, name: r.name, price: r.price, changePct: r.changePct, score: r.score,
        verdict: verdictOf(r.score).label, events: r.events, news: news[r.sym],
        signals: r.ids.map((id) => ({ label: SIGNAL_MAP[id].label, weight: BASE_WEIGHTS[id], detail: r.details[id] })),
        stats: r.ids.map((id) => ({ label: SIGNAL_MAP[id].label, ...bt.stats[id] })).filter((s) => s.n),
      };
      try {
        const text = useClaude
          ? await explain({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.AI_MODEL || AI_MODEL_DEFAULT, ctx })
          : await explainGithub({ token: process.env.GITHUB_TOKEN, model: process.env.GH_MODEL || GH_MODEL_DEFAULT, ctx });
        if (text) ai[r.sym] = { key, date: jstDate, text, source: useClaude ? 'Claude' : 'GitHub Models', generatedAt: now.toISOString() };
      } catch (e) {
        aiFailures++;
        console.warn(`AI ${r.sym}:`, e.message);
      }
    }
  }
  writeJson(path.join(OUT, 'ai.json'), ai);

  // 6) スマホ通知（ntfy）
  const prevScore = Object.fromEntries((prevScreener.rows || []).map((r) => [r.sym, r.score]));
  const newStrong = rows.filter((r) => r.score >= 40 && prevScreener.rows?.length && (prevScore[r.sym] ?? 0) < 40);
  if (newStrong.length) {
    await ntfy('強い買いシグナル', newStrong.map((r) => `${r.name}(${r.sym}) ${r.score}点: ${r.ids.slice(0, 2).map((id) => SIGNAL_MAP[id].label).join('・')}`).join('\n'), ['chart_with_upwards_trend']);
  }
  if (opened.length || closedNow.length) {
    const msg = [
      ...opened.map((p) => `買 ${p.name}(${p.sym}) @${p.entryPrice.toFixed(2)}`),
      ...closedNow.map((t) => `売 ${t.name}(${t.sym}) ${t.reason} ${(t.ret * 100).toFixed(1)}%`),
    ].join('\n');
    await ntfy('ペーパートレード', msg, ['memo']);
  }
  const notified = { ...prevNotified };
  if (notified.eventsDate !== jstDate) {
    const soon = rows.flatMap((r) => {
      const e = r.events || {};
      const out = [];
      const de = daysUntil(e.earnings), dx = daysUntil(e.exDiv);
      if (de != null && de >= 0 && de <= 2) out.push(`${r.name} 決算 ${de === 0 ? '今日' : de + '日後'}`);
      if (dx != null && dx >= 0 && dx <= 2) out.push(`${r.name} 権利落ち ${dx === 0 ? '今日' : dx + '日後'}${e.exDivEstimated ? '(推定)' : ''}`);
      return out;
    });
    if (soon.length) await ntfy('決算・権利落ちが近い銘柄', soon.join('\n'), ['warning']);
    notified.eventsDate = jstDate;
  }
  writeJson(path.join(OUT, 'notified.json'), notified);

  writeJson(path.join(OUT, 'meta.json'), {
    updatedAt: now.toISOString(), symbols: syms.length, ai: aiOn ? (useClaude ? 'Claude' : 'GitHub Models') : false, ntfy: !!process.env.NTFY_TOPIC,
    eventsDate: eventsDoc.date || null,
  });
  console.log(`built ${syms.length} symbols; strong=${rows.filter((r) => r.score >= 40).length}; paper open=${paper.open.length} (+${opened.length}/-${closedNow.length})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
