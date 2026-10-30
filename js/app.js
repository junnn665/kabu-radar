import { makeProvider, DemoProvider, DEMO_SYMBOLS } from './providers.js';
import { analyze, scoreOf, verdictOf, SIGNALS, SIGNAL_MAP, BASE_WEIGHTS, STYLES, applyStyle, VERDICTS } from './signals.js';
import { signalStats, tuneWeights, simulate, tradeSummary, DEFAULT_RULES } from './backtest.js';
import { explain, chatPrompt, AI_MODELS, AI_MODEL_DEFAULT } from './ai.js';
import { ruleExplain } from './explain.js';
import { drawChart, sparkline, fmt } from './chart.js';
import { levels, holdingLevels } from './levels.js';
import { marketOf } from './market.js';
import { computeReview } from './review.js';
import { decodeCsv, parseCsvText, extractHoldings } from './csvimport.js';
import { dividendPlan, concentration, upcoming, TAX } from './portfolio.js';
import { squarify } from './treemap.js';

const DEFAULT_REPO = 'junnn665/kabu-radar';

// ================= 設定 =================
const DEFAULTS = {
  provider: 'auto',
  apiKey: '',
  interval: 5,
  watchlist: ['7203', '6758', '8306', '9984', '8035', '6501', '7974', '8058'],
  upColor: 'green',
  alerts: {},
  weightMode: 'base', // base | tuned | custom
  style: 'balanced',
  custom: {},
  aiKey: '',
  aiModel: AI_MODEL_DEFAULT,
  tab: 'watch',
  holdings: [],       // [{ id, sym, shares, cost, date }]
  marketFilter: false, // 地合いフィルター（検証で逆効果だったため標準はオフ）
  method: 'auto',      // 判定方式：'auto'（検証成績が良い方）| 'ai'（AI予測）| 'points'（シグナル点数）
  horizon: 5,          // AI予測の期間：5（1週間）| 20（1か月）
  memos: {},           // 売買メモ { sym: [{ date, text, price, p5, p20 }] }
  v: 4,
};
const store = {
  load() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('kr:settings') || '{}') }; } catch { return { ...DEFAULTS }; }
  },
  save(s) { try { localStorage.setItem('kr:settings', JSON.stringify(s)); } catch {} },
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const isJpCode = (s) => /^\d{3}[0-9A-Z]$/.test(s);
function migrate(st) {
  if ((st.v || 0) < 3) { st.marketFilter = false; st.v = 3; }
  if (st.v < 4) {
    // 日本株専用になる前の米国株コード（AAPL など）をウォッチリスト・アラートから外す
    st.watchlist = (st.watchlist || []).filter(isJpCode);
    for (const k of Object.keys(st.alerts || {})) if (!isJpCode(k)) delete st.alerts[k];
    st.v = 4;
  }
  return st;
}
const save = () => store.save(state.settings);

const state = {
  settings: migrate(store.load()),
  provider: null,
  candles: {},
  quotes: {},
  analyses: {},
  prevVerdict: {},
  selected: null,
  timer: null,
  busy: false,
  server: {},        // GitHub Actions が生成したデータ
  local: {},         // デモ等でブラウザ内計算したもの
  symStats: {},      // 銘柄別バックテストのキャッシュ
  aiBusy: false,
  scr: { seg: 'all', sector: 'all', min: 2, q: '', funda: 'all', liquid: true, limit: 100 },
  universe: null,    // 自動取得の対象銘柄（config/universe.json）
};

store.save(state.settings); // 移行した設定を保存

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pctf = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`);
const pct = (v) => (v == null || Number.isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const sign = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const yen = (v) => `${v >= 0 ? '+' : '−'}¥${Math.abs(Math.round(v)).toLocaleString('ja-JP')}`;
const todayJst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// ================= 配点 =================
function tunedWeights() {
  return state.server.backtest?.tuned || (state.local.bt ? tuneWeights(state.local.bt) : BASE_WEIGHTS);
}
function rawWeights() {
  const st = state.settings;
  if (st.weightMode === 'tuned') return tunedWeights();
  if (st.weightMode === 'custom') return { ...BASE_WEIGHTS, ...st.custom };
  return BASE_WEIGHTS;
}
const W = () => applyStyle(rawWeights(), state.settings.style);
const universeStats = () => state.server.backtest || state.local.bt || null;

// ================= AI予測 =================
// 判定方式が「AI予測」で、その銘柄の予測があるとき使う。順位は売買代金1億円以上の銘柄の中での位置（1=最上位）
// 「自動」のときは、学習に使っていない期間で市場平均を上回った幅が大きい方を使う
function aiIsBetter() {
  const ai = state.server.model?.report?.top2pct, pts = state.server.backtest?.walkForward?.base;
  if (ai?.excess == null) return false;
  return pts?.excess == null || ai.excess > pts.excess;
}
// 本番の答え合わせ（5営業日後まで確定した分）で、上位銘柄が2日以上続けて市場平均に負けているなら「自動」ではAIを使わない
function aiLiveFailing() {
  const t = state.server.ai_track?.total;
  return !!t && t.days >= 2 && t.topExcess != null && t.topExcess < 0;
}
const useAI = () => !!state.server.model?.report && (state.settings.method === 'ai' || (state.settings.method !== 'points' && aiIsBetter() && !aiLiveFailing()));
// 予測期間：5営業日（1週間）か20営業日（1か月）。ホームの切り替えで全体の並び順が変わる
const H20 = () => state.settings.horizon === 20 && !!state.server.model20?.report;
const predOf = (r) => (H20() ? r?.pred20 : r?.pred) ?? null;
const rankOf = (r) => (H20() ? r?.aiRank20 : r?.aiRank) ?? null;
const hLabel = () => (H20() ? '1か月' : '1週間');
const aiOf = (s) => {
  const r = rowOf(s);
  const p = predOf(r);
  return p != null ? { pred: p, rank: rankOf(r), p5: r.pred, r5: r.aiRank, p20: r.pred20, r20: r.aiRank20 } : null;
};
function aiVerdict(rank) {
  if (rank == null) return VERDICTS.find((v) => v.key === 'neutral');
  if (rank >= 0.98) return VERDICTS[0];
  if (rank >= 0.95) return VERDICTS[1];
  if (rank <= 0.05) return VERDICTS[3];
  return VERDICTS[2];
}
const LEVEL = { strong: 3, watch: 2, neutral: 1, caution: 0 };
const topPct = (rank) => (rank == null ? '' : rank >= 0.995 ? '上位0.5%' : rank >= 0.5 ? `上位${Math.max(1, Math.round((1 - rank) * 100))}%` : `下位${Math.max(1, Math.round(rank * 100))}%`);
const signedPct = (p, d = 1) => (p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(d)}%`);
// 1週間・1か月の両方を並べた小さい表示
const aiBoth = (ai) => (ai ? `<span class="aiboth mono"><span class="${sign(ai.p5)}">1週 ${signedPct(ai.p5)}</span>${ai.p20 != null ? ` <span class="${sign(ai.p20)}">1か月 ${signedPct(ai.p20)}</span>` : ''}</span>` : '');
const aiLabel = (ai) => (ai ? `<span class="ai-chip ${sign(ai.pred)}">AI ${ai.pred > 0 ? '+' : ''}${ai.pred.toFixed(2)}%</span>` : '');

// ================= 地合い =================
const regimeOf = (mkt) => state.server.market?.regime?.[mkt] || null;
const penaltyFor = (s) => (state.settings.marketFilter ? regimeOf(marketOf(s))?.penalty || 0 : 0);
function withRegime(a, s) {
  const pen = penaltyFor(s);
  if (!pen || !a) return a;
  const score = Math.max(-100, a.score - pen);
  return { ...a, rawScore: a.score, penalty: pen, score, verdict: verdictOf(score) };
}

// ================= データ =================
const tracked = () => [...new Set([...state.settings.watchlist, ...state.settings.holdings.map((h) => h.sym)])];
const inUniverse = (s) => !state.universe || state.universe.has(s);
const rowOf = (s) => state.rowBySym?.get(s) || null;
const fundaOf = (s) => rowOf(s);
const eventsOf = (s) => rowOf(s)?.events || null;
const newsOf = (s) => state.server.news?.news?.[s] || [];
const nameOf = (s) => state.universe?.get(s)?.name || state.quotes[s]?.name || state.settings.holdings.find((h) => h.sym === s && h.name)?.name || s;

async function loadServer() {
  if (!state.provider.static) { state.server = {}; return; }
  const files = ['screener', 'backtest', 'paper', 'paper_ai', 'news', 'ai', 'meta', 'market', 'review', 'model', 'model20', 'ai_reasons', 'ai_track', 'dividends', 'tdnet'];
  if (!state.universe) {
    try {
      const u = await state.provider.json('universe.json', { fresh: true });
      state.universe = new Map(u.symbols.map((x) => [x.sym, x]));
      state.sectors = [...new Set(u.symbols.map((x) => x.sector).filter(Boolean))].sort();
      for (const x of u.symbols) state.provider.names[x.sym] = x.name;
    } catch { state.universe = null; }
  }
  const docs = await Promise.all(files.map((f) => state.provider.json(`${f}.json`, { fresh: true }).catch(() => null)));
  state.server = Object.fromEntries(files.map((f, i) => [f, docs[i]]));
  state.rowBySym = new Map((state.server.screener?.rows || []).map((r) => [r.sym, r]));
}

async function loadCandles(symbols) {
  for (const s of symbols) {
    try {
      state.candles[s] = await state.provider.getDailyCandles(s);
    } catch (e) {
      state.failed = state.failed || new Set();
      if (!state.provider.unavailable && !state.failed.has(s)) {
        state.failed.add(s);
        clearTimeout(state.failTimer);
        state.failTimer = setTimeout(() => toast(`${[...state.failed].join('・')} は株価データがありません（行に「取得不可」と表示します）`, 'err'), 400);
      }
      state.candles[s] = [];
    }
    delete state.symStats[s];
    recompute(s);
    render();
  }
}

// デモ／Twelve Data 時は、スクリーナー・バックテスト・シミュレーションをブラウザで計算する
async function buildLocal() {
  if (state.provider.static) { state.local = {}; return; }
  const demo = state.provider instanceof DemoProvider;
  const syms = demo ? DEMO_SYMBOLS : state.settings.watchlist;
  const series = {};
  for (const s of syms) series[s] = demo ? await state.provider.getDailyCandles(s) : state.candles[s];
  const bt = signalStats(series);
  const rows = syms.filter((s) => series[s]?.length).map((s) => {
    const a = analyze(series[s]);
    const c = series[s], last = c[c.length - 1], prev = c[c.length - 2] || last;
    return {
      sym: s, name: nameOf(s), seg: 'P', liquid: true, price: last.close,
      changePct: ((last.close - prev.close) / prev.close) * 100, ids: a.signals.map((x) => x.id),
      details: Object.fromEntries(a.signals.map((x) => [x.id, x.detail])), events: null,
    };
  });
  const trades = [], strategy = {};
  for (const [mode, w] of [['base', BASE_WEIGHTS], ['tuned', tuneWeights(bt)]]) {
    const all = syms.flatMap((s) => simulate(series[s], w, DEFAULT_RULES).map((t) => ({ ...t, sym: s, name: nameOf(s) })));
    strategy[mode] = tradeSummary(all);
    if (mode === 'base') trades.push(...all);
  }
  trades.sort((a, b) => (b.entryDate > a.entryDate ? 1 : -1));
  const meta = Object.fromEntries(syms.map((s) => [s, { name: nameOf(s), market: marketOf(s) }]));
  const review = computeReview(series, { meta, days: 40 });
  state.local = { bt, rows, strategy, trades, tuned: tuneWeights(bt), review };
}

function mergeQuote(s, q) {
  const cs = state.candles[s];
  if (!cs?.length) return false;
  const lastC = cs[cs.length - 1];
  if (q.date && q.date > lastC.date) {
    // 1分ごとの株価なら今日の足をその場で作る（それ以外は日足を取り直す）
    if (!q.live) return true;
    cs.push({ date: q.date, open: q.open || q.price, high: Math.max(q.high || q.price, q.price), low: Math.min(q.low || q.price, q.price), close: q.price, volume: q.volume || 0 });
    return false;
  }
  if (q.date && q.date < lastC.date) return false;
  lastC.close = q.price;
  lastC.high = Math.max(lastC.high, q.high || q.price, q.price);
  lastC.low = Math.min(lastC.low, q.low || q.price, q.price);
  if (q.volume) lastC.volume = q.volume;
  return false;
}

// 1分ごとの株価を、スクリーナーの行・AIピック・指数にも反映する（判定やAI予測は約10分ごとの計算のまま）
function applyLive() {
  const feed = state.provider?.liveFeed;
  if (!feed?.fresh()) return;
  for (const r of state.server.screener?.rows || []) {
    const q = feed.quote(r.sym);
    if (q) { r.price = q.price; r.changePct = q.changePct; }
  }
  const idx = state.server.market?.indices;
  for (const [k, v] of Object.entries(feed.doc.idx || {})) {
    if (idx?.[k] && v[0] && v[1]) { idx[k].price = v[0]; idx[k].changePct = (v[0] / v[1] - 1) * 100; }
  }
}

function recompute(s) {
  let a = withRegime(analyze(state.candles[s], W()), s);
  const ai = aiOf(s);
  if (ai) a = { ...a, ai };
  if (useAI() && ai) a = { ...a, verdict: aiVerdict(ai.rank) };
  state.analyses[s] = a;
  const prev = state.prevVerdict[s];
  if (prev && prev !== 'strong' && a.verdict.key === 'strong') {
    notify(`${nameOf(s)} が「強い買いシグナル」に`, a.signals.slice(0, 2).map((x) => x.label).join('・'));
  }
  state.prevVerdict[s] = a.verdict.key;
}
const recomputeAll = () => Object.keys(state.candles).forEach(recompute);

