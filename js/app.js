import { makeProvider, DemoProvider, DEMO_SYMBOLS } from './providers.js';
import { analyze, scoreOf, verdictOf, SIGNALS, SIGNAL_MAP, BASE_WEIGHTS, STYLES, applyStyle } from './signals.js';
import { signalStats, tuneWeights, simulate, tradeSummary, DEFAULT_RULES } from './backtest.js';
import { explain, chatPrompt, AI_MODELS, AI_MODEL_DEFAULT } from './ai.js';
import { ruleExplain } from './explain.js';
import { drawChart, sparkline, fmt } from './chart.js';
import { levels, holdingLevels } from './levels.js';
import { marketOf } from './market.js';
import { computeReview } from './review.js';

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
  v: 3,
};
const store = {
  load() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('kr:settings') || '{}') }; } catch { return { ...DEFAULTS }; }
  },
  save(s) { try { localStorage.setItem('kr:settings', JSON.stringify(s)); } catch {} },
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

function migrate(st) {
  if ((st.v || 0) < 3) { st.marketFilter = false; st.v = 3; }
  return st;
}

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
  scr: { seg: 'all', sector: 'all', min: 20, q: '', funda: 'all', liquid: true, limit: 100 },
  universe: null,    // 自動取得の対象銘柄（config/universe.json）
};

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
const nameOf = (s) => state.universe?.get(s)?.name || state.quotes[s]?.name || s;

async function loadServer() {
  if (!state.provider.static) { state.server = {}; return; }
  const files = ['screener', 'backtest', 'paper', 'news', 'ai', 'meta', 'market', 'review'];
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
      toast(`${s}: ${e.message}`, 'err');
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
  if (q.date && q.date > lastC.date) return true; // 新しい日足 → 取り直し
  if (Math.abs(lastC.close - q.price) > 1e-9) {
    lastC.close = q.price;
    lastC.high = Math.max(lastC.high, q.price);
    lastC.low = Math.min(lastC.low, q.price);
    if (q.volume) lastC.volume = q.volume;
  }
  return false;
}

function recompute(s) {
  const a = withRegime(analyze(state.candles[s], W()), s);
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
    checkHoldings();
    if (refetch.length) loadCandles(refetch);
    const at = state.provider.quotesDoc?.updatedAt ? new Date(state.provider.quotesDoc.updatedAt) : new Date();
    $('#updated').textContent = at.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    $('#status').className = 'dot live';
  } catch (e) {
    $('#status').className = 'dot err';
    toast(`価格の取得に失敗: ${e.message}`, 'err');
  } finally {
    state.busy = false;
  }
  render();
}

