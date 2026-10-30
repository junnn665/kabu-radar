// raw/（fetch_data.py の出力）と prev/（前回の状態）から、サイトが読む data/ を生成する。
//   candles/<コード>.json（列形式）, quotes.json, universe.json, screener.json, backtest.json, paper.json,
//   review.json, market.json, events.json, news.json, fundamentals.json, ai.json, meta.json
// 環境変数（任意）: ANTHROPIC_API_KEY, AI_MODEL, AI_PROVIDER, GITHUB_TOKEN, NTFY_TOPIC, SITE_URL
//
// 使い方: node scripts/build_data.mjs --raw raw --prev prev --out data
import fs from 'node:fs';
import path from 'node:path';
import { analyze, scoreOf, verdictOf, SIGNAL_MAP, BASE_WEIGHTS, STRONG, WATCH } from '../js/signals.js';
import { buildPanel, panelStats, walkForward, simulate, tradeSummary, DEFAULT_RULES, RULE_SETS } from '../js/backtest.js';
import { makeRegime } from '../js/market.js';
import { computeReview } from '../js/review.js';
import { levels } from '../js/levels.js';
import { updateLog, evaluateLog } from '../js/aitrack.js';
import { explain, explainGithub, AI_MODEL_DEFAULT, GH_MODEL_DEFAULT } from '../js/ai.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const RAW = args.raw || 'raw', PREV = args.prev || 'prev', OUT = args.out || 'data';
const NOTIONAL = 100000;
const MAX_NEW_PAPER = 8;    // 1回の更新で新しく買う上限
const MAX_OPEN_PAPER = 30;  // 同時に持つ上限
const PUBLISH_BARS = 260;   // サイトに出す日足（学習用には約3年分を持っている）
// AI予測で売買する仮想口座のルール（予測期間が5営業日なので最長5日）
// 上位5%の中から、同じ業種は2銘柄までで1日最大5銘柄（ホームのAIピックと同じ考え方。上位1%だと銀行株ばかりで2銘柄しか買えなかった）
const AI_RULES = { entryRank: 0.95, hold: 5, takeProfit: 0.1, stopLoss: -0.05, maxNew: 5, maxOpen: 25, maxPerSector: 2 };

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); };
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

const now = new Date();
const jstDate = new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);

function marketOpenJP() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  if (['Sat', 'Sun'].includes(p.weekday)) return false;
  const m = +p.hour * 60 + +p.minute;
  return m >= 540 && m < 930;
}
const daysUntil = (d) => (d ? Math.round((Date.parse(d) - Date.parse(jstDate)) / 86400e3) : null);

async function ntfy(title, message, tags = []) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    await fetch('https://ntfy.sh/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic, title, message, tags, click: process.env.SITE_URL || undefined }),
    });
  } catch (e) { console.warn('ntfy failed:', e.message); }
}

// 列形式 {d,o,h,l,c,v} ⇔ ローソク足配列
const toCandles = (b) => b.d.map((d, i) => ({ date: d, open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i], volume: b.v[i] }));
const fromCandles = (cs) => ({ d: cs.map((c) => c.date), o: cs.map((c) => r2(c.open)), h: cs.map((c) => r2(c.high)), l: cs.map((c) => r2(c.low)), c: cs.map((c) => r2(c.close)), v: cs.map((c) => c.volume) });