async function tick() {
  if (state.busy) return;
  state.busy = true;
  const syms = [...new Set([...tracked(), state.selected].filter(Boolean))].filter((s) => state.candles[s]?.length);
  try {
    const before = state.provider.quotesDoc?.updatedAt;
    const qs = await state.provider.getQuotes(syms);
    const refetch = [];
    for (const [s, q] of Object.entries(qs)) {
      const old = state.quotes[s];
      q.flash = old ? Math.sign(q.price - old.price) : 0;
      state.quotes[s] = q;
      if (mergeQuote(s, q)) refetch.push(s);
      recompute(s);
      checkAlerts(s, q, old);
    }
    if (state.provider.static && state.provider.quotesDoc?.updatedAt !== before) { await loadServer(); recomputeAll(); }
    applyLive();
    checkHoldings();
    if (refetch.length) loadCandles(refetch);
    const recovered = state.provider.unavailable;
    state.provider.unavailable = false;
    renderStatus();
    if (recovered) { await loadServer(); loadCandles(tracked().filter((s) => !state.candles[s]?.length)).then(tick); }
  } catch (e) {
    $('#status').className = 'dot err';
    $('#updated').textContent = '読み込み失敗';
    toast(`株価データを読み込めませんでした（${e.message}）。1分後に再試行します`, 'err');
  } finally {
    state.busy = false;
  }
  render();
}

// ヘッダーの状態表示：取引中か、休場中なら「いつの終値か」
function renderStatus() {
  const p = state.provider;
  const banner = $('#mode-banner');
  if (!p?.static) {
    $('#status').className = 'dot live';
    $('#updated').textContent = 'デモ';
    banner.hidden = false;
    banner.textContent = 'デモモードです。表示中の株価は架空のシミュレーションで、実際の値ではありません。';
    return;
  }
  if (p.unavailable) {
    $('#status').className = 'dot err';
    $('#updated').textContent = '読み込み失敗';
    banner.hidden = false;
    banner.textContent = '株価データを読み込めませんでした。通信状況を確認してください（1分ごとに再試行します）。';
    return;
  }
  banner.hidden = true;
  if (p.liveFeed?.fresh()) {
    const t = new Date(p.liveFeed.doc.asOf * 1000);
    $('#status').className = 'dot live';
    $('#updated').textContent = `${t.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })} の株価`;
    $('#updated').title = '1分ごとに更新（データ元の都合で約20分遅れ）';
    return;
  }
  const doc = p.quotesDoc || {};
  const last = Object.values(doc.q || {})[0]?.[3];
  const at = doc.updatedAt ? new Date(doc.updatedAt) : null;
  const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
  if (doc.marketOpen) {
    $('#status').className = 'dot live';
    $('#updated').textContent = at ? `${at.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 時点` : '';
  } else {
    $('#status').className = 'dot';
    $('#updated').textContent = last ? `休場中・${md(last)}終値` : '休場中';
  }
}

async function restart() {
  clearInterval(state.timer);
  state.provider = await makeProvider({ ...state.settings, repo: repoName() });
  Object.assign(state, { candles: {}, quotes: {}, analyses: {}, prevVerdict: {}, symStats: {}, server: {}, local: {} });
  $('#provider').textContent = state.provider.name;
  renderStatus();
  document.documentElement.dataset.up = state.settings.upColor;
  render();
  await loadServer();
  await loadCandles(tracked());
  await tick();
  await buildLocal();
  recomputeAll();
  render();
  checkEventsToday();
  const p = state.provider;
  const sec = p.static ? 60 : p.live ? Math.max(2, +state.settings.interval || 5) : Math.max(60, +state.settings.interval || 60);
  state.timer = setInterval(tick, sec * 1000);
}

// ================= 通知 =================
function checkAlerts(s, q, old) {
  const al = state.settings.alerts[s];
  if (!al || !old) return;
  if (al.above && old.price < al.above && q.price >= al.above) notify(`${nameOf(s)} が ${fmt(al.above)} を上抜け`, `現在値 ${fmt(q.price)}`);
  if (al.below && old.price > al.below && q.price <= al.below) notify(`${nameOf(s)} が ${fmt(al.below)} を下抜け`, `現在値 ${fmt(q.price)}`);
}

function daysUntil(d) {
  return d ? Math.round((Date.parse(d) - Date.parse(todayJst())) / 86400e3) : null;
}

// ウォッチリスト銘柄の決算・権利落ちが3日以内なら1日1回お知らせ
function checkEventsToday() {
  const key = `kr:eventsNotified:${todayJst()}`;
  if (store.get(key)) return;
  const soon = state.settings.watchlist.flatMap((s) => eventBadges(s).filter((b) => b.days <= 3).map((b) => `${nameOf(s)} ${b.text}`));
  if (soon.length) notify('決算・権利落ちが近い銘柄', soon.join(' / '));
  store.set(key, true);
}

async function notify(title, body) {
  toast(`${title}${body ? ' — ' + body : ''}`, 'info');
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
    else new Notification(title, { body });
  } catch {}
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 4500);
  setTimeout(() => el.remove(), 5000);
}

// ================= 描画 =================
function eventBadges(s) {
  const e = eventsOf(s);
  if (!e) return [];
  const out = [];
  const de = daysUntil(e.earnings), dx = daysUntil(e.exDiv);
  if (de != null && de >= 0 && de <= 14) out.push({ days: de, kind: 'earn', text: `決算${de === 0 ? '今日' : `${de}日後`}` });
  if (dx != null && dx >= 0 && dx <= 14) out.push({ days: dx, kind: 'div', text: `権利落ち${dx === 0 ? '今日' : `${dx}日後`}${e.exDivEstimated ? '(推定)' : ''}` });
  return out;
}
// 適時開示（TDnet）：株価が動きやすい開示だけ
const TD_CAT = {
  up: { label: '上方修正', tone: 'good' }, down: { label: '下方修正', tone: 'bad' }, buyback: { label: '自社株買い', tone: 'good' },
  divup: { label: '増配', tone: 'good' }, divdown: { label: '減配', tone: 'bad' }, split: { label: '株式分割', tone: 'good' },
  tob: { label: 'TOB', tone: 'hot' }, revise: { label: '業績予想の修正', tone: '' }, earnings: { label: '決算', tone: '' },
};
const disclosuresOf = (s) => state.server.tdnet?.items?.[s] || [];
const daysSince = (d) => -daysUntil(d);
// 業績予想の修正：「通期 営業利益 前回予想比 +23%」
const revText = (rev, long = false) => {
  if (!rev) return '';
  const { prev, cur } = rev;
  const pc = prev != null && cur != null && prev > 0 && cur < 0 ? '赤字転落'
    : prev != null && cur != null && prev < 0 && cur > 0 ? '黒字転換'
      : prev != null && cur != null && prev < 0 && cur < 0 ? (cur < prev ? '赤字拡大' : '赤字縮小')
        : rev.pct != null ? `${rev.pct > 0 ? '+' : ''}${(rev.pct * 100).toFixed(Math.abs(rev.pct) < 0.1 ? 1 : 0)}%` : '';
  if (!long) return pc;
  const n = (v) => (v == null ? '—' : v.toLocaleString('ja-JP'));
  return `${rev.p}の${rev.m} ${n(rev.prev)}→${n(rev.cur)}${pc ? `（前回予想比 ${pc}）` : ''}${rev.sales != null && rev.m !== '売上高' ? `・売上高 ${rev.sales > 0 ? '+' : ''}${(rev.sales * 100).toFixed(1)}%` : ''}`;
};
// 決算短信：前年同期比・進捗率
const QLABEL = { 1: '第1四半期', 2: '第2四半期（中間）', 3: '第3四半期', 4: '通期（本決算）' };
const yoyText = (v) => (v == null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%`);
const finTone = (f) => (!f || f.profitYoY == null ? '' : f.profitYoY >= 10 ? 'good' : f.profitYoY <= -10 ? 'bad' : '');
const finShort = (f) => (f?.profitYoY != null ? `${f.m.replace('利益', '益')}${yoyText(f.profitYoY)}` : '');
const progressNote = (f) => {
  if (f?.progress == null || f.q >= 4) return '';
  const goal = f.q * 0.25, diff = f.progress - goal;
  return `進捗 ${Math.round(f.progress * 100)}%（目安${Math.round(goal * 100)}%${diff >= 0.05 ? '・順調' : diff <= -0.05 ? '・遅れ' : ''}）`;
};
const finLong = (f) => {
  if (!f) return '';
  const n = (v) => (v == null ? '—' : v.toLocaleString('ja-JP'));
  const parts = [];
  if (f.sales != null) parts.push(`売上 ${n(f.sales)}${f.salesYoY != null ? `（${yoyText(f.salesYoY)}）` : ''}`);
  parts.push(`${f.m} ${n(f.profit)}${f.profitYoY != null ? `（${yoyText(f.profitYoY)}）` : ''}`);
  const fy = f.fy ? `${f.q >= 4 ? '来期' : '通期'}予想の${f.m} ${n(f.fy.profit)}${f.fy.profitYoY != null ? `（${yoyText(f.fy.profitYoY)}）` : ''}` : '';
  return `${QLABEL[f.q] || ''}${f.cons ? '' : '（単体）'}：${parts.join('・')}　前年同期比${fy ? `／${fy}` : ''}${progressNote(f) ? `・${progressNote(f)}` : ''}${f.div != null ? `／配当予想 年${f.div}円` : ''}`;
};
const tdLabel = (c, rev) => `${TD_CAT[c]?.label || 'IR'}${(c === 'up' || c === 'down') && rev?.pct != null ? ` ${revText(rev)}` : c === 'earnings' && finShort(rev) ? ` ${finShort(rev)}` : ''}`;
const tdTone = (c, x) => (c === 'earnings' ? finTone(x) : TD_CAT[c]?.tone || '');
const recentDisclosures = (s, days = 5) => disclosuresOf(s).filter(([d, , c, , , x]) => daysSince(d) <= days && TD_CAT[c] && c !== 'revise' && (c !== 'earnings' || x?.profitYoY != null));
const latestEarnings = (s) => disclosuresOf(s).find(([, , c, , , x]) => c === 'earnings' && x);
const eventChips = (s) => recentDisclosures(s).slice(0, 2).map(([, , c, , , rev]) => `<span class="ev td ${tdTone(c, rev)}">${c === 'earnings' ? '📊' : '📢'} ${esc(tdLabel(c, rev))}</span>`).join('')
  + eventBadges(s).map((b) => `<span class="ev ${b.days <= 3 ? 'hot' : ''}">${b.kind === 'earn' ? '📅' : '💰'} ${esc(b.text)}</span>`).join('');

const PERF_TABS = ['review', 'paper', 'backtest'];
function render() {
  const st = state.settings;
  if (PERF_TABS.includes(st.tab)) { st.perfTab = st.tab; st.tab = 'perf'; } // 旧タブ名からの移行
  const perfTab = PERF_TABS.includes(st.perfTab) ? st.perfTab : 'review';
  const viewId = st.tab === 'perf' ? perfTab : st.tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === st.tab));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${viewId}`));
  $('#perf-seg').hidden = st.tab !== 'perf';
  document.querySelectorAll('[data-perf]').forEach((b) => b.classList.toggle('on', b.dataset.perf === perfTab));
  const mode = state.settings.weightMode === 'base' ? '' : state.settings.weightMode === 'tuned' ? '自動調整' : 'カスタム';
  const style = state.settings.style !== 'balanced' ? STYLES[state.settings.style].label.replace(/（.*/, '') : '';
  $('#wmode').textContent = [mode, style].filter(Boolean).join('・');
  ({ watch: renderWatch, screener: renderScreener, holdings: renderHoldings, paper: renderPaper, review: renderReview, backtest: renderBacktest })[viewId]();
  renderDetail();
}

function renderRegime() {
  const m = state.server.market;
  if (!m) { $('#regime').innerHTML = ''; return; }
  const idx = m.indices || {};
  const tile = (k, label) => idx[k] ? `<div class="tile"><small>${label}</small><b class="mono">${fmt(idx[k].price)}</b><i class="mono ${sign(idx[k].changePct)}">${pct(idx[k].changePct)}</i></div>` : '';
  const r = m.regime?.JP;
  $('#regime').innerHTML = `<div class="tiles">${tile('N225', '日経平均')}${tile('TOPIX', 'TOPIX')}
    ${r ? `<div class="tile" title="${esc(r.notes.join('・'))}"><small>地合い</small><b class="reg-${r.state.key}">${r.state.label}</b></div>` : ''}</div>`;
}

function levelLine(s, compact = false) {
  const lv = levels(state.candles[s]);
  if (!lv) return '';
  return `<div class="lv ${compact ? 'compact' : ''}"><span>損切り <b class="mono">${fmt(lv.stop)}</b><i class="down">${pctf(lv.stopPct)}</i></span><span>利確 <b class="mono">${fmt(lv.target)}</b><i class="up">${pctf(lv.targetPct)}</i></span></div>`;
}

function fundaLine(s) {
  const f = fundaOf(s);
  if (!f) return '';
  const items = [
    f.per != null && `PER <b class="mono">${f.per.toFixed(1)}</b>倍`,
    f.pbr != null && `PBR <b class="mono">${f.pbr.toFixed(2)}</b>倍`,
    f.divYield != null && `配当利回り <b class="mono">${(f.divYield * 100).toFixed(2)}</b>%`,
  ].filter(Boolean);
  return items.length ? `<div class="funda">${items.join('<span class="sep">｜</span>')}</div>` : '';
}

function renderWatch() {
  renderRegime();
  renderHeatmap();
  renderPicks();
  renderTable();
}