async function restart() {
  clearInterval(state.timer);
  state.provider = await makeProvider(state.settings);
  Object.assign(state, { candles: {}, quotes: {}, analyses: {}, prevVerdict: {}, symStats: {}, server: {}, local: {} });
  $('#provider').textContent = state.provider.name;
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
const eventChips = (s) => eventBadges(s).map((b) => `<span class="ev ${b.days <= 3 ? 'hot' : ''}">${b.kind === 'earn' ? '📅' : '💰'} ${esc(b.text)}</span>`).join('');

function render() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === state.settings.tab));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${state.settings.tab}`));
  const mode = state.settings.weightMode === 'base' ? '' : state.settings.weightMode === 'tuned' ? '自動調整' : 'カスタム';
  const style = state.settings.style !== 'balanced' ? STYLES[state.settings.style].label.replace(/（.*/, '') : '';
  $('#wmode').textContent = [mode, style].filter(Boolean).join('・');
  ({ watch: renderWatch, screener: renderScreener, holdings: renderHoldings, paper: renderPaper, review: renderReview, backtest: renderBacktest })[state.settings.tab]();
}

function renderRegime() {
  const m = state.server.market;
  if (!m) { $('#regime').innerHTML = ''; return; }
  const idx = m.indices || {};
  const chip = (k, label) => idx[k] ? `<span class="idx"><small>${label}</small><b class="mono">${fmt(idx[k].price)}</b><i class="${sign(idx[k].changePct)} mono">${pct(idx[k].changePct)}</i></span>` : '';
  const reg = (mkt, label) => {
    const r = m.regime?.[mkt];
    if (!r) return '';
    return `<div class="reg ${r.state.key}"><b>${label}：${r.state.label}</b>${r.penalty && state.settings.marketFilter ? `<span>買いシグナルを −${r.penalty}点</span>` : ''}${r.notes.length ? `<small>${r.notes.map(esc).join('・')}</small>` : ''}</div>`;
  };
  $('#regime').innerHTML = `<div class="idxs">${chip('N225', '日経平均')}${chip('TOPIX', 'TOPIX(ETF)')}${chip('SPX', 'S&P500')}${chip('USDJPY', 'ドル円')}</div>
    <div class="regs one">${reg('JP', '地合い')}</div>
    <small class="muted">${state.settings.marketFilter ? '地合いフィルター：オン（悪い日は買いシグナルを割り引き）' : '地合いは参考表示です（割り引きはオフ。相場が悪い日の押し目はむしろ反発しやすいため）'}</small>`;
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
  renderPicks();
  renderTable();
  renderDetail();
}

function renderPicks() {
  const ranked = state.settings.watchlist
    .filter((s) => state.analyses[s])
    .map((s) => ({ s, a: state.analyses[s] }))
    .filter(({ a }) => a.score >= 20)
    .sort((x, y) => y.a.score - x.a.score)
    .slice(0, 4);
  $('#picks').innerHTML = ranked.length
    ? ranked.map(({ s, a }) => {
        const q = state.quotes[s];
        return `<button class="pick ${a.verdict.key}" data-sym="${esc(s)}">
          <div class="pick-head"><span class="sym">${esc(s)}</span><span class="badge ${a.verdict.key}">${a.verdict.label}</span></div>
          <div class="pick-name">${esc(nameOf(s))}</div>
          <div class="pick-price mono">${fmt(q?.price)} <span class="${sign(q?.changePct)}">${pct(q?.changePct)}</span></div>
          <div class="evs">${eventChips(s)}</div>
          ${levelLine(s, true)}
          <div class="pick-score"><span class="mono">${a.score}</span><small>/100</small></div>
          <ul>${a.signals.filter((x) => x.weight > 0).slice(0, 3).map((x) => `<li>${esc(x.label)}</li>`).join('')}</ul>
        </button>`;
      }).join('')
    : `<p class="empty">ウォッチリストに条件を満たす銘柄はありません。<a href="#" data-goto="screener">スクリーナー</a>で全銘柄から探せます。</p>`;
}

function meter(sc) {
  return `<div class="meter"><i style="--v:${(sc + 100) / 2}%" class="${sc >= 0 ? 'pos' : 'neg'}"></i></div><span class="mono sc">${sc}</span>`;
}

function renderTable() {
  $('#rows').innerHTML = state.settings.watchlist.map((s) => {
    const q = state.quotes[s], a = state.analyses[s], cs = state.candles[s];
    const spark = cs?.length ? sparkline(cs.slice(-30).map((c) => c.close)) : '';
    const flash = q?.flash > 0 ? 'flash-up' : q?.flash < 0 ? 'flash-down' : '';
    const failed = cs && !cs.length;
    return `<tr data-sym="${esc(s)}" class="${state.selected === s ? 'sel' : ''}">
      <td><div class="sym">${esc(s)}</div><div class="nm">${esc(nameOf(s))}</div><div class="evs">${eventChips(s)}</div></td>
      <td class="mono num ${flash}">${fmt(q?.price)}</td>
      <td class="mono num ${sign(q?.changePct)}">${pct(q?.changePct)}</td>
      <td class="hide-sm">${spark}</td>
      <td>${a && !failed ? meter(a.score) + `<div class="show-sm"><span class="badge ${a.verdict.key}">${a.verdict.label}</span></div>` : ''}</td>
      <td class="hide-sm">${failed ? '<span class="muted">取得不可</span>' : a ? `<span class="badge ${a.verdict.key}">${a.verdict.label}</span>` : '<span class="muted">読込中</span>'}</td>
    </tr>`;
  }).join('');
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
  $('#d-score').innerHTML = a ? `総合スコア <b class="mono">${a.score}</b> ・ <span class="badge ${a.verdict.key}">${a.verdict.label}</span>`
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
    text = ruleExplain({ score: a.score, verdict: a.verdict.label, signals: a.signals, stats: us?.stats || {}, events: eventsOf(s), today: todayJst() });
    note = '自動まとめ（AIなし・無料）';
  }
  $('#d-ai-text').innerHTML = state.aiBusy
    ? '<p class="muted">Claude が考えています…</p>'
    : text ? text.split('\n').filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('') + `<small class="muted">${esc(note)}</small>` : '';
  $('#d-ai-btn').hidden = !state.settings.aiKey;
  $('#d-ai-btn').disabled = state.aiBusy;

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
    return { ...r, score, penalty: pen, verdict: verdictOf(score) };
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
    .filter((r) => r.score >= f.min)
    .filter((r) => !q || r.sym.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))
    .filter((r) => FUNDA_FILTERS[f.funda].test(r))
    .sort((a, b) => b.score - a.score);
  const shown = rows.slice(0, f.limit);
  $('#scr-count').textContent = `${rows.length.toLocaleString()}件${rows.length > shown.length ? `（上位${shown.length}件を表示）` : ''}`;
  $('#scr-more').hidden = rows.length <= shown.length;
  $('#scr-rows').innerHTML = shown.length
    ? shown.map((r) => {
        const inList = state.settings.watchlist.includes(r.sym);
        return `<tr data-scr="${esc(r.sym)}">
          <td><div class="sym">${esc(r.sym)} ${r.seg ? `<span class="mk">${{ P: 'プ', S: 'ス', G: 'グ' }[r.seg] || ''}</span>` : ''}${r.liquid === false ? '<span class="mk thin">薄商い</span>' : ''}</div><div class="nm">${esc(r.name)}</div><div class="evs">${eventChips(r.sym)}</div></td>
          <td class="mono num">${fmt(r.price)}<div class="${sign(r.changePct)} small">${pct(r.changePct)}</div></td>
          <td>${meter(r.score)}<div><span class="badge ${r.verdict.key}">${r.verdict.label}</span></div></td>
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
  divdip: { label: '高配当×売られすぎ', test: (r) => r.divYield >= 0.03 && r.ids.some((id) => ['rsi_oversold', 'rsi_low', 'bb_lower'].includes(id)) },
  value: { label: '割安×上昇トレンド', test: (r) => ((r.pbr != null && r.pbr < 1.2) || (r.per != null && r.per < 15)) && r.ids.includes('uptrend') },
};

