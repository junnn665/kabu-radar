import { makeProvider } from './providers.js';
import { analyze } from './signals.js';
import { drawChart, sparkline, fmt } from './chart.js';

// ---------- 設定 ----------
const DEFAULTS = {
  provider: 'demo',
  apiKey: '',
  interval: 5,
  watchlist: ['AAPL', 'MSFT', 'NVDA', 'TSLA', '7203', '6758', '9984', '8306'],
  upColor: 'green',
  alerts: {},
};
const store = {
  load() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('kr:settings') || '{}') }; } catch { return { ...DEFAULTS }; }
  },
  save(s) { try { localStorage.setItem('kr:settings', JSON.stringify(s)); } catch {} },
};

const state = {
  settings: store.load(),
  provider: null,
  candles: {},
  quotes: {},
  analyses: {},
  prevVerdict: {},
  selected: null,
  timer: null,
  busy: false,
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- データ更新 ----------
async function loadCandles(symbols) {
  for (const s of symbols) {
    try {
      state.candles[s] = await state.provider.getDailyCandles(s);
    } catch (e) {
      toast(`${s}: 日足の取得に失敗（${e.message}）`, 'err');
      state.candles[s] = [];
    }
    recompute(s);
    render();
  }
}

function mergeQuote(s, q) {
  const cs = state.candles[s];
  if (!cs?.length) return;
  const lastC = cs[cs.length - 1];
  // デモは配列を直接更新済み。API の場合は最新足に反映する
  if (Math.abs(lastC.close - q.price) > 1e-9) {
    lastC.close = q.price;
    lastC.high = Math.max(lastC.high, q.price);
    lastC.low = Math.min(lastC.low, q.price);
    if (q.volume) lastC.volume = q.volume;
  }
}

function recompute(s) {
  const a = analyze(state.candles[s]);
  state.analyses[s] = a;
  const prev = state.prevVerdict[s];
  if (prev && prev !== 'strong' && a.verdict.key === 'strong') {
    notify(`${nameOf(s)} が「強い買いシグナル」に`, a.signals.slice(0, 2).map((x) => x.label).join('・'));
  }
  state.prevVerdict[s] = a.verdict.key;
}

async function tick() {
  if (state.busy) return;
  state.busy = true;
  const syms = state.settings.watchlist.filter((s) => state.candles[s]?.length);
  try {
    const qs = await state.provider.getQuotes(syms);
    for (const [s, q] of Object.entries(qs)) {
      const old = state.quotes[s];
      q.flash = old ? Math.sign(q.price - old.price) : 0;
      state.quotes[s] = q;
      mergeQuote(s, q);
      recompute(s);
      checkAlerts(s, q, old);
    }
    $('#updated').textContent = new Date().toLocaleTimeString('ja-JP');
    $('#status').className = 'dot live';
  } catch (e) {
    $('#status').className = 'dot err';
    toast(`価格の取得に失敗: ${e.message}`, 'err');
  } finally {
    state.busy = false;
  }
  render();
}

function restart() {
  clearInterval(state.timer);
  state.provider = makeProvider(state.settings);
  state.candles = {}; state.quotes = {}; state.analyses = {}; state.prevVerdict = {};
  $('#provider').textContent = state.provider.name;
  document.documentElement.dataset.up = state.settings.upColor;
  render();
  loadCandles(state.settings.watchlist).then(tick);
  const sec = Math.max(state.provider.live ? 2 : 30, +state.settings.interval || 5);
  state.timer = setInterval(tick, sec * 1000);
}

// ---------- アラート ----------
function checkAlerts(s, q, old) {
  const al = state.settings.alerts[s];
  if (!al || !old) return;
  if (al.above && old.price < al.above && q.price >= al.above) notify(`${nameOf(s)} が ${fmt(al.above)} を上抜け`, `現在値 ${fmt(q.price)}`);
  if (al.below && old.price > al.below && q.price <= al.below) notify(`${nameOf(s)} が ${fmt(al.below)} を下抜け`, `現在値 ${fmt(q.price)}`);
}

function notify(title, body) {
  toast(`${title}${body ? ' — ' + body : ''}`, 'info');
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
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

// ---------- 描画 ----------
const nameOf = (s) => state.quotes[s]?.name || s;
const sign = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct = (v) => (v == null || Number.isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);

function render() {
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
          <div class="pick-score"><span class="mono">${a.score}</span><small>/100</small></div>
          <ul>${a.signals.filter((x) => x.weight > 0).slice(0, 3).map((x) => `<li>${esc(x.label)}</li>`).join('')}</ul>
        </button>`;
      }).join('')
    : `<p class="empty">いまは条件を満たす銘柄がありません。監視は続いています。</p>`;
}

function renderTable() {
  const rows = state.settings.watchlist.map((s) => {
    const q = state.quotes[s], a = state.analyses[s], cs = state.candles[s];
    const spark = cs?.length ? sparkline(cs.slice(-30).map((c) => c.close)) : '';
    const sc = a?.score ?? 0;
    const flash = q?.flash > 0 ? 'flash-up' : q?.flash < 0 ? 'flash-down' : '';
    return `<tr data-sym="${esc(s)}" class="${state.selected === s ? 'sel' : ''}">
      <td><div class="sym">${esc(s)}</div><div class="nm">${esc(nameOf(s))}</div></td>
      <td class="mono num ${flash}">${fmt(q?.price)}</td>
      <td class="mono num ${sign(q?.changePct)}">${pct(q?.changePct)}</td>
      <td class="hide-sm">${spark}</td>
      <td><div class="meter"><i style="--v:${(sc + 100) / 2}%" class="${sc >= 0 ? 'pos' : 'neg'}"></i></div><span class="mono sc">${a ? sc : '…'}</span></td>
      <td>${a ? `<span class="badge ${a.verdict.key}">${a.verdict.label}</span>` : '<span class="muted">読込中</span>'}</td>
    </tr>`;
  });
  $('#rows').innerHTML = rows.join('');
}

function renderDetail() {
  const s = state.selected;
  const box = $('#detail');
  if (!s) { box.hidden = true; return; }
  box.hidden = false;
  const q = state.quotes[s], a = state.analyses[s], al = state.settings.alerts[s] || {};
  $('#d-title').innerHTML = `<span class="sym">${esc(s)}</span> ${esc(nameOf(s))}`;
  $('#d-price').innerHTML = `<span class="mono big">${fmt(q?.price)}</span> <span class="mono ${sign(q?.change)}">${q ? (q.change > 0 ? '+' : '') + fmt(q.change) : ''} (${pct(q?.changePct)})</span>`;
  $('#d-signals').innerHTML = a?.signals.length
    ? a.signals.map((x) => `<li class="${x.weight > 0 ? 'pos' : 'neg'}"><b class="mono">${x.weight > 0 ? '+' : ''}${x.weight}</b><div><strong>${esc(x.label)}</strong><small>${esc(x.detail)}</small></div></li>`).join('')
    : '<li class="muted">目立ったシグナルはありません</li>';
  $('#d-score').innerHTML = a ? `総合スコア <b class="mono">${a.score}</b> ・ <span class="badge ${a.verdict.key}">${a.verdict.label}</span>` : '';
  const ab = $('#al-above'), bl = $('#al-below');
  if (document.activeElement !== ab) ab.value = al.above ?? '';
  if (document.activeElement !== bl) bl.value = al.below ?? '';
  drawChart($('#chart'), state.candles[s], a?.ind);
}

// ---------- 操作 ----------
function select(s) {
  state.selected = s;
  render();
  $('#detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-sym]');
  if (row) select(row.dataset.sym);
});

$('#add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = $('#add-sym').value.trim().toUpperCase();
  if (!s) return;
  if (state.settings.watchlist.includes(s)) { toast(`${s} は登録済みです`); return; }
  state.settings.watchlist.push(s);
  store.save(state.settings);
  $('#add-sym').value = '';
  loadCandles([s]).then(tick);
});

$('#d-remove').addEventListener('click', () => {
  const s = state.selected;
  state.settings.watchlist = state.settings.watchlist.filter((x) => x !== s);
  delete state.settings.alerts[s];
  store.save(state.settings);
  state.selected = null;
  render();
});

$('#d-close').addEventListener('click', () => { state.selected = null; render(); });

$('#al-save').addEventListener('click', () => {
  const s = state.selected;
  const above = parseFloat($('#al-above').value), below = parseFloat($('#al-below').value);
  state.settings.alerts[s] = { above: isNaN(above) ? null : above, below: isNaN(below) ? null : below };
  store.save(state.settings);
  toast(`${s} のアラートを保存しました`);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
});

// 設定ダイアログ
const dlg = $('#settings');
$('#open-settings').addEventListener('click', () => {
  const st = state.settings;
  $('#s-provider').value = st.provider;
  $('#s-key').value = st.apiKey;
  $('#s-interval').value = st.interval;
  $('#s-up').value = st.upColor;
  dlg.showModal();
});
$('#s-save').addEventListener('click', (e) => {
  e.preventDefault();
  Object.assign(state.settings, {
    provider: $('#s-provider').value,
    apiKey: $('#s-key').value.trim(),
    interval: +$('#s-interval').value || 5,
    upColor: $('#s-up').value,
  });
  if (state.settings.provider === 'twelvedata' && !state.settings.apiKey) {
    toast('Twelve Data には APIキーが必要です', 'err');
    return;
  }
  if (state.settings.provider === 'twelvedata' && state.settings.interval < 60) state.settings.interval = 60;
  store.save(state.settings);
  dlg.close();
  restart();
});
$('#s-cancel').addEventListener('click', (e) => { e.preventDefault(); dlg.close(); });
$('#s-notify').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!('Notification' in window)) return toast('このブラウザは通知に対応していません', 'err');
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? '通知を有効にしました' : '通知は許可されませんでした');
});

window.addEventListener('resize', () => state.selected && renderDetail());
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

restart();