// ---------- 相場マップ（ヒートマップ）----------
// 業種ごとに区切り、各銘柄の大きさ＝売買代金（20日平均）、色＝今日の値動き／AI予測。業種ごとに売買代金の大きい12銘柄、残りは「他」にまとめる
const HM_MODES = {
  chg: { label: '今日の値動き', get: (r) => r.changePct, scale: 3, unit: '%' },
  ai5: { label: 'AI 1週間先', get: (r) => r.pred, scale: 1.5, unit: '%' },
  ai20: { label: 'AI 1か月先', get: (r) => r.pred20, scale: 4, unit: '%' },
};
function hmColor(v, scale) {
  if (v == null || !Number.isFinite(v)) return 'var(--hm-mid)';
  const t = Math.max(-1, Math.min(1, v / scale));
  const k = Math.round(Math.abs(t) * 80 + (Math.abs(t) > 0.02 ? 12 : 0));
  return `color-mix(in srgb, var(${t >= 0 ? '--up' : '--down'}) ${k}%, var(--hm-mid))`;
}
// 社名を短く（タイルに収まるように）
const shortName = (n) => String(n || '')
  .replace(/フィナンシャル・?グループ|フィナンシャルグループ/g, 'FG').replace(/ホールディングス|ホールディング/g, 'HD')
  .replace(/グループ$/, 'G').replace(/コーポレーション|株式会社|（株）|\(株\)/g, '').replace(/[ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/　/g, ' ').trim();
const SECTOR_SHORT = { 'ガラス・土石製品': 'ガラス土石', '証券、商品先物取引業': '証券', '石油・石炭製品': '石油石炭', '電気・ガス業': '電気ガス',
  'パルプ・紙': '紙パ', '倉庫・運輸関連業': '倉庫運輸', '水産・農林業': '水産農林', '情報・通信業': '情報通信', 'その他金融業': 'その他金融' };
const shortSector = (s) => SECTOR_SHORT[s] || String(s || '').replace(/・/g, '').replace(/業$/, '');
// 面積が小さすぎて読めないものは「他」にまとめる（大きい順に、最低面積を満たす間だけ個別に出す）
function fitItems(list, area, minA, maxN = 40) {
  const total = list.reduce((t, x) => t + x.value, 0) || 1;
  const shown = [], rest = [];
  for (const x of list) (shown.length < maxN && (x.value / total) * area >= minA ? shown : rest).push(x);
  return { shown, rest };
}
const wavgOf = (rs, get) => { let s = 0, w = 0; for (const r of rs) { const v = get(r); if (v != null && Number.isFinite(v)) { s += v * r.turnover; w += r.turnover; } } return w ? s / w : null; };
function tileHtml({ x, y, w, h, bg, name, value, attrs, sub, tip }) {
  // 1行に収まる大きさ → 無理なら2行に折り返す大きさ（名前2行＋数字1行がマスに収まるように）
  const len = Math.max(2, [...name].length), iw = w - 8, ih = h - 6;
  const one = Math.min(iw / len, ih / 2.6), two = Math.min(iw / Math.ceil(len / 2), ih / 3.8);
  const fs = Math.floor(Math.max(9, Math.min(15, one >= 10 ? one : Math.max(one, two))));
  const showName = w >= 34 && h >= 24, showVal = h >= (showName ? 34 : 16) && w >= 30;
  return `<${attrs ? `button ${attrs}` : 'div'} class="hm-t" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${bg};--fs:${fs}px" title="${esc(tip)}">
    ${showName ? `<span class="hm-n">${esc(name)}</span>` : ''}${showVal ? `<span class="hm-v mono">${value}</span>` : ''}${sub && h > 90 && w > 90 ? `<span class="hm-s">${sub}</span>` : ''}</${attrs ? 'button' : 'div'}>`;
}

function renderHeatmap() {
  const sec = $('#hmap-sec');
  const rows = (state.server.screener?.rows || []).filter((r) => r.liquid && r.turnover > 0 && r.sector);
  sec.hidden = rows.length < 50;
  if (sec.hidden) return;
  const hasAI = rows.some((r) => r.pred != null), has20 = rows.some((r) => r.pred20 != null);
  let mode = state.settings.hmMode || 'chg';
  if ((mode === 'ai5' && !hasAI) || (mode === 'ai20' && !has20)) mode = 'chg';
  $('#hm-mode').querySelectorAll('[data-hm]').forEach((b) => {
    b.classList.toggle('on', b.dataset.hm === mode);
    b.hidden = (b.dataset.hm === 'ai5' && !hasAI) || (b.dataset.hm === 'ai20' && !has20);
  });
  const M = HM_MODES[mode];
  const fmtV = (v) => (v == null ? '—' : Math.abs(v) < 0.05 ? '0.0%' : signedPct(v));
  const box = $('#hmap');
  const W = box.clientWidth || 360;
  const H = Math.round(Math.min(620, Math.max(340, W * (W < 600 ? 1.05 : 0.55))));
  box.style.height = `${H}px`;
  const minA = W < 600 ? 1500 : 2200; // これより小さいマスは名前が読めないので「他」へ
  // 大きさは売買代金の平方根（1銘柄が画面の大半を占めないように）
  const size = (t) => Math.sqrt(t);
  const bySec = new Map();
  for (const r of rows) { if (!bySec.has(r.sector)) bySec.set(r.sector, []); bySec.get(r.sector).push(r); }
  const sectors = [...bySec].map(([name, rs]) => {
    const raw = rs.reduce((t, r) => t + r.turnover, 0);
    return { name, rs: rs.sort((a, b) => b.turnover - a.turnover), raw, value: size(raw) };
  })
    .sort((a, b) => b.value - a.value);
  const drill = state.hmDrill && (state.hmDrill.type === 'sector' ? bySec.has(state.hmDrill.name) : true) ? state.hmDrill : null;
  const gap = 2, html = [];
  let crumb = '';

  if (drill?.type === 'sector') {
    // 1つの業種の中の銘柄
    const s = sectors.find((x) => x.name === drill.name);
    crumb = `<button class="hm-back" data-hm-back>← 全業種</button><b>${esc(s.name)}</b><span class="mono ${sign(wavgOf(s.rs, M.get))}">${fmtV(wavgOf(s.rs, M.get))}</span><small class="muted">${s.rs.length}銘柄</small>`;
    const { shown, rest } = fitItems(s.rs.map((r) => ({ value: size(r.turnover), r })), W * H, minA, 30);
    const items = [...shown];
    // 「他」は小さすぎると押せないので、最低でも全体の約8%の大きさに
    if (rest.length) items.push({ value: Math.max(size(rest.reduce((t, x) => t + x.r.turnover, 0)), shown.reduce((t, x) => t + x.value, 0) * 0.09), rest: rest.map((x) => x.r) });
    for (const t of squarify(items, 0, 0, W, H)) {
      const w = t.w - gap, h = t.h - gap;
      if (w <= 0 || h <= 0) continue;
      if (t.r) {
        const v = M.get(t.r);
        html.push(tileHtml({ x: t.x + gap / 2, y: t.y + gap / 2, w, h, bg: hmColor(v, M.scale), name: shortName(t.r.name), value: fmtV(v),
          attrs: `data-scr="${esc(t.r.sym)}"`, tip: `${t.r.name}（${t.r.sym}） ${M.label} ${fmtV(v)}` }));
      } else {
        const v = wavgOf(t.rest, M.get);
        html.push(tileHtml({ x: t.x + gap / 2, y: t.y + gap / 2, w, h, bg: hmColor(v, M.scale), name: `他${t.rest.length}銘柄`, value: fmtV(v),
          sub: t.rest.slice(0, 4).map((r) => esc(shortName(r.name))).join('・'), tip: `その他 ${t.rest.length}銘柄（売買代金で重みをつけた平均）` }));
      }
    }
  } else {
    // 業種ごと（小さい業種は「他の業種」にまとめ、押すと広げる）
    const list = drill?.type === 'sectors' ? sectors.filter((x) => drill.names.includes(x.name)) : sectors;
    if (drill) crumb = `<button class="hm-back" data-hm-back>← 全業種</button><b>小さい業種</b><small class="muted">${list.length}業種</small>`;
    else crumb = '<small class="muted">業種を押すと、その業種の銘柄を表示</small>';
    const { shown, rest } = fitItems(list, W * H, minA * 1.6);
    const items = [...shown];
    if (rest.length) items.push({ value: Math.max(size(rest.reduce((t, x) => t + x.raw, 0)), shown.reduce((t, x) => t + x.value, 0) * 0.09), group: rest });
    for (const t of squarify(items, 0, 0, W, H)) {
      const w = t.w - gap, h = t.h - gap;
      if (w <= 0 || h <= 0) continue;
      if (t.group) {
        const all = t.group.flatMap((x) => x.rs), v = wavgOf(all, M.get);
        html.push(tileHtml({ x: t.x + gap / 2, y: t.y + gap / 2, w, h, bg: hmColor(v, M.scale), name: `他${t.group.length}業種`, value: fmtV(v),
          attrs: `data-hm-group="${esc(t.group.map((x) => x.name).join('|'))}"`, sub: t.group.slice(0, 4).map((x) => esc(shortSector(x.name))).join('・'),
          tip: t.group.map((x) => x.name).join('、') }));
        continue;
      }
      const v = wavgOf(t.rs, M.get);
      const top = t.rs.slice(0, 3).map((r) => `<i>${esc(shortName(r.name))} <b class="mono">${fmtV(M.get(r))}</b></i>`).join('');
      html.push(tileHtml({ x: t.x + gap / 2, y: t.y + gap / 2, w, h, bg: hmColor(v, M.scale), name: shortSector(t.name), value: fmtV(v),
        attrs: `data-hm-sector="${esc(t.name)}"`, sub: top, tip: `${t.name}（${t.rs.length}銘柄） ${M.label} ${fmtV(v)}` }));
    }
  }
  box.innerHTML = html.join('');
  $('#hm-crumb').innerHTML = crumb;
  $('#hm-note').textContent = mode === 'chg' ? '大きさ＝売買代金・色＝今日の値動き' : '大きさ＝売買代金・色＝AI予測（市場平均との差）';
  const steps = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1];
  $('#hm-legend').innerHTML = steps.map((k) => `<span style="background:${hmColor(k * M.scale, M.scale)}">${k === 0 ? '0' : `${k > 0 ? '+' : '−'}${+(Math.abs(k) * M.scale).toFixed(1)}`}</span>`).join('')
    + `<small class="muted">%（±${M.scale}%で最も濃い色）</small>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-hm], [data-hm-sector], [data-hm-group], [data-hm-back]');
  if (!b) return;
  if (b.dataset.hm) { state.settings.hmMode = b.dataset.hm; save(); }
  else if (b.dataset.hmSector) state.hmDrill = { type: 'sector', name: b.dataset.hmSector };
  else if (b.dataset.hmGroup) state.hmDrill = { type: 'sectors', names: b.dataset.hmGroup.split('|') };
  else state.hmDrill = null;
  renderHeatmap();
});

let hmResize;
window.addEventListener('resize', () => { clearTimeout(hmResize); hmResize = setTimeout(() => { if (state.settings.tab === 'watch') renderHeatmap(); }, 200); });

const reasonChips = (s, n = 2) => (state.server.ai_reasons?.reasons?.[s] || []).filter((r) => r[1] > 0).slice(0, n)
  .map(([k, , v]) => `<span class="chip-soft">${esc(FEATURE_JA[k] || k)}${reasonValue(k, v) ? `：${esc(reasonValue(k, v))}` : ''}</span>`).join('');
const segName = (seg) => ({ P: 'プライム', S: 'スタンダード', G: 'グロース' }[seg] || '');
const predText = (p, d = 1) => `${p > 0 ? '+' : ''}${p.toFixed(d)}%`;

// 今日のAIピック：売買代金のある全銘柄から、AI予測の高い順（同じ業種は2銘柄まで）
function aiPicks(n = 5) {
  const rows = (state.server.screener?.rows || []).filter((r) => r.liquid && predOf(r) != null).sort((a, b) => predOf(b) - predOf(a));
  const out = [], per = {};
  for (const r of rows) {
    const k = r.sector || '-';
    if ((per[k] || 0) >= 2) continue;
    per[k] = (per[k] || 0) + 1;
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

// AIピックの「本番での答え合わせ」：実際に公開した予測の上位銘柄が、その後どうなったか（検証の数字だけでなく、本番の成績も必ず見せる）
function renderPickTrack() {
  const tr = state.server.ai_track;
  const box = $('#picks-track');
  const days = (tr?.days || []).filter((d) => d.top && d.elapsed >= 1);
  const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
  if (!days.length) {
    const pt = tr?.previous?.total;
    box.innerHTML = tr?.since ? `<a href="#" data-goto="perf" class="track"><b>本番の答え合わせ</b>
      <span>新しいモデル（${md(tr.since)}〜）の結果は、明日から毎日ここに出ます。</span>
      ${pt?.days ? `<small>前のモデルは ${pt.days}日分で上位銘柄が市場平均より ${pctf(pt.topExcess, 1)}（勝ち ${Math.round((pt.topWin || 0) * 100)}%）でした。新しいモデルも上位は銀行株に偏っているので、参考程度に見てください。</small>` : ''}</a>` : '';
    return;
  }
  const t = tr.total;
  const avg = days.reduce((a, d) => a + d.top.excess, 0) / days.length;
  const bad = avg < 0;
  box.innerHTML = `<a href="#" data-goto="perf" class="track ${bad ? 'bad' : 'good'}">
    <b>本番の答え合わせ</b>
    <span>${tr.since ? `新しいモデル（${md(tr.since)}〜）` : ''}${t?.days ? `5日後まで確定した${t.days}日分：上位銘柄は市場平均より <b class="mono">${pctf(t.topExcess, 1)}</b>` : `途中経過（${md(days.at(-1).date)}〜${md(days[0].date)}の予測）：上位銘柄は市場平均より <b class="mono">${pctf(avg, 1)}</b>`}</span>
    ${tr.previous?.total?.days ? `<small>前のモデル：${tr.previous.total.days}日分で ${pctf(tr.previous.total.topExcess, 1)}（勝ち ${Math.round((tr.previous.total.topWin || 0) * 100)}%）</small>` : ''}
    ${bad ? '<small>いまは予測が外れている時期です。上位は特定の業種に偏りやすく、その業種が逆に動くとまとめて外れます。参考程度に見てください。</small>' : '<small>過去の検証どおりに当たっているか、毎日確認しています。</small>'}
  </a>`;
}

function renderPicks() {
  const picks = useAI() ? aiPicks(5) : [];
  const hz = $('#hz');
  hz.hidden = !picks.length || !state.server.model20?.report;
  hz.querySelectorAll('[data-h]').forEach((b) => b.classList.toggle('on', Number(b.dataset.h) === (H20() ? 20 : 5)));
  if (picks.length) {
    $('#picks-title').textContent = '今日のAIピック';
    $('#picks-sub').textContent = H20() ? '1か月後（20営業日）に市場平均を上回る予測・高い順' : '1週間後（5営業日）に市場平均を上回る予測・高い順';
    renderPickTrack();
    const [top, ...rest] = picks;
    $('#picks').innerHTML = `
      <button class="hero" data-scr="${esc(top.sym)}">
        <div class="hero-head">
          <div><div class="code mono">${esc(top.sym)}${top.seg ? `・${segName(top.seg)}` : ''}</div><div class="hero-name">${esc(top.name)}</div></div>
          <div class="hero-ai"><b class="mono">${predText(predOf(top))}</b><small>${hLabel()}先・${topPct(rankOf(top))}</small>${H20() ? (top.pred != null ? `<small>1週間先 ${predText(top.pred)}</small>` : '') : (top.pred20 != null ? `<small>1か月先 ${predText(top.pred20)}</small>` : '')}</div>
        </div>
        <div class="chips">${reasonChips(top.sym)}</div>
        <div class="hero-foot">
          <span class="mono">${fmt(top.price)} <i class="${sign(top.changePct)}">${pct(top.changePct)}</i></span>
          ${top.stop ? `<span class="muted small">損切り ${fmt(top.stop)} ／ 利確 ${fmt(top.target)}</span>` : ''}
        </div>
      </button>
      ${rest.map((r) => `<button class="row" data-scr="${esc(r.sym)}">
        <span class="row-main"><span class="row-name">${esc(r.name)}</span><span class="code mono">${esc(r.sym)}</span></span>
        <span class="row-ai mono">${predText(predOf(r))}</span>
      </button>`).join('')}`;
    return;
  }
  const t = state.server.ai_track?.total;
  $('#picks-track').innerHTML = state.server.model?.report && state.settings.method === 'auto' && aiLiveFailing()
    ? `<a href="#" data-goto="perf" class="track bad"><b>AIピックを一時停止中</b>
        <span>本番の答え合わせで、AIの上位銘柄が市場平均より <b class="mono">${pctf(t.topExcess, 1)}</b>（${t.days}日分・勝ち ${Math.round((t.topWin || 0) * 100)}%）と外れ続けています。</span>
        <small>成績が戻るまで、ここはシグナル点数で表示します。AIの予測は銘柄の詳細には引き続き表示します（設定の判定方式で「AI予測」を選ぶと、ここにも出ます）。</small></a>`
    : '';
  // AI予測が無いとき（デモなど）は、ウォッチリストのシグナル点数で
  $('#picks-title').textContent = '今日の狙い目';
  $('#picks-sub').textContent = 'ウォッチリストから点数20以上';
  const ranked = state.settings.watchlist.filter((s) => state.analyses[s])
    .map((s) => ({ s, a: state.analyses[s] })).filter(({ a }) => LEVEL[a.verdict.key] >= 2)
    .sort((x, y) => y.a.score - x.a.score).slice(0, 4);
  $('#picks').innerHTML = ranked.length
    ? ranked.map(({ s, a }) => `<button class="row" data-sym="${esc(s)}">
        <span class="row-main"><span class="row-name">${esc(nameOf(s))}</span><span class="code mono">${esc(s)}</span></span>
        <span class="row-ai mono">${a.score}点</span></button>`).join('')
    : `<p class="empty">いまは条件を満たす銘柄がありません。<a href="#" data-goto="screener">探す</a>から全銘柄を見られます。</p>`;
}

function meter(sc) {
  return `<div class="meter"><i style="--v:${(sc + 100) / 2}%" class="${sc >= 0 ? 'pos' : 'neg'}"></i></div><span class="mono sc">${sc}</span>`;
}

// ウォッチリスト：AI予測の高い順
function renderTable() {
  const ai = useAI();
  $('#watch-sort').textContent = ai ? `AI予測（${hLabel()}先）の高い順` : '';
  const list = [...state.settings.watchlist].sort((x, y) => (ai ? (aiOf(y)?.pred ?? -99) - (aiOf(x)?.pred ?? -99) : 0));
  $('#rows').innerHTML = list.map((s) => {
    const q = state.quotes[s], a = state.analyses[s], cs = state.candles[s];
    const flash = q?.flash > 0 ? 'flash-up' : q?.flash < 0 ? 'flash-down' : '';
    const failed = cs && !cs.length;
    const p = aiOf(s);
    return `<button class="wrow ${state.selected === s ? 'sel' : ''}" data-sym="${esc(s)}">
      <span class="row-main"><span class="row-name">${esc(nameOf(s))}</span><span class="code mono">${esc(s)}</span>${eventChips(s) ? `<span class="evs">${eventChips(s)}</span>` : ''}</span>
      <span class="wprice mono ${flash}">${failed ? '<span class="muted small">取得不可</span>' : `${fmt(q?.price)}<i class="${sign(q?.changePct)}">${pct(q?.changePct)}</i>`}</span>
      <span class="wai mono ${p ? sign(p.pred) : ''}">${ai && p ? predText(p.pred) : a && !failed ? `${a.score}点` : '—'}</span>
    </button>`;
  }).join('') || '<p class="empty">ウォッチリストは空です。下の欄から追加できます。</p>';
}

function symbolStats(s) {
  if (!state.symStats[s] && state.candles[s]?.length > 90) state.symStats[s] = signalStats({ [s]: state.candles[s] });
  return state.symStats[s];
}

function renderDetail() {
  const s = state.selected;
  const box = $('#detail');
  if (!s) { box.hidden = true; return; }
  box.hidden = false;
  const q = state.quotes[s], a = state.analyses[s], al = state.settings.alerts[s] || {};
  $('#d-title').innerHTML = `<span class="sym">${esc(s)}</span> ${esc(nameOf(s))}`;
  $('#d-price').innerHTML = `<span class="mono big">${fmt(q?.price)}</span> <span class="mono ${sign(q?.change)}">${q ? (q.change > 0 ? '+' : '') + fmt(q.change) : ''} (${pct(q?.changePct)})</span>`;

  // 決算・権利落ちの警告
  const e = eventsOf(s);
  const evs = eventBadges(s);
  $('#d-events').innerHTML = evs.length
    ? `<div class="warn ${evs.some((b) => b.days <= 3) ? 'hot' : ''}">⚠ ${evs.map((b) => esc(b.text)).join('・')} — 発表前後は値動きが荒くなりやすく、テクニカルのシグナルが効きにくくなります。</div>`
    : e ? `<div class="muted small">次の決算: ${esc(e.earnings || '不明')} ／ 権利落ち: ${esc(e.exDiv || '不明')}${e.exDivEstimated ? '（推定）' : ''}</div>` : '';

  // シグナルと過去成績
  const us = universeStats(), ss = symbolStats(s);
  const statLine = (st, label) => (st?.n ? `${label} 勝率${(st.win * 100).toFixed(0)}%・平均${pctf(st.avg, 2)}（${st.n}回）` : '');
  $('#d-signals').innerHTML = a?.signals.length
    ? a.signals.map((x) => `<li class="${x.weight > 0 ? 'pos' : 'neg'}"><b class="mono">${x.weight > 0 ? '+' : ''}${x.weight}</b><div><strong>${esc(x.label)}</strong><small>${esc(x.detail)}</small>
        <small class="bt">${[statLine(ss?.stats[x.id], 'この銘柄:'), statLine(us?.stats[x.id], '全銘柄:')].filter(Boolean).join(' ／ ') || '過去データ不足'}</small></div></li>`).join('')
    : '<li class="muted">目立ったシグナルはありません</li>';
  const mr = state.server.model?.report, mr20 = state.server.model20?.report;
  const x = a?.ai;
  const hcell = (p, r, label, rep) => (p == null ? '' : `<div class="hcell">
      <small>${label}</small>
      <b class="mono ${p >= 0 ? 'aiup' : 'down'}">${signedPct(p, 2)}</b>
      <span class="aipos">${r != null ? topPct(r) : '順位の対象外'}</span>
      ${rep?.top2pct ? `<small class="muted">上位2%の過去成績 平均${pctf(rep.top2pct.excess, 1)}・勝率${Math.round(rep.top2pct.win * 100)}%</small>` : ''}
    </div>`);
  $('#d-aipred').innerHTML = x ? `<div class="aipred">
      <small>AI予測（市場平均との差・売買代金のある銘柄の中での順位）</small>
      <div class="hgrid">${hcell(x.p5, x.r5, '1週間先（5営業日）', mr)}${hcell(x.p20, x.r20, '1か月先（20営業日）', mr20)}</div>
      ${x.r5 == null && x.p5 != null ? '<small class="muted">売買代金が少ないため順位の対象外です</small>' : ''}
      ${reasonsHtml(s)}
      ${mr?.from ? `<small class="muted">過去成績は学習に使っていない期間（${mr.from}〜）での結果です。</small>` : ''}
    </div>` : '';
  $('#d-score').innerHTML = a ? `シグナル点数 <b class="mono">${a.score}</b> ・ <span class="badge ${a.verdict.key}">${a.verdict.label}</span>${useAI() && a.ai ? '<small class="muted pen">判定はAI予測の順位で表示中（設定で変更）</small>' : ''}`
    + (a.penalty ? `<small class="muted pen">地合いで −${a.penalty}点（元 ${a.rawScore}点）</small>` : '') : '';
  $('#d-levels').innerHTML = levelLine(s) + fundaLine(s)
    + (levels(state.candles[s]) ? `<small class="muted">損切りは普段の値幅(ATR)の2倍下、利確は3倍上の目安です。</small>` : '');

  // 「なぜ今？」解説：自分のキーで生成 ＞ Actions で自動生成（無料AI/Claude） ＞ ルールによる自動まとめ
  const cached = store.get(`kr:ai:${s}:${todayJst()}`);
  const srv = state.server.ai?.[s];
  const srvFresh = srv && a && srv.key?.endsWith(':' + a.signals.map((x) => x.id).sort().join(','));
  let text, note;
  if (cached) { text = cached.text; note = `AI（あなたのキー）・${cached.date}`; }
  else if (srvFresh) { text = srv.text; note = `AI（${srv.source || '自動生成'}）・${srv.date}`; }
  else if (a) {
    text = ruleExplain({ score: a.score, verdict: verdictOf(a.score).label, signals: a.signals, stats: us?.stats || {}, events: eventsOf(s), today: todayJst() });
    note = '自動まとめ（AIなし・無料）';
  }
  $('#d-ai-text').innerHTML = state.aiBusy
    ? '<p class="muted">Claude が考えています…</p>'
    : text ? text.split('\n').filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('') + `<small class="muted">${esc(note)}</small>` : '';
  $('#d-ai-btn').hidden = !state.settings.aiKey;
  $('#d-ai-btn').disabled = state.aiBusy;

  renderMemos(s);

  // 最新の決算（決算短信の数字）
  const le = latestEarnings(s);
  $('#d-earn').innerHTML = le ? `<div class="earn ${finTone(le[5])}"><div class="earn-head"><b>最新の決算</b><small>${+le[0].slice(5, 7)}/${+le[0].slice(8, 10)} 発表</small></div>
      <div class="earn-body">${esc(finLong(le[5]))}</div></div>` : '';
  // 適時開示・IR（銘柄を開いたときに、その銘柄の全部の開示を読み込む）
  const base = state.server.tdnet?.base || 'https://www.release.tdnet.info/inbs/';
  const all = state.irCache?.[s];
  if (all === undefined && state.provider?.static) loadIr(s);
  const tds = (all || disclosuresOf(s)).slice(0, 15);
  $('#d-tdnet').innerHTML = tds.length
    ? tds.map(([d, tm, c, title, pdf, x]) => `<li><span class="ev td ${tdTone(c, x)}">${esc(tdLabel(c, x))}</span>
        ${pdf ? `<a href="${esc(base + pdf)}" target="_blank" rel="noopener">${esc(title)}</a>` : esc(title)}${(c === 'up' || c === 'down' || c === 'revise') && x ? `<div class="rev ${x.pct > 0 ? 'up' : x.pct < 0 ? 'down' : ''}">${esc(revText(x, true))}</div>` : c === 'earnings' && x ? `<div class="rev ${finTone(x) === 'good' ? 'up' : finTone(x) === 'bad' ? 'down' : ''}">${esc(finLong(x))}</div>` : ''}<small>${+d.slice(5, 7)}/${+d.slice(8, 10)} ${esc(tm)}</small></li>`).join('')
    : `<li class="muted">${state.server.tdnet ? '直近4か月に開示はありません' : '適時開示は自動取得データのモードで表示されます'}</li>`;

  // ニュース
  const ns = newsOf(s);
  $('#d-news').innerHTML = ns.length
    ? ns.map((n) => `<li><a href="${esc(n.link || '#')}" target="_blank" rel="noopener">${esc(n.title)}</a><small>${esc(n.publisher || '')}${n.time ? ' ・ ' + esc(new Date(n.time).toLocaleDateString('ja-JP')) : ''}</small></li>`).join('')
    : '<li class="muted">ニュースはありません（自動取得データのモードで表示されます）</li>';

  const uniBtn = $('#d-universe');
  uniBtn.hidden = !state.provider?.static || !state.universe;
  uniBtn.textContent = inUniverse(s) ? '自動取得の対象から外す' : '自動取得の対象に追加をリクエスト';
  const inList = state.settings.watchlist.includes(s);
  $('#d-remove').textContent = inList ? 'ウォッチリストから外す' : '＋ウォッチリストに追加';
  $('#d-remove').classList.toggle('danger', inList);
  const ab = $('#al-above'), bl = $('#al-below');
  if (document.activeElement !== ab) ab.value = al.above ?? '';
  if (document.activeElement !== bl) bl.value = al.below ?? '';
  drawChart($('#chart'), state.candles[s], a?.ind);
}

function aiContext(s) {
  const a = state.analyses[s], q = state.quotes[s], us = universeStats();
  return {
    sym: s, name: nameOf(s), price: q?.price, changePct: q?.changePct, score: a.score, verdict: a.verdict.label,
    signals: a.signals, events: eventsOf(s), news: newsOf(s),
    stats: a.signals.map((x) => ({ label: x.label, ...(us?.stats[x.id] || {}) })).filter((x) => x.n),
  };
}

// Claude アプリ（無料プランでも可）で聞く：質問文をコピーして claude.ai を開く
async function askInClaudeApp() {
  const s = state.selected;
  if (!state.analyses[s]) return;
  const prompt = chatPrompt(aiContext(s));
  try { await navigator.clipboard.writeText(prompt); toast('質問文をコピーしました。開いた Claude に貼り付けて送信してください'); } catch {}
  window.open(`https://claude.ai/new?q=${encodeURIComponent(prompt)}`, '_blank', 'noopener');
}