// ---------- ペーパートレード ----------
function renderPaper() {
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
  const price = q?.price ?? cs?.at(-1)?.close ?? null;
  const cur = marketOf(h.sym) === 'JP' ? 'JPY' : 'USD';
  const value = price != null ? price * h.shares : null;
  const pnl = price != null ? (price - h.cost) * h.shares : null;
  const lv = cs?.length ? holdingLevels(cs, h.cost) : null;
  const warns = [];
  if (a) {
    if (a.score <= -30) warns.push({ hot: true, text: `売りシグナル（スコア${a.score}）` });
    for (const x of a.signals) if (['dead_cross', 'macd_down', 'rsi_overbought', 'vol_surge_down'].includes(x.id)) warns.push({ text: x.label });
  }
  if (lv && price != null && price <= lv.stop) warns.push({ hot: true, text: `損切りライン ${fmt(lv.stop)} 割れ` });
  if (lv && price != null && price >= lv.target) warns.push({ text: `利確目安 ${fmt(lv.target)} 到達` });
  for (const b of eventBadges(h.sym)) if (b.days <= 7) warns.push({ hot: b.days <= 3, text: b.text });
  return { ...h, price, cur, value, pnl, pnlPct: price != null ? price / h.cost - 1 : null, lv, a, warns };
}

