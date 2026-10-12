// 依存なしの Canvas チャート：ローソク足 + 移動平均 + ボリンジャー + 出来高 + RSI

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function drawChart(canvas, candles, ind, { bars = 90 } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  if (!candles?.length) return;

  const n = Math.min(bars, candles.length);
  const off = candles.length - n;
  const cs = candles.slice(off);
  const pick = (arr) => (arr ? arr.slice(off) : []);
  const s5 = pick(ind?.sma5), s25 = pick(ind?.sma25), s75 = pick(ind?.sma75);
  const bu = pick(ind?.bb.upper), bl = pick(ind?.bb.lower), rs = pick(ind?.rsi);

  const padR = 52, padT = 8;
  const priceH = H * 0.62, volH = H * 0.13, rsiH = H * 0.2, gap = H * 0.025;
  const plotW = W - padR;
  const step = plotW / n, bw = Math.max(1, step * 0.6);
  const x = (i) => i * step + step / 2;

  const vals = cs.flatMap((c) => [c.high, c.low]).concat(bu.filter(Boolean), bl.filter(Boolean));
  let hi = Math.max(...vals), lo = Math.min(...vals);
  const pad = (hi - lo) * 0.05; hi += pad; lo -= pad;
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (priceH - padT);

  const up = css('--up'), down = css('--down'), grid = css('--grid'), muted = css('--muted');
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.fillStyle = muted; ctx.strokeStyle = grid; ctx.lineWidth = 1;

  // グリッド＋価格目盛り
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4, yy = y(v);
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
    ctx.fillText(fmt(v), plotW + 4, yy + 3);
  }

  // ボリンジャー帯
  ctx.fillStyle = css('--band');
  ctx.beginPath();
  let started = false;
  bu.forEach((v, i) => { if (v == null) return; started ? ctx.lineTo(x(i), y(v)) : (ctx.moveTo(x(i), y(v)), started = true); });
  for (let i = bl.length - 1; i >= 0; i--) if (bl[i] != null) ctx.lineTo(x(i), y(bl[i]));
  ctx.closePath(); ctx.fill();

  // ローソク足
  cs.forEach((c, i) => {
    const col = c.close >= c.open ? up : down;
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(x(i), y(c.high)); ctx.lineTo(x(i), y(c.low)); ctx.stroke();
    const top = y(Math.max(c.open, c.close)), h = Math.max(1, Math.abs(y(c.open) - y(c.close)));
    ctx.fillRect(x(i) - bw / 2, top, bw, h);
  });

  const line = (arr, color, w = 1.4) => {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
    let s = false;
    arr.forEach((v, i) => { if (v == null) return; s ? ctx.lineTo(x(i), y(v)) : (ctx.moveTo(x(i), y(v)), s = true); });
    ctx.stroke(); ctx.lineWidth = 1;
  };
  line(s5, css('--ma5')); line(s25, css('--ma25')); line(s75, css('--ma75'));

  // 現在値ライン
  const lastC = cs[cs.length - 1];
  ctx.setLineDash([3, 3]); ctx.strokeStyle = css('--accent');
  ctx.beginPath(); ctx.moveTo(0, y(lastC.close)); ctx.lineTo(plotW, y(lastC.close)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = css('--accent'); ctx.fillRect(plotW, y(lastC.close) - 8, padR, 16);
  ctx.fillStyle = css('--bg'); ctx.fillText(fmt(lastC.close), plotW + 4, y(lastC.close) + 3);

  // 出来高
  const vTop = priceH + gap, maxV = Math.max(...cs.map((c) => c.volume || 0)) || 1;
  cs.forEach((c, i) => {
    ctx.fillStyle = (c.close >= c.open ? up : down) + '88';
    const h = ((c.volume || 0) / maxV) * volH;
    ctx.fillRect(x(i) - bw / 2, vTop + volH - h, bw, h);
  });

  // RSI
  const rTop = vTop + volH + gap, ry = (v) => rTop + (1 - v / 100) * rsiH;
  ctx.fillStyle = css('--band'); ctx.fillRect(0, ry(70), plotW, ry(30) - ry(70));
  ctx.fillStyle = muted;
  [30, 70].forEach((v) => ctx.fillText(v, plotW + 4, ry(v) + 3));
  ctx.fillText('RSI', 4, rTop + 10);
  ctx.strokeStyle = css('--rsi'); ctx.lineWidth = 1.3; ctx.beginPath();
  let s = false;
  rs.forEach((v, i) => { if (v == null) return; s ? ctx.lineTo(x(i), ry(v)) : (ctx.moveTo(x(i), ry(v)), s = true); });
  ctx.stroke();
}

export function sparkline(values, w = 90, h = 28) {
  if (!values?.length) return '';
  const hi = Math.max(...values), lo = Math.min(...values), r = hi - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - lo) / r) * (h - 2) - 1).toFixed(1)}`).join(' ');
  const cls = values[values.length - 1] >= values[0] ? 'up' : 'down';
  return `<svg class="spark ${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

export function fmt(v) {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  return v.toLocaleString('ja-JP', { maximumFractionDigits: a >= 1000 ? 0 : 2, minimumFractionDigits: a >= 1000 ? 0 : 2 });
}