async function askAi() {
  const s = state.selected;
  if (!state.settings.aiKey) { toast('設定で Anthropic APIキーを入力してください'); openSettings(); return; }
  state.aiBusy = true; renderDetail();
  try {
    const text = await explain({
      apiKey: state.settings.aiKey, model: state.settings.aiModel, browser: true,
      ctx: aiContext(s),
    });
    store.set(`kr:ai:${s}:${todayJst()}`, { text, date: todayJst() });
  } catch (e) {
    toast(`AI解説に失敗: ${e.message}`, 'err');
  } finally {
    state.aiBusy = false; renderDetail();
  }
}

// ---------- スクリーナー ----------
function screenerRows() {
  const rows = state.server.screener?.rows || state.local.rows || [];
  const w = W();
  return rows.map((r) => {
    const pen = penaltyFor(r.sym);
    const score = Math.max(-100, scoreOf(r.ids, w) - pen);
    const verdict = useAI() && predOf(r) != null ? aiVerdict(r.liquid ? rankOf(r) : null) : verdictOf(score);
    return { ...r, score, penalty: pen, verdict };
  });
}

function renderScreener() {
  const f = state.scr;
  const src = state.server.screener ? `東証${state.server.screener.rows.length.toLocaleString()}銘柄（${new Date(state.server.screener.updatedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 更新）` : `デモ${state.local.rows?.length ?? 0}銘柄（ブラウザ内で計算）`;
  const secSel = $('#scr-sector');
  if (state.sectors && secSel.options.length <= 1) secSel.innerHTML = '<option value="all">全業種</option>' + state.sectors.map((x) => `<option>${esc(x)}</option>`).join('');
  $('#scr-src').textContent = src;
  const q = f.q.trim().toLowerCase();
  const rows = screenerRows()
    .filter((r) => f.seg === 'all' || r.seg === f.seg)
    .filter((r) => f.sector === 'all' || r.sector === f.sector)
    .filter((r) => !f.liquid || r.liquid !== false)
    .filter((r) => LEVEL[r.verdict.key] >= f.min)
    .filter((r) => !q || r.sym.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))
    .filter((r) => FUNDA_FILTERS[f.funda].test(r))
    .sort((a, b) => (useAI() ? (predOf(b) ?? -99) - (predOf(a) ?? -99) : b.score - a.score));
  const shown = rows.slice(0, f.limit);
  $('#scr-count').textContent = `${rows.length.toLocaleString()}件${rows.length > shown.length ? `（上位${shown.length}件を表示）` : ''}`;
  $('#scr-more').hidden = rows.length <= shown.length;
  $('#scr-rows').innerHTML = shown.length
    ? shown.map((r) => {
        const inList = state.settings.watchlist.includes(r.sym);
        return `<tr data-scr="${esc(r.sym)}">
          <td><div class="sym">${esc(r.sym)} ${r.seg ? `<span class="mk">${{ P: 'プ', S: 'ス', G: 'グ' }[r.seg] || ''}</span>` : ''}${r.liquid === false ? '<span class="mk thin">薄商い</span>' : ''}</div><div class="nm">${esc(r.name)}</div><div class="evs">${eventChips(r.sym)}</div></td>
          <td class="mono num">${fmt(r.price)}<div class="${sign(r.changePct)} small">${pct(r.changePct)}</div></td>
          <td>${useAI() && predOf(r) != null ? `${aiLabel({ pred: predOf(r) })}<div class="nm">${hLabel()}・${r.liquid ? topPct(rankOf(r)) : '順位対象外'}</div>` : meter(r.score)}<div><span class="badge ${r.verdict.key}">${r.verdict.label}</span></div></td>
          <td class="small fnd"><div>PER ${r.per != null ? r.per.toFixed(1) : '—'}</div><div>PBR ${r.pbr != null ? r.pbr.toFixed(2) : '—'}</div><div>利回り ${r.divYield != null ? (r.divYield * 100).toFixed(1) + '%' : '—'}</div></td>
          <td class="hide-sm small">${r.ids.map((id) => esc(SIGNAL_MAP[id].label)).join('、') || '—'}</td>
          <td><button class="mini ${inList ? 'ghost' : ''}" data-add="${esc(r.sym)}">${inList ? '✓' : '＋'}<span class="hide-sm">${inList ? '登録済' : '監視'}</span></button></td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="6" class="muted">条件に合う銘柄はありません。スコアの下限や条件をゆるめてみてください。</td></tr>';
}

const FUNDA_FILTERS = {
  all: { label: '財務条件なし', test: () => true },
  div: { label: '高配当（利回り3%以上）', test: (r) => r.divYield >= 0.03 },
  pbr: { label: '割安（PBR1倍未満）', test: (r) => r.pbr != null && r.pbr < 1 },
  per: { label: '割安（PER15倍未満）', test: (r) => r.per != null && r.per < 15 },
  divdip: { label: '高配当×売られすぎ', test: (r) => r.divYield >= 0.03 && r.ids.some((id) => ['short_oversold', 'bb_lower', 'dip_in_uptrend', 'sharp_drop'].includes(id)) },
  revup: { label: '業績の上方修正（30日以内）', test: (r) => disclosuresOf(r.sym).some(([d, , c]) => c === 'up' && daysSince(d) <= 30) },
  revdown: { label: '業績の下方修正（30日以内）', test: (r) => disclosuresOf(r.sym).some(([d, , c]) => c === 'down' && daysSince(d) <= 30) },
  buyback: { label: '自社株買いの発表（30日以内）', test: (r) => disclosuresOf(r.sym).some(([d, , c]) => c === 'buyback' && daysSince(d) <= 30) },
  goodearn: { label: '好決算（増収増益・30日以内）', test: (r) => disclosuresOf(r.sym).some(([d, , c, , , x]) => c === 'earnings' && daysSince(d) <= 30 && x?.profitYoY > 0 && (x.salesYoY == null || x.salesYoY > 0)) },
  progress: { label: '通期予想に対して進捗が順調（30日以内の決算）', test: (r) => { const e = latestEarnings(r.sym); return !!e && daysSince(e[0]) <= 30 && e[5].progress != null && e[5].q < 4 && e[5].progress - e[5].q * 0.25 >= 0.05; } },
  badearn: { label: '減益の決算（30日以内）', test: (r) => disclosuresOf(r.sym).some(([d, , c, , , x]) => c === 'earnings' && daysSince(d) <= 30 && x?.profitYoY < 0) },
  value: { label: '割安×上昇トレンド', test: (r) => ((r.pbr != null && r.pbr < 1.2) || (r.per != null && r.per < 15)) && r.ids.includes('uptrend') },
};

// ---------- ペーパートレード ----------
function paperBlock(p, rulesText) {
  const closed = p.closed || [];
  const realized = closed.reduce((a, t) => a + t.ret * p.notional, 0);
  const unreal = (p.open || []).reduce((a, t) => a + (t.ret || 0) * p.notional, 0);
  const wins = closed.filter((t) => t.ret > 0).length;
  return `<p class="muted small">${rulesText}</p>
    <div class="kpis">
      <div><small>運用開始</small><b>${esc(p.startedAt)}</b></div>
      <div><small>確定損益</small><b class="${sign(realized)}">${yen(realized)}</b></div>
      <div><small>含み損益</small><b class="${sign(unreal)}">${yen(unreal)}</b></div>
      <div><small>勝率</small><b>${closed.length ? `${Math.round((wins / closed.length) * 100)}%` : '—'}</b><small>${closed.length}回決済</small></div>
    </div>
    <h3>保有中（${p.open.length}）</h3>
    ${tradeTable(p.open, true)}
    <h3>決済済み</h3>
    ${tradeTable(closed.slice(0, 50), false)}`;
}

function renderPaper() {
  const pa = state.server.paper_ai;
  $('#paper-ai').innerHTML = pa ? paperBlock(pa, 'AI予測の上位5%（売買代金1億円以上）から同じ業種は2銘柄まで・1日5銘柄までを1回¥100,000分ずつ買い、+10%利確・−5%損切り・最長5営業日で売ります。')
    : '<p class="muted">AI予測のデータができると記録が始まります。</p>';
  const p = state.server.paper;
  if (p) {
    const closed = p.closed || [];
    const realized = closed.reduce((a, t) => a + t.ret * p.notional, 0);
    const unreal = (p.open || []).reduce((a, t) => a + (t.ret || 0) * p.notional, 0);
    const wins = closed.filter((t) => t.ret > 0).length;
    $('#paper-live').innerHTML = `
      <div class="kpis">
        <div><small>運用開始</small><b>${esc(p.startedAt)}</b></div>
        <div><small>確定損益</small><b class="${sign(realized)}">${yen(realized)}</b></div>
        <div><small>含み損益</small><b class="${sign(unreal)}">${yen(unreal)}</b></div>
        <div><small>勝率</small><b>${closed.length ? `${Math.round((wins / closed.length) * 100)}%` : '—'}</b><small>${closed.length}回決済</small></div>
      </div>
      <h3>保有中（${p.open.length}）</h3>
      ${tradeTable(p.open, true)}
      <h3>決済済み</h3>
      ${tradeTable(closed.slice(0, 50), false)}`;
  } else {
    $('#paper-live').innerHTML = `<p class="empty">GitHub Actions がデータを生成すると、ここに実運用ログが自動で記録されます（スコア${DEFAULT_RULES.entry}以上で1回¥${(100000).toLocaleString()}分を仮想購入）。</p>`;
  }
  const bt = state.server.backtest || state.local;
  const st = bt?.strategy?.filtered || bt?.strategy?.base;
  $('#paper-sim').innerHTML = st
    ? `<div class="kpis">
        <div><small>取引回数</small><b>${st.trades}</b></div>
        <div><small>勝率</small><b>${st.win != null ? Math.round(st.win * 100) + '%' : '—'}</b></div>
        <div><small>平均リターン</small><b class="${sign(st.avg)}">${pctf(st.avg, 2)}</b></div>
        <div><small>合計損益</small><b class="${sign(st.pnl)}">${yen(st.pnl)}</b></div>
      </div>
      <h3>直近の取引</h3>${tradeTable((bt.trades || []).slice(0, 20), false)}`
    : '<p class="muted">計算中…</p>';
}

function tradeTable(list, open) {
  if (!list?.length) return '<p class="muted small">なし</p>';
  return `<div class="table-wrap"><table class="trades"><thead><tr><th>銘柄</th><th>買い</th><th>${open ? '現在' : '売り'}</th><th class="num">損益</th><th class="hide-sm">${open ? '保有' : '理由'}</th></tr></thead><tbody>
    ${list.map((t) => `<tr data-scr="${esc(t.sym)}">
      <td><div class="sym">${esc(t.sym)}</div><div class="nm">${esc(t.name || '')}</div></td>
      <td class="small"><div>${esc(t.entryDate)}</div><div class="mono">${fmt(t.entryPrice)}</div></td>
      <td class="small"><div>${esc(open ? '' : t.exitDate || '保有中')}</div><div class="mono">${fmt(open ? t.lastPrice : t.exitPrice)}</div></td>
      <td class="mono num ${sign(t.ret)}">${pctf(t.ret)}<div class="small">${yen((t.ret || 0) * 100000)}</div></td>
      <td class="hide-sm small">${open ? `${t.held ?? 0}日` : esc(t.reason)}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

// ---------- 保有株 ----------
const fxRate = () => state.server.market?.indices?.USDJPY?.price || null;
const money = (v, cur) => (cur === 'USD' ? `$${fmt(v)}` : `¥${Math.round(v).toLocaleString('ja-JP')}`);

function holdingView(h) {
  const cs = state.candles[h.sym], q = state.quotes[h.sym], a = state.analyses[h.sym];
  const manual = !(q?.price ?? cs?.at(-1)?.close) && h.manualPrice > 0;
  const price = q?.price ?? cs?.at(-1)?.close ?? (h.manualPrice > 0 ? h.manualPrice : null);
  const cur = marketOf(h.sym) === 'JP' ? 'JPY' : 'USD';
  const value = price != null ? price * h.shares : null;
  const pnl = price != null ? (price - h.cost) * h.shares : null;
  const lv = cs?.length ? holdingLevels(cs, h.cost) : null;
  const warns = [];
  // 売り時：AI予測が下位（今後5日で市場平均に負けそう）なら売り候補。下位2%は検証で平均−3%
  const ai = aiOf(h.sym);
  if (ai?.r5 != null && ai.r5 <= 0.1) warns.push({ hot: ai.r5 <= 0.05, sell: true, text: `AI売り候補（1週間先 ${topPct(ai.r5)}・${signedPct(ai.p5)}予測）` });
  if (a) {
    if (a.score <= -20) warns.push({ hot: true, text: `売りシグナル（点数${a.score}）` });
    for (const x of a.signals) if (['dead_cross', 'trend_break', 'short_overbought', 'vol_surge_down', 'bb_upper'].includes(x.id)) warns.push({ text: x.label });
  }
  if (lv && price != null && price <= lv.stop) warns.push({ hot: true, text: `損切りライン ${fmt(lv.stop)} 割れ` });
  if (lv && price != null && price >= lv.target) warns.push({ text: `利確目安 ${fmt(lv.target)} 到達` });
  for (const b of eventBadges(h.sym)) if (b.days <= 7) warns.push({ hot: b.days <= 3, text: b.text });
  for (const [d, , c, , , rev] of recentDisclosures(h.sym, 7)) warns.push({ hot: tdTone(c, rev) === 'bad', text: `${tdLabel(c, rev)}の開示（${+d.slice(5, 7)}/${+d.slice(8, 10)}）` });
  return { ...h, price, manual, cur, value, pnl, pnlPct: price != null ? price / h.cost - 1 : null, lv, a, ai, warns };
}

function renderHoldings() {
  // AI予測の高い順（予測の無い銘柄は最後）
  const list = state.settings.holdings.map(holdingView).sort((a, b) => (b.ai?.pred ?? -99) - (a.ai?.pred ?? -99));
  const fx = fxRate();
  const tot = { JPY: { v: 0, c: 0 }, USD: { v: 0, c: 0 } };
  for (const h of list) if (h.value != null) { tot[h.cur].v += h.value; tot[h.cur].c += h.cost * h.shares; }
  const unpriced = list.filter((h) => h.value == null);
  const jpyAll = tot.JPY.v + (fx ? tot.USD.v * fx : 0), jpyCost = tot.JPY.c + (fx ? tot.USD.c * fx : 0);
  $('#hold-sum').innerHTML = list.length ? `<div class="kpis">
      <div><small>評価額（円換算）</small><b>¥${Math.round(jpyAll).toLocaleString('ja-JP')}</b>${tot.USD.v && fx ? `<small>ドル円 ${fx.toFixed(2)} で換算</small>` : ''}</div>
      <div><small>含み損益</small><b class="${sign(jpyAll - jpyCost)}">${yen(jpyAll - jpyCost)}</b><small>${pctf(jpyCost ? jpyAll / jpyCost - 1 : null)}</small></div>
      <div><small>要注意</small><b class="${list.some((h) => h.warns.some((w) => w.hot)) ? 'down' : ''}">${list.filter((h) => h.warns.length).length}銘柄</b></div>
      <div><small>AIの売り候補</small><b class="${list.some((h) => h.warns.some((w) => w.sell)) ? 'down' : ''}">${list.filter((h) => h.warns.some((w) => w.sell)).length}銘柄</b><small>予測が下位10%</small></div>
    </div>${unpriced.length ? `<p class="warn">${unpriced.map((h) => esc(h.sym)).join('・')} は株価を取得できないため、合計に含めていません。</p>` : ''}
    <p class="muted small">損益は「（最新の終値 − 登録した買値）× 株数」です。証券会社の表示と合わない場合は、登録した買値（1株あたりの平均取得単価）と株数を確認してください。手数料・税金は含みません。</p>` : '';
  $('#hold-rows').innerHTML = list.length ? list.map((h) => `<tr data-sym="${esc(h.sym)}">
      <td><div class="sym">${esc(h.sym)}</div><div class="nm">${esc(nameOf(h.sym))}</div><div class="nm show-sm mono">${h.shares.toLocaleString()}株 @${fmt(h.cost)}</div>${h.a ? `<span class="badge ${h.a.verdict.key}">${h.a.verdict.label}</span>` : ''}</td>
      <td class="num small hide-sm"><div class="mono">${h.shares.toLocaleString()}株</div><div class="mono muted">@${fmt(h.cost)}</div></td>
      <td class="num">${h.price != null ? `<div class="mono">${fmt(h.price)}${h.manual ? '<small class="muted">手入力</small>' : ''}</div>` : `<input class="mprice" type="number" step="any" inputmode="decimal" placeholder="現在値" data-mprice="${esc(h.id)}" />`}
        <div class="mono small">${h.value != null ? money(h.value, h.cur) : ''}</div>${h.ai ? `<div>${aiBoth(h.ai)}</div>` : ''}</td>
      <td class="num ${sign(h.pnl)}"><div class="mono">${h.pnl != null ? (h.pnl >= 0 ? '+' : '−') + money(Math.abs(h.pnl), h.cur) : '—'}</div><div class="mono small">${pctf(h.pnlPct)}</div></td>
      <td class="hide-sm small">${h.lv ? `<div>損切り <b class="mono">${fmt(h.lv.stop)}</b></div><div>利確 <b class="mono">${fmt(h.lv.target)}</b></div>` : ''}</td>
      <td class="small warns">${h.warns.length ? h.warns.map((w) => `<span class="ev ${w.hot ? 'hot' : ''}">${esc(w.text)}</span>`).join(' ') : '<span class="muted">—</span>'}
        <div><button class="mini ghost" data-del-hold="${esc(h.id)}">削除</button></div></td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="muted">まだ登録がありません。上のフォームか「CSVから取り込む」で登録してください。</td></tr>';
  renderMix(list);
  renderDividends(list);
  renderCalendar();
  renderAllMemos();
}

const sectorOf = (s) => rowOf(s)?.sector || state.universe?.get(s)?.sector || null;
const bar = (w, cls = '') => `<div class="wbar ${cls}"><i style="width:${Math.min(100, w * 100).toFixed(1)}%"></i></div>`;

// 偏りチェック：業種40%超・1銘柄30%超で注意
function renderMix(list) {
  const fx = fxRate();
  const c = concentration(list.map((h) => ({ sym: h.sym, sector: sectorOf(h.sym), value: h.value != null ? h.value * (h.cur === 'USD' ? fx || 0 : 1) : 0 })));
  $('#hold-mix-sec').hidden = c.stocks.length < 1;
  if (!c.stocks.length) return;
  const warnText = c.warns.map((w) => (w.kind === 'sector'
    ? `「${esc(w.name)}」が${Math.round(w.w * 100)}%（目安40%以下）`
    : `${esc(nameOf(w.sym))} 1銘柄で${Math.round(w.w * 100)}%（目安30%以下）`)).join('・');
  $('#hold-mix').innerHTML = `
    ${c.warns.length ? `<p class="warn">⚠ 偏りがあります：${warnText}。同じ業種は一緒に下がりやすいので、下落時の痛手が大きくなります。</p>`
      : c.stocks.length > 1 ? '<p class="muted small">✓ 業種・銘柄の偏りは目安の範囲内です。</p>' : ''}
    <div class="mix">
      <div><h3>業種別</h3>${c.sectors.map((x) => `<div class="mixrow"><span>${esc(x.name)}</span>${bar(x.w, x.w > 0.4 ? 'hot' : '')}<span class="mono">${Math.round(x.w * 100)}%</span></div>`).join('')}</div>
      <div><h3>銘柄別</h3>${c.stocks.map((x) => `<div class="mixrow"><span>${esc(nameOf(x.sym))}</span>${bar(x.w, x.w > 0.3 && c.stocks.length > 1 ? 'hot' : '')}<span class="mono">${Math.round(x.w * 100)}%</span></div>`).join('')}</div>
    </div>
    <p class="muted small">実質的な分散銘柄数 <b class="mono">${c.effectiveN.toFixed(1)}</b>（全部同じ金額なら銘柄数と同じ。少ないほど一部の銘柄に偏っています）</p>`;
}

// 配当金の見込み：過去12か月の1株配当 × 株数
function renderDividends(list) {
  const divs = state.server.dividends;
  const jp = list.filter((h) => h.cur === 'JPY');
  $('#hold-div-sec').hidden = !divs || !jp.length;
  if (!divs || !jp.length) return;
  const plan = dividendPlan(jp, divs, todayJst());
  const maxM = Math.max(...plan.months, 1);
  const paying = plan.rows.filter((r) => r.annual > 0);
  const nextEx = jp.map((h) => ({ sym: h.sym, e: eventsOf(h.sym) })).filter((x) => x.e?.exDiv && x.e.exDiv >= todayJst()).sort((a, b) => a.e.exDiv.localeCompare(b.e.exDiv))[0];
  $('#hold-div').innerHTML = `<div class="kpis">
      <div><small>年間の配当（税引前）</small><b>¥${Math.round(plan.total).toLocaleString('ja-JP')}</b><small>月あたり 約¥${Math.round(plan.total / 12).toLocaleString('ja-JP')}</small></div>
      <div><small>特定口座なら（税引後）</small><b>¥${Math.round(plan.afterTax).toLocaleString('ja-JP')}</b><small>税率${(TAX * 100).toFixed(3)}%。NISA分は非課税</small></div>
      ${nextEx ? `<div><small>次の権利落ち</small><b class="small-b">${esc(nextEx.e.exDiv.slice(5).replace('-', '/'))}</b><small>${esc(nameOf(nextEx.sym))}${nextEx.e.exDivEstimated ? '（推定）' : ''}・前日までに保有</small></div>` : ''}
    </div>
    <h3>権利落ちの月（この月に持っていると配当がもらえる）</h3>
    <div class="dcal">${plan.months.map((v, i) => `<div class="dm ${v ? 'on' : ''}"><div class="dbar"><i style="height:${(v / maxM) * 100}%"></i></div><span class="mono">${i + 1}月</span><small class="mono">${v ? `¥${v >= 10000 ? `${(v / 10000).toFixed(1)}万` : Math.round(v).toLocaleString('ja-JP')}` : ''}</small></div>`).join('')}</div>
    <div class="table-wrap"><table class="compact"><thead><tr><th>銘柄</th><th class="num">1株配当</th><th class="num">年間</th><th class="num hide-sm">取得利回り</th><th>月</th></tr></thead><tbody>
    ${paying.map((r) => `<tr data-sym="${esc(r.sym)}"><td>${esc(nameOf(r.sym))}</td><td class="num mono">${fmt(r.perShare)}</td><td class="num mono">¥${Math.round(r.annual).toLocaleString('ja-JP')}</td><td class="num mono hide-sm">${r.yieldOnCost != null ? (r.yieldOnCost * 100).toFixed(2) + '%' : '—'}</td><td class="small">${r.months.map((m) => `${m}月`).join('・')}</td></tr>`).join('')}
    ${plan.rows.filter((r) => !r.annual).length ? `<tr><td colspan="5" class="muted small">過去12か月に配当なし：${plan.rows.filter((r) => !r.annual).map((r) => esc(nameOf(r.sym))).join('・')}</td></tr>` : ''}
    </tbody></table></div>
    <p class="muted small">過去12か月の実績が来年も同じと仮定した目安です（増配・減配・記念配当は反映されません）。入金は権利確定のおよそ2〜3か月後です。</p>`;
}

// 予定カレンダー：保有株とウォッチリストの決算・権利落ち（60日先まで）
function renderCalendar() {
  const held = new Set(state.settings.holdings.map((h) => h.sym));
  const syms = [...new Set([...held, ...state.settings.watchlist])];
  const ev = upcoming(syms.map((s) => ({ sym: s, tag: held.has(s) ? 'hold' : 'watch', events: eventsOf(s) })), todayJst(), 60);
  const wd = (d) => '日月火水木金土'[new Date(d + 'T00:00:00+09:00').getDay()];
  let last = '';
  $('#hold-cal').innerHTML = ev.length ? `<ul class="cal">${ev.map((x) => {
    const head = x.date !== last ? `<li class="cal-day"><b class="mono">${x.date.slice(5).replace('-', '/')}</b>（${wd(x.date)}）<small class="muted">${x.days === 0 ? '今日' : `あと${x.days}日`}</small></li>` : '';
    last = x.date;
    return `${head}<li class="cal-ev" data-sym="${esc(x.sym)}"><span class="ev ${x.kind === 'earnings' ? 'hot' : ''}">${x.kind === 'earnings' ? '決算' : `権利落ち${x.estimated ? '(推定)' : ''}`}</span>
      <span>${esc(nameOf(x.sym))} <small class="muted mono">${esc(x.sym)}</small></span><span class="tag ${x.tag}">${x.tag === 'hold' ? '保有' : '監視'}</span></li>`;
  }).join('')}</ul><p class="muted small">決算の前後は値動きが荒くなりやすいです。権利落ち日の前日までに持っていると配当・優待がもらえます（権利落ち日は株価が配当分ほど下がりやすい）。</p>`
    : '<p class="muted small">60日以内に予定はありません（日付は東証の決算発表予定と、過去の配当実績からの推定です）。</p>';
}

// ---------- 売買メモ ----------
const memosOf = (s) => state.settings.memos?.[s] || [];
const memoLine = (s, m) => {
  const now = state.quotes[s]?.price ?? state.candles[s]?.at(-1)?.close ?? rowOf(s)?.price;
  const ch = now != null && m.price ? now / m.price - 1 : null;
  return `<div class="memo-meta"><span class="mono">${esc(m.date)}</span>${m.price ? `<span class="mono">そのとき ${fmt(m.price)}</span>` : ''}${ch != null ? `<span class="mono ${sign(ch)}">今 ${pctf(ch)}</span>` : ''}${m.p5 != null ? `<span class="muted mono">AI予測 1週${signedPct(m.p5)}${m.p20 != null ? `・1か月${signedPct(m.p20)}` : ''}</span>` : ''}</div>`;
};
function renderMemos(s) {
  $('#d-memos').innerHTML = memosOf(s).slice().reverse().map((m) => `<li>${memoLine(s, m)}<p>${esc(m.text)}</p><button class="mini ghost" data-del-memo="${esc(m.id)}">削除</button></li>`).join('')
    || '<li class="muted small">買った理由・売る条件を書いておくと、あとで振り返れます。</li>';
}
function renderAllMemos() {
  const all = Object.entries(state.settings.memos || {}).flatMap(([s, ms]) => ms.map((m) => ({ s, m }))).sort((a, b) => (b.m.ts || 0) - (a.m.ts || 0));
  $('#memo-all-sec').hidden = !all.length;
  $('#memo-all').innerHTML = `<ul class="memos">${all.slice(0, 30).map(({ s, m }) => `<li data-scr="${esc(s)}"><b>${esc(nameOf(s))}</b> <small class="muted mono">${esc(s)}</small>${memoLine(s, m)}<p>${esc(m.text)}</p></li>`).join('')}</ul>`;
}

// ---------- 証券会社CSVの取り込み ----------
async function importCsv(file) {
  try {
    const { holdings, skipped } = extractHoldings(parseCsvText(decodeCsv(await file.arrayBuffer())));
    if (!holdings.length) { toast('CSVから株式の保有が見つかりませんでした（SBI証券は「ポートフォリオ」→「CSVダウンロード」のファイルを選んでください）', 'err'); return; }
    const list = holdings.map((h) => `${h.sym} ${h.name || nameOf(h.sym)}：${h.shares.toLocaleString()}株 @${fmt(h.cost)}${h.accounts?.length > 1 ? '（口座合算）' : ''}`).join('\n');
    const replace = confirm(`${holdings.length}銘柄が見つかりました。\n\n${list}\n\n「OK」で今の保有株と入れ替え、「キャンセル」で追加（同じ銘柄は上書き）します。`);
    const prev = replace ? [] : state.settings.holdings.filter((h) => !holdings.some((x) => x.sym === h.sym));
    const manual = Object.fromEntries(state.settings.holdings.map((h) => [h.sym, h.manualPrice]));
    state.settings.holdings = [...prev, ...holdings.map((h, i) => ({ id: `${Date.now().toString(36)}${i}`, sym: h.sym, name: h.name || undefined, shares: h.shares, cost: h.cost, date: todayJst(), manualPrice: manual[h.sym] }))];
    store.save(state.settings);
    loadCandles(state.settings.holdings.map((h) => h.sym).filter((s) => !state.candles[s])).then(tick);
    render();
    toast(`${holdings.length}銘柄を取り込みました${skipped ? `（${skipped}行は読み取れませんでした）` : ''}`);
  } catch (e) {
    toast(`CSVを読み込めませんでした: ${e.message}`, 'err');
  }
}

// 保有株の警告は1日1回だけ通知
function checkHoldings() {
  const day = todayJst();
  const sent = store.get('kr:holdNotified') || {};
  if (sent.day !== day) { sent.day = day; sent.keys = []; }
  for (const h of state.settings.holdings.map(holdingView)) {
    for (const w of h.warns.filter((x) => x.hot)) {
      const key = `${h.sym}:${w.text}`;
      if (sent.keys.includes(key) || sent.keys.some((k) => k.startsWith(`${h.sym}:AI売り候補`) && key.startsWith(`${h.sym}:AI売り候補`))) continue;
      sent.keys.push(key);
      notify(`保有株: ${nameOf(h.sym)}`, w.text);
    }
  }
  store.set('kr:holdNotified', sent);
}

// ---------- 答え合わせ ----------
function aiTrackSection() {
  const t = state.server.ai_track;
  if (!t?.days?.length) return '<h3>AI予測の答え合わせ（本番）</h3><p class="muted small">毎日のAI予測を記録しています。5営業日たつと、ここに実際の成績が出ます。</p>';
  const T = t.total;
  return `<h3>AI予測の答え合わせ（本番の記録）</h3>
    <p class="muted small">実際に公開したAI予測の上位${Math.round(t.topPct * 100)}%（売買代金1億円以上）を、${t.horizon}営業日後の値動きで採点しています。学習時の検証ではなく、本番の成績です。</p>
    <div class="kpis">
      <div><small>上位${Math.round(t.topPct * 100)}%の市場平均との差</small><b class="${sign(T.topExcess)}">${T.days ? pctf(T.topExcess, 2) : '集計中'}</b><small>${T.days}日分・${T.topN}銘柄・勝率${T.topWin != null ? Math.round(T.topWin * 100) + '%' : '—'}</small></div>
      <div><small>下位${Math.round(t.topPct * 100)}%</small><b class="${sign(T.bottomExcess)}">${T.days ? pctf(T.bottomExcess, 2) : '—'}</b></div>
      <div><small>予測と結果の相関（IC）</small><b>${T.ic != null ? T.ic.toFixed(3) : '—'}</b><small>${T.icPositive != null ? `プラスの日 ${Math.round(T.icPositive * 100)}%` : ''}</small></div>
    </div>
    ${t.days.slice(0, 20).map((d) => `<details class="week">
      <summary><b>${+d.date.slice(5, 7)}/${+d.date.slice(8, 10)}の予測</b>
        ${d.top ? `<span class="mono ${sign(d.top.excess)}">${pctf(d.top.excess, 2)}</span><span class="muted">${d.done ? `勝率${Math.round(d.top.win * 100)}%・IC ${d.ic != null ? d.ic.toFixed(2) : '—'}` : `途中経過 ${d.elapsed}日目`}</span>` : '<span class="muted">結果待ち</span>'}</summary>
      ${d.picks?.length ? `<div class="table-wrap"><table><thead><tr><th>銘柄</th><th class="num">予測</th><th class="num">実際</th><th class="num">市場差</th></tr></thead><tbody>
        ${d.picks.map((p) => `<tr data-scr="${esc(p.sym)}"><td><div class="sym">${esc(p.sym)}</div><div class="nm">${esc(p.name)}</div></td>
          <td class="num mono">${p.pred > 0 ? '+' : ''}${p.pred.toFixed(2)}%</td><td class="num mono ${sign(p.ret)}">${pctf(p.ret)}</td><td class="num mono ${sign(p.ex)}">${pctf(p.ex)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}</details>`).join('')}
    <h3>シグナル点数「強い買い」の答え合わせ</h3>`;
}

function renderReview() {
  const rv = state.server.review || state.local.review;
  if (!rv) { $('#review-body').innerHTML = '<p class="muted">計算中…</p>'; return; }
  const box = (st, label) => `<div><small>${label}</small><b class="${sign(st.avg)}">${pctf(st.avg, 2)}</b><small>勝率${st.win != null ? Math.round(st.win * 100) + '%' : '—'}・指数に勝った${st.beat != null ? Math.round(st.beat * 100) + '%' : '—'}</small></div>`;
  $('#review-body').innerHTML = `${state.server.model ? aiTrackSection() : ''}
    <p class="muted small">各営業日に「強い買いシグナル」（${rv.threshold}点以上）だった銘柄を、その後${rv.horizon}営業日の値動きで採点しています。${state.server.review ? '比較対象はTOPIX（連動ETF）。売買代金1億円未満の銘柄は除外。' : 'デモデータです。'}</p>
    <div class="kpis">
      <div><small>直近8週の件数</small><b>${rv.total.n}</b><small>結果確定 ${rv.total.done}件</small></div>
      ${box(rv.total, '平均リターン（5日後）')}
      <div><small>指数との差（平均）</small><b class="${sign(rv.total.avgExcess)}">${pctf(rv.total.avgExcess, 2)}</b></div>
    </div>
    ${rv.weeks.map((w) => `<details class="week" ${w === rv.weeks[0] ? 'open' : ''}>
      <summary><b>${+w.week.slice(5, 7)}/${+w.week.slice(8, 10)}の週</b><span>${w.n}件</span>
        <span class="${sign(w.avg)} mono">${w.done ? pctf(w.avg, 2) : '集計中'}</span>
        <span class="muted">${w.win != null ? `勝率${Math.round(w.win * 100)}%` : ''}</span></summary>
      <div class="table-wrap"><table><thead><tr><th>日付</th><th>銘柄</th><th class="num">点</th><th class="num">5日後</th><th class="num hide-sm">指数</th></tr></thead><tbody>
      ${w.picks.map((p) => `<tr data-scr="${esc(p.sym)}"><td class="small mono">${p.date.slice(5)}</td><td><div class="sym">${esc(p.sym)}</div><div class="nm">${esc(p.name)}</div></td>
        <td class="num mono">${p.score}</td>
        <td class="num mono ${p.days ? sign(p.ret) : ''}">${p.days ? pctf(p.ret) : '—'}${p.done ? '' : `<div class="small muted">${p.days ? `${p.days}日目` : '結果待ち'}</div>`}</td>
        <td class="num mono hide-sm ${sign(p.idxRet)}">${pctf(p.idxRet)}</td></tr>`).join('')}
      </tbody></table></div></details>`).join('') || '<p class="muted">直近に「強い買い」はありませんでした。</p>'}`;
}

// ---------- バックテスト ----------
const FEATURE_JA = {
  ret1: '前日比', ret5: '5日の値動き', ret20: '20日の値動き', ret60: '60日の値動き', dev5: '5日線との乖離', dev25: '25日線との乖離',
  dev75: '75日線との乖離', slope75: '75日線の傾き', rsi2: 'RSI(2)', rsi14: 'RSI(14)', bbz: 'ボリンジャー内の位置', volr: '出来高の増え方',
  lturn: '売買代金', atrp: '1日の値幅', vol20: '値動きの荒さ', pos60: '60日の高安内の位置', dist250: '52週高値からの距離', gap: '窓（寄り付きの跳び）',
  body: 'ローソク足の実体', lshadow: '下ヒゲ', updays5: '直近5日の上昇日数', lprice: '株価の水準', seg: '市場区分', sector: '業種',
  n225_ret5: '日経平均の5日の値動き', n225_dev25: '日経平均の25日線乖離', vix: 'VIX（米国の不安指数）',
};

// 判断理由の値を、人が読める形にする（モデルの入力は対数や比率なので変換する）
function reasonValue(k, v) {
  if (v == null) return '';
  const rd = state.server.ai_reasons;
  const p = (x, d = 1) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
  switch (k) {
    case 'ret1': case 'ret5': case 'ret20': case 'ret60': return p(Math.exp(v) - 1);
    case 'dev5': case 'dev25': case 'dev75': case 'slope75': case 'gap': case 'dist250': return p(v);
    case 'rsi2': case 'rsi14': return v.toFixed(0);
    case 'bbz': return `${v > 0 ? '+' : ''}${v.toFixed(1)}σ`;
    case 'volr': return `${Math.exp(v).toFixed(1)}倍`;
    case 'lturn': { const yen = 10 ** v; return yen >= 1e10 ? `${(yen / 1e8).toFixed(0)}億円` : `${(yen / 1e8).toFixed(1)}億円`; }
    case 'atrp': case 'vol20': return `${(v * 100).toFixed(1)}%`;
    case 'pos60': return `${Math.round(v * 100)}%の位置`;
    case 'body': case 'lshadow': return `${Math.round(v * 100)}%`;
    case 'updays5': return `${v.toFixed(0)}日`;
    case 'lprice': return `${Math.round(10 ** v).toLocaleString()}円`;
    case 'seg': return ['プライム', 'スタンダード', 'グロース', 'その他'][v] || '';
    case 'sector': return rd?.sectors?.[v] || '';
    default: return String(Math.round(v * 100) / 100);
  }
}

function reasonsHtml(s) {
  const rs = state.server.ai_reasons?.reasons?.[s];
  if (!rs?.length) return '';
  return `<div class="reasons"><small class="muted">AIの判断理由（予測を押し上げ／押し下げた要因）</small>
    ${rs.map(([k, c, v]) => `<div class="rs ${c >= 0 ? 'pos' : 'neg'}"><b class="mono">${c >= 0 ? '+' : ''}${c.toFixed(2)}%</b><span>${esc(FEATURE_JA[k] || k)}${reasonValue(k, v) ? `：${esc(reasonValue(k, v))}` : ''}</span></div>`).join('')}</div>`;
}

function aiModelSection(m = state.server.model, days = 5) {
  const r = m?.report;
  const hname = days === 20 ? '1か月先（20営業日）' : '1週間先（5営業日）';
  if (!r) return days === 20 ? '' : '<p class="muted small">AI予測モデルの検証結果は、毎朝の学習後に表示されます。</p>';
  const maxAbs = Math.max(...r.deciles.map((d) => Math.abs(d.excess)), 1e-6);
  const strong = state.server.backtest?.walkForward?.base;
  return `
    <h3>AI予測モデル（${hname}）の成績 <small class="muted">学習に使っていない期間 ${esc(r.from)}〜${esc(r.to)}</small></h3>
    <p class="muted small">毎朝、約3年分・全銘柄のデータで「${days}営業日後に市場平均をどれだけ上回るか」を学習。検証では20営業日ごとに、その時点で分かっていたデータだけで学び直して次の期間を予測しています。最新の学習：${esc(m.model?.trainedAt?.slice(0, 16).replace('T', ' ') || '—')}（${(m.model?.rows || 0).toLocaleString()}件）</p>
    <div class="kpis">
      <div><small>予測上位2%（市場平均との差）</small><b class="${sign(r.top2pct.excess)}">${pctf(r.top2pct.excess, 2)}</b><small>${r.top2pct.n.toLocaleString()}回・勝率${Math.round(r.top2pct.win * 100)}%</small></div>
      <div><small>毎日の上位10銘柄</small><b class="${sign(r.top[0].excess)}">${pctf(r.top[0].excess, 2)}</b><small>勝率${Math.round(r.top[0].win * 100)}%・平均${pctf(r.top[0].avg, 2)}</small></div>
      <div><small>予測下位2%</small><b class="${sign(r.bottom2pct.excess)}">${pctf(r.bottom2pct.excess, 2)}</b><small>${r.bottom2pct.n.toLocaleString()}回</small></div>
      <div><small>予測と結果の相関（IC）</small><b>${r.ic.toFixed(3)}</b><small>プラスの日 ${Math.round(r.icPositiveDays * 100)}%</small></div>
      ${days === 5 && strong?.n ? `<div><small>参考：シグナル点数30以上</small><b class="${sign(strong.excess)}">${pctf(strong.excess, 2)}</b><small>${strong.n.toLocaleString()}回・勝率${Math.round(strong.win * 100)}%</small></div>` : ''}
    </div>
    <h3>予測の強さ別（10段階）の実際の成績</h3>
    ${r.deciles.slice().reverse().map((d) => `<div class="decile"><span>${d.decile === 10 ? '最上位' : d.decile === 1 ? '最下位' : `第${d.decile}段階`}</span>
      <div class="bar"><i class="${d.excess >= 0 ? 'pos' : 'neg'}" style="width:${(Math.abs(d.excess) / maxAbs) * 50}%"></i></div>
      <span class="mono ${sign(d.excess)}">${pctf(d.excess, 2)}</span></div>`).join('')}
    <p class="muted small">上の段階ほど成績が良く、下ほど悪ければ、モデルが銘柄の良し悪しを見分けられています。</p>
    ${m.model?.importance ? `<h3>予測でよく使われている情報</h3><div class="imp">${m.model.importance.slice(0, 10).map(([k, v]) => `<span>${esc(FEATURE_JA[k] || k)} ${Math.round(v * 100)}%</span>`).join('')}</div>` : ''}`;
}

function renderBacktest() {
  const bt = universeStats();
  if (!bt) { $('#bt-body').innerHTML = '<p class="muted">計算中…</p>'; return; }
  const srv = state.server.backtest;
  const tuned = srv?.tuned || state.local.tuned || BASE_WEIGHTS;
  const strat = (srv || state.local).strategy || {};
  const wf = srv?.walkForward;
  const src = srv ? `東証${srv.symbols?.toLocaleString() ?? ''}銘柄・直近${srv.days ?? ''}営業日（売買代金1億円以上の日のみ）` : 'デモ銘柄（シミュレーション価格）';
  const exc = (st) => (st?.excess != null ? `<b class="${sign(st.excess)}">${pctf(st.excess, 2)}</b>` : '<b>—</b>');
  const kpi = (label, st) => `<div><small>${label}</small>${exc(st)}<small>${st?.n ? `${st.n.toLocaleString()}回・勝率${Math.round(st.win * 100)}%・平均${pctf(st.avg, 2)}` : 'なし'}</small></div>`;
  const cell = (st) => (st?.n ? `<td class="num mono">${st.n.toLocaleString()}</td><td class="num mono">${Math.round(st.win * 100)}%</td><td class="num mono ${sign(st.excess ?? st.avg)}">${pctf(st.excess ?? st.avg, 2)}</td>` : '<td class="num muted">0</td><td></td><td></td>');
  $('#bt-body').innerHTML = `${aiModelSection()}${aiModelSection(state.server.model20, 20)}
    <h3>シグナル点数方式の成績</h3>
    <p class="muted small">対象: ${src}。シグナルが出た日の終値で買い、5営業日後の終値と比べています。大きな数字は<b>市場平均との差</b>（同じ日の全銘柄の平均を引いた値）で、銘柄選びの腕前を表します。</p>
    <div class="kpis">
      ${kpi('「強い買い」の日（市場平均との差）', bt.byVerdict.strong)}
      ${kpi('「注目」の日', bt.byVerdict.watch)}
      <div><small>全銘柄・全日の平均</small><b class="${sign(bt.baseline.avg)}">${pctf(bt.baseline.avg, 2)}</b><small>勝率${Math.round((bt.baseline.win || 0) * 100)}%</small></div>
    </div>
    ${wf?.base?.n != null ? `<h3>学習に使っていない期間での成績（${esc(wf.testFrom || '')}〜）</h3>
    <p class="muted small">毎週、直近${wf.window}営業日の成績だけで配点を学び直し、その後の1週間に当てはめた結果です。本番に近い成績の目安になります。</p>
    <div class="kpis">${kpi('標準配点', wf.base)}${kpi('毎週学び直す配点（自動チューニング）', wf.tuned)}</div>` : ''}
    ${bt.byRegime?.good?.n || bt.byRegime?.bad?.n ? `<div class="kpis">
      <div><small>地合い良好の日の「強い買い」</small><b class="${sign(bt.byRegime.good.avg)}">${pctf(bt.byRegime.good.avg, 2)}</b><small>${bt.byRegime.good.n}回・勝率${bt.byRegime.good.n ? Math.round(bt.byRegime.good.win * 100) : '—'}%</small></div>
      <div><small>地合い悪化の日の「強い買い」</small><b class="${sign(bt.byRegime.bad.avg)}">${pctf(bt.byRegime.bad.avg, 2)}</b><small>${bt.byRegime.bad.n}回・勝率${bt.byRegime.bad.n ? Math.round(bt.byRegime.bad.win * 100) : '—'}%</small></div>
    </div>` : ''}
    <h3>シグナル別</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>シグナル</th><th class="num">標準</th><th class="num">学習後</th><th class="num">回数</th><th class="num">勝率</th><th class="num">市場差</th></tr></thead>
      <tbody>${SIGNALS.map((s) => `<tr><td>${esc(s.label)}<div class="nm">${esc(s.desc || '')}</div></td><td class="num mono">${s.base}</td><td class="num mono ${tuned[s.id] !== s.base ? 'chg' : ''}">${tuned[s.id]}</td>${cell(bt.stats[s.id])}</tr>`).join('')}</tbody>
    </table></div>
    <h3>売買ルールで回した場合（スコア${DEFAULT_RULES.entry}以上で買い／+10%利確・−5%損切り・最長10日）</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>配点</th><th class="num">取引</th><th class="num">勝率</th><th class="num">平均</th><th class="num">合計損益</th></tr></thead>
      <tbody>${[['標準配点', strat.base], ['標準＋地合いフィルター', strat.filtered], ['毎週学び直す配点', strat.tuned]].map(([l, st]) => st ? `<tr><td>${l}</td><td class="num mono">${st.trades.toLocaleString()}</td><td class="num mono">${st.win != null ? Math.round(st.win * 100) + '%' : '—'}</td><td class="num mono ${sign(st.avg)}">${pctf(st.avg, 2)}</td><td class="num mono ${sign(st.pnl)}">${yen(st.pnl)}</td></tr>` : '').join('')}</tbody>
    </table></div>
    <p class="muted small">地合いフィルターは、相場が悪い日の押し目のほうが反発しやすく成績が良かったため、標準ではオフにしています（設定でオンにできます）。</p>
    <p class="muted small">※ 1回¥100,000で売買した場合の合計。手数料・税金は含みません。過去の成績は将来を保証しません。</p>`;
}

// ================= 操作 =================
// 銘柄ごとの全部の開示（IR）。無ければ重要な開示だけ表示
async function loadIr(s) {
  state.irCache = state.irCache || {};
  state.irCache[s] = null;
  try {
    const d = await state.provider.json(`tdnet_all/${encodeURIComponent(s)}.json`);
    state.irCache[s] = d.items || [];
  } catch { state.irCache[s] = disclosuresOf(s); }
  if (state.selected === s) renderDetail();
}

function select(s) {
  state.selected = s;
  document.body.classList.add('sheet-open');
  render();
  $('#detail').scrollTop = 0;
}
function closeDetail() {
  state.selected = null;
  document.body.classList.remove('sheet-open');
  render();
}

async function openSymbol(s) {
  select(s);
  if (!state.candles[s]) { await loadCandles([s]); await tick(); }
}

function repoName() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return m && repo ? `${m[1]}/${repo}` : DEFAULT_REPO;
}

// 自動取得の対象（config/universe.json）の追加・削除を GitHub の Issue で依頼する。数分で自動反映
function requestUniverse(s, action = '追加') {
  const title = `${action}: ${s}`;
  const body = action === '追加'
    ? '名前: \n\n（↑日本語名などを入れたい場合だけ記入。空欄なら Yahoo Finance の名前を使います）\n\nこの Issue は自動で処理されます。そのまま「Submit new issue」を押してください。'
    : 'この Issue は自動で処理されます。そのまま「Submit new issue」を押してください。';
  window.open(`https://github.com/${repoName()}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`, '_blank', 'noopener');
}

// 入力がコードでなければ銘柄名から探す
function resolveSymbol(input) {
  const t = input.trim();
  if (!t) return '';
  const code = t.toUpperCase().replace(/\.T$/, '');
  if (/^[0-9][0-9A-Z]{3}$/.test(code)) return code;
  if (state.universe) {
    const q = t.toLowerCase();
    const hit = [...state.universe.values()].find((u) => u.name.toLowerCase() === q) || [...state.universe.values()].find((u) => u.name.toLowerCase().includes(q));
    if (hit) return hit.sym;
  }
  return code;
}

function addSymbol(s) {
  s = resolveSymbol(s);
  if (!s) return;
  if (state.provider?.static && state.universe && !inUniverse(s)) {
    if (confirm(`${s} はまだ自動取得の対象外です。\nGitHub で追加をリクエストしますか？（送信すると数分でデータが届きます）`)) requestUniverse(s);
  }
  if (!state.settings.watchlist.includes(s)) {
    state.settings.watchlist.push(s);
    store.save(state.settings);
    loadCandles([s]).then(tick);
    toast(`${s} を監視リストに追加しました`);
  }
}

document.addEventListener('click', (e) => {
  const t = e.target;
  const add = t.closest('[data-add]');
  if (add) { addSymbol(add.dataset.add); render(); return; }
  const go = t.closest('[data-goto]');
  if (go) { e.preventDefault(); state.settings.tab = go.dataset.goto; store.save(state.settings); render(); return; }
  const tab = t.closest('.tab');
  if (tab) { state.settings.tab = tab.dataset.tab; store.save(state.settings); render(); window.scrollTo({ top: 0 }); return; }
  const scr = t.closest('[data-scr]');
  if (scr) { openSymbol(scr.dataset.scr); return; }
  const row = t.closest('[data-sym]');
  if (row) select(row.dataset.sym);
});

$('#add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  addSymbol($('#add-sym').value);
  $('#add-sym').value = '';
});
$('#scr-seg').addEventListener('change', (e) => { state.scr.seg = e.target.value; state.scr.limit = 100; renderScreener(); });
$('#scr-sector').addEventListener('change', (e) => { state.scr.sector = e.target.value; state.scr.limit = 100; renderScreener(); });
$('#scr-liquid').addEventListener('change', (e) => { state.scr.liquid = e.target.checked; renderScreener(); });
$('#scr-more').addEventListener('click', () => { state.scr.limit += 100; renderScreener(); });
$('#scr-min').addEventListener('change', (e) => { state.scr.min = +e.target.value; renderScreener(); });
$('#scr-q').addEventListener('input', (e) => { state.scr.q = e.target.value; renderScreener(); });

$('#d-remove').addEventListener('click', () => {
  const s = state.selected;
  if (!state.settings.watchlist.includes(s)) { addSymbol(s); render(); return; }
  state.settings.watchlist = state.settings.watchlist.filter((x) => x !== s);
  delete state.settings.alerts[s];
  store.save(state.settings);
  closeDetail();
});
$('#d-universe').addEventListener('click', () => {
  const s = state.selected;
  if (inUniverse(s)) { if (confirm(`${s} を自動取得の対象から外しますか？`)) requestUniverse(s, '削除'); }
  else requestUniverse(s);
});
$('#d-hold').addEventListener('click', () => {
  state.settings.tab = 'holdings';
  render();
  $('#h-sym').value = state.selected;
  $('#h-cost').value = state.quotes[state.selected]?.price?.toFixed(2) ?? '';
  $('#h-shares').focus();
});
$('#hold-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const sym = $('#h-sym').value.trim().toUpperCase();
  const shares = +$('#h-shares').value, cost = +$('#h-cost').value;
  if (!sym || !(shares > 0) || !(cost > 0)) { toast('コード・株数・買値を入れてください', 'err'); return; }
  state.settings.holdings.push({ id: Date.now().toString(36), sym, shares, cost, date: todayJst() });
  store.save(state.settings);
  e.target.reset();
  if (!state.candles[sym]) loadCandles([sym]).then(tick); else render();
  toast(`${sym} を保有株に登録しました`);
});
document.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del-hold]');
  if (!del) return;
  e.stopPropagation();
  if (!confirm('この保有株を削除しますか？')) return;
  state.settings.holdings = state.settings.holdings.filter((h) => h.id !== del.dataset.delHold);
  store.save(state.settings);
  render();
}, true);
$('#csv-btn').addEventListener('click', () => $('#csv-file').click());
$('#csv-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importCsv(f); e.target.value = ''; });
document.addEventListener('change', (e) => {
  const inp = e.target.closest('[data-mprice]');
  if (!inp) return;
  const h = state.settings.holdings.find((x) => x.id === inp.dataset.mprice);
  if (!h) return;
  h.manualPrice = parseFloat(inp.value) || null;
  store.save(state.settings);
  render();
});
document.addEventListener('click', (e) => { if (e.target.closest('[data-mprice]')) e.stopPropagation(); }, true);
$('#scr-funda').addEventListener('change', (e) => { state.scr.funda = e.target.value; renderScreener(); });
$('#d-close').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected) closeDetail(); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-perf]');
  if (!b) return;
  state.settings.perfTab = b.dataset.perf;
  save();
  render();
});
$('#d-ai-btn').addEventListener('click', askAi);
$('#memo-save').addEventListener('click', () => {
  const s = state.selected, text = $('#memo-text').value.trim();
  if (!s || !text) return;
  const r = rowOf(s);
  const price = state.quotes[s]?.price ?? state.candles[s]?.at(-1)?.close ?? r?.price ?? null;
  const memos = state.settings.memos || (state.settings.memos = {});
  (memos[s] = memos[s] || []).push({ id: Date.now().toString(36), ts: Date.now(), date: todayJst(), text, price, p5: r?.pred ?? null, p20: r?.pred20 ?? null });
  save();
  $('#memo-text').value = '';
  renderMemos(s);
  toast('メモを保存しました');
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-del-memo]');
  if (!b || !state.selected) return;
  const ms = state.settings.memos?.[state.selected] || [];
  state.settings.memos[state.selected] = ms.filter((m) => m.id !== b.dataset.delMemo);
  if (!state.settings.memos[state.selected].length) delete state.settings.memos[state.selected];
  save();
  renderMemos(state.selected);
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-h]');
  if (!b) return;
  state.settings.horizon = Number(b.dataset.h);
  save();
  recomputeAll();
  render();
});
$('#d-ai-chat').addEventListener('click', askInClaudeApp);
$('#al-save').addEventListener('click', () => {
  const s = state.selected;
  const above = parseFloat($('#al-above').value), below = parseFloat($('#al-below').value);
  state.settings.alerts[s] = { above: isNaN(above) ? null : above, below: isNaN(below) ? null : below };
  store.save(state.settings);
  toast(`${s} のアラートを保存しました`);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
});