function renderHoldings() {
  const list = state.settings.holdings.map(holdingView);
  const fx = fxRate();
  const tot = { JPY: { v: 0, c: 0 }, USD: { v: 0, c: 0 } };
  for (const h of list) if (h.value != null) { tot[h.cur].v += h.value; tot[h.cur].c += h.cost * h.shares; }
  const jpyAll = tot.JPY.v + (fx ? tot.USD.v * fx : 0), jpyCost = tot.JPY.c + (fx ? tot.USD.c * fx : 0);
  $('#hold-sum').innerHTML = list.length ? `<div class="kpis">
      <div><small>評価額（円換算）</small><b>¥${Math.round(jpyAll).toLocaleString('ja-JP')}</b>${tot.USD.v && fx ? `<small>ドル円 ${fx.toFixed(2)} で換算</small>` : ''}</div>
      <div><small>含み損益</small><b class="${sign(jpyAll - jpyCost)}">${yen(jpyAll - jpyCost)}</b><small>${pctf(jpyCost ? jpyAll / jpyCost - 1 : null)}</small></div>
      <div><small>要注意</small><b class="${list.some((h) => h.warns.some((w) => w.hot)) ? 'down' : ''}">${list.filter((h) => h.warns.length).length}銘柄</b></div>
    </div>` : '';
  $('#hold-rows').innerHTML = list.length ? list.map((h) => `<tr data-sym="${esc(h.sym)}">
      <td><div class="sym">${esc(h.sym)}</div><div class="nm">${esc(nameOf(h.sym))}</div><div class="nm show-sm mono">${h.shares.toLocaleString()}株 @${fmt(h.cost)}</div>${h.a ? `<span class="badge ${h.a.verdict.key}">${h.a.verdict.label}</span>` : ''}</td>
      <td class="num small hide-sm"><div class="mono">${h.shares.toLocaleString()}株</div><div class="mono muted">@${fmt(h.cost)}</div></td>
      <td class="num"><div class="mono">${fmt(h.price)}</div><div class="mono small">${h.value != null ? money(h.value, h.cur) : ''}</div></td>
      <td class="num ${sign(h.pnl)}"><div class="mono">${h.pnl != null ? (h.pnl >= 0 ? '+' : '−') + money(Math.abs(h.pnl), h.cur) : '—'}</div><div class="mono small">${pctf(h.pnlPct)}</div></td>
      <td class="hide-sm small">${h.lv ? `<div>損切り <b class="mono">${fmt(h.lv.stop)}</b></div><div>利確 <b class="mono">${fmt(h.lv.target)}</b></div>` : ''}</td>
      <td class="small warns">${h.warns.length ? h.warns.map((w) => `<span class="ev ${w.hot ? 'hot' : ''}">${esc(w.text)}</span>`).join(' ') : '<span class="muted">—</span>'}
        <div><button class="mini ghost" data-del-hold="${esc(h.id)}">削除</button></div></td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="muted">まだ登録がありません。上のフォームから、持っている株のコード・株数・買値を入れてください。</td></tr>';
}

// 保有株の警告は1日1回だけ通知
function checkHoldings() {
  const day = todayJst();
  const sent = store.get('kr:holdNotified') || {};
  if (sent.day !== day) { sent.day = day; sent.keys = []; }
  for (const h of state.settings.holdings.map(holdingView)) {
    for (const w of h.warns.filter((x) => x.hot)) {
      const key = `${h.sym}:${w.text}`;
      if (sent.keys.includes(key)) continue;
      sent.keys.push(key);
      notify(`保有株: ${nameOf(h.sym)}`, w.text);
    }
  }
  store.set('kr:holdNotified', sent);
}

// ---------- 答え合わせ ----------
function renderReview() {
  const rv = state.server.review || state.local.review;
  if (!rv) { $('#review-body').innerHTML = '<p class="muted">計算中…</p>'; return; }
  const box = (st, label) => `<div><small>${label}</small><b class="${sign(st.avg)}">${pctf(st.avg, 2)}</b><small>勝率${st.win != null ? Math.round(st.win * 100) + '%' : '—'}・指数に勝った${st.beat != null ? Math.round(st.beat * 100) + '%' : '—'}</small></div>`;
  $('#review-body').innerHTML = `
    <p class="muted small">各営業日に「強い買いシグナル」（${state.server.review ? '地合いフィルター込み・' : ''}${rv.threshold}点以上）だった銘柄を、その後${rv.horizon}営業日の値動きで採点しています。${state.server.review ? '比較対象はTOPIX（連動ETF）。売買代金1億円未満の銘柄は除外。' : 'デモデータです。'}</p>
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
  $('#bt-body').innerHTML = `
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
function select(s) {
  state.selected = s;
  state.settings.tab = 'watch';
  render();
  $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  state.selected = null;
  render();
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
$('#scr-funda').addEventListener('change', (e) => { state.scr.funda = e.target.value; renderScreener(); });
$('#d-close').addEventListener('click', () => { state.selected = null; render(); });
$('#d-ai-btn').addEventListener('click', askAi);
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