async function main() {
  const t0 = Date.now();
  const uniDoc = readJson(path.join(RAW, 'universe.json'), null) || { symbols: readJson('config/universe.json', { symbols: [] }).symbols };
  const meta = Object.fromEntries(uniDoc.symbols.map((u) => [u.sym, { ...u, market: 'JP' }]));
  const rawHist = readJson(path.join(RAW, 'history.json'), {});
  const history = {};
  for (const [s, b] of Object.entries(rawHist)) {
    if (!meta[s]) continue;
    const cs = Array.isArray(b) ? b : toCandles(b);
    if (cs.length >= 30) history[s] = cs;
  }
  const syms = Object.keys(history);
  if (!syms.length) throw new Error('history.json が空です');
  const eventsDoc = readJson(path.join(RAW, 'events.json'), { events: {} });
  const newsDoc = readJson(path.join(RAW, 'news.json'), { news: {} });
  const market = readJson(path.join(RAW, 'market.json'), {});
  const fundaDoc = readJson(path.join(RAW, 'fundamentals.json'), { fundamentals: {} });
  const fetchMeta = readJson(path.join(RAW, 'fetch_meta.json'), null);
  // 重い計算（3年分のバックテスト・答え合わせ）は朝の全件取得のときだけ。日中は前回の結果を使い回す
  const MODE = args.mode || (fetchMeta?.history?.mode === 'intraday' ? 'intraday' : 'daily');
  const predDoc = readJson(path.join(RAW, 'predictions.json'), null);
  const preds = predDoc?.preds || {};
  // 1か月（20営業日）先の予測。日中は約15分おきにしか作らないので、無い回は前回の値を使う
  const pred20Doc = readJson(path.join(RAW, 'predictions_20.json'), null);
  const prevRows = readJson(path.join(PREV, 'screener.json'), { rows: [] }).rows || [];
  const preds20 = pred20Doc?.preds || Object.fromEntries(prevRows.filter((r) => r.pred20 != null).map((r) => [r.sym, [r.pred20, r.aiRank20]]));
  const funda = fundaDoc.fundamentals || {};
  const events = eventsDoc.events || {};
  const news = newsDoc.news || {};
  const prevScreener = readJson(path.join(PREV, 'screener.json'), { rows: [] });
  const prevAi = readJson(path.join(PREV, 'ai.json'), {});
  const prevNotified = readJson(path.join(PREV, 'notified.json'), {});

  // 1) 日足（列形式で軽量化）・クォート・銘柄一覧
  const quotes = {};
  for (const s of syms) {
    const cs = history[s];
    writeJson(path.join(OUT, 'candles', `${s}.json`), fromCandles(cs.slice(-PUBLISH_BARS)));
    const last = cs.at(-1), prev = cs.at(-2) || last;
    quotes[s] = [r2(last.close), r2(prev.close), last.volume, last.date];
  }
  // 祝日は曜日・時刻だけでは分からないので、「今日の日足があるか」も見る
  const latestBar = Object.values(quotes).map((q) => q[3]).sort().at(-1);
  writeJson(path.join(OUT, 'quotes.json'), { updatedAt: now.toISOString(), marketOpen: marketOpenJP() && latestBar === jstDate, lastDate: latestBar, q: quotes });
  writeJson(path.join(OUT, 'universe.json'), {
    date: uniDoc.date || null,
    symbols: uniDoc.symbols.filter((u) => history[u.sym]).map((u) => ({ sym: u.sym, name: u.name, seg: u.seg || null, sector: u.sector || null })),
  });

  // 2) 地合い
  const regimeAt = makeRegime(market);
  const penaltyOf = (s, date) => regimeAt('JP', date).penalty;
  const lastDate = market.N225?.at(-1)?.date || syms.map((s) => history[s].at(-1).date).sort().at(-1);
  const regimeNow = { JP: regimeAt('JP', lastDate) };
  const indices = Object.fromEntries(Object.entries(market).map(([k, cs]) => {
    const l = cs.at(-1), p = cs.at(-2) || l;
    return [k, { price: l.close, changePct: (l.close / p.close - 1) * 100, date: l.date, spark: cs.slice(-30).map((c) => c.close) }];
  }));
  writeJson(path.join(OUT, 'market.json'), { updatedAt: now.toISOString(), indices, regime: regimeNow });

  // 3) バックテスト（売買代金1億円以上の日だけ・市場平均との差でも評価）とウォークフォワード学習
  const prevBt = MODE === 'intraday' ? readJson(path.join(PREV, 'backtest.json'), null) : null;
  let bt, tuned;
  if (prevBt?.stats && prevBt?.tuned) {
    bt = prevBt; tuned = prevBt.tuned;
    writeJson(path.join(OUT, 'backtest.json'), prevBt);
  } else {
  const panel = buildPanel(history, { horizon: 5, penaltyOf });
  bt = panelStats(panel);
  const wf = walkForward(panel, { window: 120, step: 5 });
  tuned = wf.weightsNow;
  const strategy = {};
  const recentTrades = [];
  for (const [mode, w, filt] of [['base', BASE_WEIGHTS, false], ['filtered', BASE_WEIGHTS, true], ['tuned', tuned, false]]) {
    const all = [];
    for (const s of syms) {
      const tr = simulate(history[s], w, DEFAULT_RULES, filt ? (d) => penaltyOf(s, d) : null);
      for (const t of tr) {
        t.sym = s; t.name = meta[s].name;
        all.push(t);
      }
      if (mode === 'base') recentTrades.push(...tr);
    }
    strategy[mode] = tradeSummary(all, NOTIONAL);
  }
  recentTrades.sort((a, b) => (b.entryDate > a.entryDate ? 1 : -1));
  // 売り方のルールの比較（買いは同じ「点数30以上」）。全体と直近60営業日
  const cut = panel.dates[Math.max(0, panel.dates.length - 60)];
  const ruleCompare = {};
  for (const [k, { label, rules }] of Object.entries(RULE_SETS)) {
    const all = [];
    for (const s of syms) all.push(...simulate(history[s], BASE_WEIGHTS, rules));
    ruleCompare[k] = { label, all: tradeSummary(all, NOTIONAL), recent: tradeSummary(all.filter((t) => t.entryDate >= cut), NOTIONAL) };
  }
  console.log('RULES ' + Object.entries(ruleCompare).map(([k, v]) => `${k}: 平均${(v.all.avg * 100).toFixed(2)}% 勝率${Math.round(v.all.win * 100)}% ${v.all.n}回 保有${(v.all.avgHeld || 0).toFixed(1)}日 ｜直近60日 平均${((v.recent.avg || 0) * 100).toFixed(2)}% 勝率${Math.round((v.recent.win || 0) * 100)}% ${v.recent.n}回`).join(' / '));
  recentTrades.sort((a, b) => (b.entryDate > a.entryDate ? 1 : -1));
  writeJson(path.join(OUT, 'backtest.json'), {
    updatedAt: now.toISOString(), symbols: panel.syms.length, days: panel.dates.length, from: panel.dates[0], to: panel.dates.at(-1),
    ...bt, tuned, walkForward: { ...wf, weightsNow: undefined },
    rules: DEFAULT_RULES, notional: NOTIONAL, strategy, ruleCompare, trades: recentTrades.slice(0, 120),
  });
  }
  // AI予測モデルの検証結果（学習は朝だけ。日中は同じモデルで予測し直す）
  writeJson(path.join(OUT, 'model.json'), predDoc ? { date: predDoc.date, model: predDoc.model, report: predDoc.report } : null);
  writeJson(path.join(OUT, 'model20.json'), pred20Doc ? { date: pred20Doc.date, horizon: 20, model: pred20Doc.model, report: pred20Doc.report } : readJson(path.join(PREV, 'model20.json'), null));
  writeJson(path.join(OUT, 'dividends.json'), readJson(path.join(RAW, 'dividends.json'), null) || readJson(path.join(PREV, 'dividends.json'), {}));
  // AI予測の判断理由（銘柄ごとの要因）と、本番の答え合わせ
  const reasonsDoc = readJson(path.join(RAW, 'ai_reasons.json'), null);
  if (reasonsDoc) writeJson(path.join(OUT, 'ai_reasons.json'), reasonsDoc);
  const aiLog = updateLog(readJson(path.join(PREV, 'ai_log.json'), null), predDoc?.date, preds);
  writeJson(path.join(OUT, 'ai_log.json'), aiLog);
  // 答え合わせは「今のモデルになってから」の分で集計（2026-10-28 に順位で学ぶ設計へ変更）。それ以前の分は previous に要約
  const AI_TRACK_SINCE = '2026-10-28';
  const nameMap = Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.name]));
  const part = (keep) => ({ days: Object.fromEntries(Object.entries(aiLog.days || {}).filter(([d]) => keep(d))) });
  const prevTrack = evaluateLog(part((d) => d < AI_TRACK_SINCE), history, nameMap);
  writeJson(path.join(OUT, 'ai_track.json'), { updatedAt: now.toISOString(), since: AI_TRACK_SINCE, ...evaluateLog(part((d) => d >= AI_TRACK_SINCE), history, nameMap),
    previous: { until: AI_TRACK_SINCE, note: '前の設計のモデル', total: prevTrack.total } });

  // 4) スクリーナー（地合いフィルターは検証で逆効果だったため、score には反映しない。penalty は参考値）
  const details = {};
  const rows = syms.map((s) => {
    const a = analyze(history[s]);
    const ids = a.signals.map((x) => x.id);
    details[s] = Object.fromEntries(a.signals.map((x) => [x.id, x.detail]));
    const pen = regimeNow.JP.penalty;
    const lv = levels(history[s]);
    const f = funda[s] || {};
    const [price, prevClose] = quotes[s];
    const ev = events[s] || {};
    return {
      sym: s, name: meta[s].name, seg: meta[s].seg || null, sector: meta[s].sector || null,
      price, changePct: r2((price / prevClose - 1) * 100),
      rawScore: a.score, penalty: pen, score: a.score, tunedScore: scoreOf(ids, tuned), ids,
      liquid: a.liquid, turnover: a.turnover ? Math.round(a.turnover / 1e6) : null, // 百万円
      events: ev.earnings || ev.exDiv ? { earnings: ev.earnings || null, exDiv: ev.exDiv || null, exDivEstimated: !!ev.exDivEstimated } : null,
      per: f.per != null ? r2(f.per) : null, pbr: f.pbr != null ? r2(f.pbr) : null, divYield: f.divYield != null ? Math.round(f.divYield * 10000) / 10000 : null,
      stop: lv ? r2(lv.stop) : null, target: lv ? r2(lv.target) : null,
      pred: preds[s]?.[0] ?? null, aiRank: preds[s]?.[1] ?? null,
      pred20: preds20[s]?.[0] ?? null, aiRank20: preds20[s]?.[1] ?? null, // AI予測：5日後の市場平均との差（%）と、売買代金のある銘柄の中での順位（1=最上位）
    };
  }).sort((x, y) => y.score - x.score || (y.turnover || 0) - (x.turnover || 0));
  writeJson(path.join(OUT, 'screener.json'), { updatedAt: now.toISOString(), rows });
  writeJson(path.join(OUT, 'events.json'), eventsDoc);
  writeJson(path.join(OUT, 'news.json'), newsDoc);
  writeJson(path.join(OUT, 'fundamentals.json'), fundaDoc);

  // 5) 答え合わせ（直近40営業日に「強い買い」だった銘柄のその後）
  const prevReview = MODE === 'intraday' ? readJson(path.join(PREV, 'review.json'), null) : null;
  if (prevReview?.weeks) writeJson(path.join(OUT, 'review.json'), prevReview);
  else {
    const review = computeReview(history, { meta, index: { JP: market.TOPIX || market.N225 }, days: 40 });
    for (const w of review.weeks) w.picks = w.picks.slice(0, 60);
    writeJson(path.join(OUT, 'review.json'), { updatedAt: now.toISOString(), ...review });
  }

  // 6) ペーパートレード（サジェスト通り＝標準配点で機械的に売買）
  const paper = readJson(path.join(PREV, 'paper.json'), null) || {
    startedAt: jstDate, notional: NOTIONAL, rules: DEFAULT_RULES, open: [], closed: [],
  };
  // 2026-10-28：仮想口座の売買を「毎朝、前日の終値で判断」に変更（日中の途中の値段で何度も売買していて、検証と大きくずれていたため）。
  // それまでの記録は archive に要約だけ残してリセット
  const resetPaper = (acc, rules) => {
    if (acc.rulesVersion >= 3) return acc;
    const c = acc.closed || [];
    const sum = c.length ? { trades: c.length, avg: c.reduce((a, t) => a + t.ret, 0) / c.length, win: c.filter((t) => t.ret > 0).length / c.length } : null;
    return { startedAt: jstDate, notional: NOTIONAL, rules, open: [], closed: [], rulesVersion: 3,
      archive: [...(acc.archive || []), { from: acc.startedAt, to: jstDate, note: '日中の途中の値段で売買していたため、ルールを直してリセット', ...sum }] };
  };
  Object.assign(paper, resetPaper(paper, DEFAULT_RULES));
  paper.rules = { ...DEFAULT_RULES, ...paper.rules };
  const R = paper.rules;
  const opened = [], closedNow = [];
  const rowBy = Object.fromEntries(rows.map((r) => [r.sym, r]));
  // 売買するのは毎朝の全件更新（前日の確定した終値）のときだけ。日中は値洗い（含み損益の更新）だけ
  const TRADE = MODE === 'daily';
  paper.open = paper.open.filter((p) => {
    const cs = history[p.sym], row = rowBy[p.sym];
    if (!cs || !row) return true;
    const entryIdx = cs.findIndex((c) => c.date >= p.entryDate);
    const held = entryIdx < 0 ? 0 : cs.length - 1 - entryIdx;
    const px = cs.at(-1).close;
    const ret = px / p.entryPrice - 1;
    Object.assign(p, { lastPrice: px, ret, held });
    if (!TRADE) return true;
    let reason = null;
    if (ret >= R.takeProfit) reason = '利確';
    else if (ret <= R.stopLoss) reason = '損切り';
    else if (row.score <= R.exitScore) reason = 'スコア悪化';
    else if (held >= R.hold) reason = '保有期限';
    if (!reason) return true;
    const t = { ...p, exitDate: cs.at(-1).date, exitPrice: px, ret, reason, pnl: Math.round(ret * paper.notional) };
    paper.closed.unshift(t); closedNow.push(t);
    return false;
  });
  const openSyms = new Set(paper.open.map((p) => p.sym));
  for (const r of TRADE ? rows : []) {
    if (opened.length >= MAX_NEW_PAPER || paper.open.length >= MAX_OPEN_PAPER) break;
    if (r.score < R.entry || !r.liquid || openSyms.has(r.sym)) continue;
    if (paper.closed.some((c) => c.sym === r.sym && c.exitDate === quotes[r.sym][3])) continue;
    const p = { sym: r.sym, name: r.name, entryDate: quotes[r.sym][3], entryPrice: r.price, score: r.score, signals: r.ids, lastPrice: r.price, ret: 0, held: 0 };
    paper.open.push(p); opened.push(p);
  }
  paper.closed = paper.closed.slice(0, 500);
  paper.updatedAt = now.toISOString();
  writeJson(path.join(OUT, 'paper.json'), paper);

  // 6b) AI予測で売買する仮想口座（予測の上位1%を買い、最長5営業日）
  const paperAI = resetPaper(readJson(path.join(PREV, 'paper_ai.json'), null) || { startedAt: jstDate, notional: NOTIONAL, rules: AI_RULES, open: [], closed: [] }, AI_RULES);
  const openedAI = [];
  if (predDoc) {
    paperAI.open = paperAI.open.filter((p) => {
      const cs = history[p.sym];
      if (!cs) return true;
      const entryIdx = cs.findIndex((c) => c.date >= p.entryDate);
      const held = entryIdx < 0 ? 0 : cs.length - 1 - entryIdx;
      const px = cs.at(-1).close, ret = px / p.entryPrice - 1;
      Object.assign(p, { lastPrice: px, ret, held });
      if (!TRADE) return true;
      const reason = ret >= AI_RULES.takeProfit ? '利確' : ret <= AI_RULES.stopLoss ? '損切り' : held >= AI_RULES.hold ? '保有期限' : null;
      if (!reason) return true;
      paperAI.closed.unshift({ ...p, exitDate: cs.at(-1).date, exitPrice: px, ret, reason, pnl: Math.round(ret * paperAI.notional) });
      return false;
    });
    const held = new Set(paperAI.open.map((p) => p.sym));
    const cands = (TRADE ? rows : []).filter((r) => r.liquid && r.aiRank >= AI_RULES.entryRank && r.pred > 0 && !held.has(r.sym)
      && !paperAI.closed.some((c) => c.sym === r.sym && c.exitDate === quotes[r.sym][3])).sort((a, b) => b.pred - a.pred);
    const perSector = {};
    for (const p of paperAI.open) { const sec = rowBy[p.sym]?.sector || '-'; perSector[sec] = (perSector[sec] || 0) + 1; }
    for (const r of cands) {
      if (openedAI.length >= AI_RULES.maxNew || paperAI.open.length >= AI_RULES.maxOpen) break;
      const sec = r.sector || '-';
      if ((perSector[sec] || 0) >= AI_RULES.maxPerSector) continue; // 同じ業種ばかりにならないよう分散
      perSector[sec] = (perSector[sec] || 0) + 1;
      const p = { sym: r.sym, name: r.name, entryDate: quotes[r.sym][3], entryPrice: r.price, pred: r.pred, aiRank: r.aiRank, lastPrice: r.price, ret: 0, held: 0 };
      paperAI.open.push(p); openedAI.push(p);
    }
    paperAI.closed = paperAI.closed.slice(0, 500);
    paperAI.updatedAt = now.toISOString();
  }
  writeJson(path.join(OUT, 'paper_ai.json'), paperAI);

  // 7) AI「なぜ今？」解説（売買代金のある上位5銘柄、シグナルの組み合わせが変わった時だけ）
  const ai = Object.fromEntries(Object.entries(prevAi).filter(([, v]) => v.date >= jstDate));
  const useClaude = !!process.env.ANTHROPIC_API_KEY;
  // GitHub Models は応答が「OK」だけで使えないことが続いたため、変数 AI_PROVIDER=github のときだけ試す
  const useGithub = !useClaude && !!process.env.GITHUB_TOKEN && process.env.AI_PROVIDER === 'github';
  const aiOn = useClaude || useGithub;
  let aiFailures = 0, aiError = null;
  if (aiOn) {
    for (const r of rows.filter((x) => x.score >= WATCH && x.liquid).slice(0, 5)) {
      const key = `${jstDate}:${[...r.ids].sort().join(',')}`;
      if (ai[r.sym]?.key === key) continue;
      if (aiFailures >= 2) break;
      const ctx = {
        sym: r.sym, name: r.name, price: r.price, changePct: r.changePct, score: r.score,
        verdict: verdictOf(r.score).label, events: r.events, news: news[r.sym],
        signals: r.ids.map((id) => ({ label: SIGNAL_MAP[id].label, weight: BASE_WEIGHTS[id], detail: details[r.sym][id] })),
        stats: r.ids.map((id) => ({ label: SIGNAL_MAP[id].label, ...bt.stats[id] })).filter((x) => x.n),
      };
      try {
        const text = useClaude
          ? await explain({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.AI_MODEL || AI_MODEL_DEFAULT, ctx })
          : await explainGithub({ token: process.env.GITHUB_TOKEN, model: process.env.GH_MODEL || GH_MODEL_DEFAULT, ctx });
        if (text) ai[r.sym] = { key, date: jstDate, text, source: useClaude ? 'Claude' : 'GitHub Models', generatedAt: now.toISOString() };
      } catch (e) {
        aiFailures++; aiError = e.message;
      }
    }
  }
  writeJson(path.join(OUT, 'ai.json'), ai);

  // 8) スマホ通知（ntfy）
  const prevScore = Object.fromEntries((prevScreener.rows || []).map((r) => [r.sym, r.score]));
  const newStrong = rows.filter((r) => r.liquid && r.score >= STRONG && prevScreener.rows?.length && (prevScore[r.sym] ?? 0) < STRONG).slice(0, 10);
  if (newStrong.length) {
    await ntfy('強い買いシグナル', newStrong.map((r) => `${r.name}(${r.sym}) ${r.score}点: ${r.ids.slice(0, 2).map((id) => SIGNAL_MAP[id].label).join('・')}`).join('\n'), ['chart_with_upwards_trend']);
  }
  if (opened.length || closedNow.length) {
    await ntfy('ペーパートレード', [
      ...opened.map((p) => `買 ${p.name}(${p.sym}) @${p.entryPrice}`),
      ...closedNow.map((t) => `売 ${t.name}(${t.sym}) ${t.reason} ${(t.ret * 100).toFixed(1)}%`),
    ].join('\n'), ['memo']);
  }
  const notified = { ...prevNotified };
  if (notified.eventsDate !== jstDate) {
    const soon = rows.filter((r) => r.liquid && r.score >= WATCH).flatMap((r) => {
      const e = r.events || {};
      const de = daysUntil(e.earnings);
      return de != null && de >= 0 && de <= 2 ? [`${r.name} 決算 ${de === 0 ? '今日' : de + '日後'}`] : [];
    });
    if (soon.length) await ntfy('注目銘柄の決算が近い', soon.slice(0, 15).join('\n'), ['warning']);
    notified.eventsDate = jstDate;
  }
  writeJson(path.join(OUT, 'notified.json'), notified);

  writeJson(path.join(OUT, 'meta.json'), {
    updatedAt: now.toISOString(), symbols: syms.length, universe: uniDoc.symbols.length, liquid: rows.filter((r) => r.liquid).length,
    ai: aiOn ? (useClaude ? 'Claude' : 'GitHub Models') : false, aiError, ntfy: !!process.env.NTFY_TOPIC,
    eventsDate: eventsDoc.date || null, fetch: fetchMeta, buildSeconds: Math.round((Date.now() - t0) / 1000), mode: MODE,
    model: predDoc ? { date: predDoc.date, trainedAt: predDoc.model?.trainedAt, ic: predDoc.report?.ic ?? null } : null,
  });
  console.log(`built ${syms.length} symbols (${rows.filter((r) => r.liquid).length} liquid); strong=${rows.filter((r) => r.liquid && r.score >= STRONG).length}; paper open=${paper.open.length} (+${opened.length}/-${closedNow.length}); ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