// ---------- 設定 ----------
const dlg = $('#settings');
function renderWeightInputs() {
  const mode = $('#s-wmode').value;
  const cur = mode === 'tuned' ? tunedWeights() : mode === 'custom' ? { ...BASE_WEIGHTS, ...state.settings.custom } : BASE_WEIGHTS;
  $('#s-weights').innerHTML = SIGNALS.map((s) => `<label class="wrow"><span>${esc(s.label)}</span>
    <input type="number" data-w="${s.id}" value="${cur[s.id]}" step="1" min="-50" max="50" ${mode === 'custom' ? '' : 'disabled'} /></label>`).join('');
}
function openSettings() {
  const st = state.settings;
  $('#s-provider').value = st.provider;
  $('#s-up').value = st.upColor;
  $('#s-wmode').value = st.weightMode;
  $('#s-method').value = st.method || 'auto';
  $('#s-style').innerHTML = Object.entries(STYLES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  $('#s-style').value = st.style;
  $('#s-aimodel').innerHTML = AI_MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
  $('#s-aimodel').value = st.aiModel;
  $('#s-aikey').value = st.aiKey;
  $('#s-mfilter').checked = st.marketFilter;
  renderWeightInputs();
  dlg.showModal();
}
$('#open-settings').addEventListener('click', openSettings);
$('#s-wmode').addEventListener('change', renderWeightInputs);
$('#s-save').addEventListener('click', (e) => {
  e.preventDefault();
  const st = state.settings;
  const before = st.provider;
  const custom = {};
  document.querySelectorAll('[data-w]').forEach((i) => (custom[i.dataset.w] = Math.round(+i.value || 0)));
  Object.assign(st, {
    provider: $('#s-provider').value,
    upColor: $('#s-up').value,
    weightMode: $('#s-wmode').value,
    method: $('#s-method').value,
    style: $('#s-style').value,
    aiKey: $('#s-aikey').value.trim(),
    aiModel: $('#s-aimodel').value,
    marketFilter: $('#s-mfilter').checked,
  });
  if (st.weightMode === 'custom') st.custom = custom;
  store.save(st);
  dlg.close();
  document.documentElement.dataset.up = st.upColor;
  if (st.provider !== before) restart();
  else { recomputeAll(); render(); }
});
$('#s-cancel').addEventListener('click', (e) => { e.preventDefault(); dlg.close(); });
$('#s-notify').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!('Notification' in window)) return toast('このブラウザは通知に対応していません。ホーム画面に追加すると使える場合があります', 'err');
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? '通知を有効にしました' : '通知は許可されませんでした');
});

window.addEventListener('resize', () => state.selected && state.settings.tab === 'watch' && renderDetail());
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

// PWA
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

restart();
