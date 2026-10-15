// 正方形に近い長方形で敷き詰める（squarified treemap）。items: [{ value, ... }] → [{ ...item, x, y, w, h }]
export function squarify(items, x, y, w, h) {
  const list = items.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const total = list.reduce((s, d) => s + d.value, 0);
  if (!total || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  const nodes = list.map((d) => ({ d, a: d.value * scale }));
  const out = [];
  let rx = x, ry = y, rw = w, rh = h;
  const worst = (row, side) => {
    const s = row.reduce((t, n) => t + n.a, 0);
    let mx = 0, mn = Infinity;
    for (const n of row) { mx = Math.max(mx, n.a); mn = Math.min(mn, n.a); }
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  const lay = (row) => {
    const s = row.reduce((t, n) => t + n.a, 0);
    if (rw >= rh) { // 左に縦の列
      const cw = s / rh;
      let cy = ry;
      for (const n of row) { const ch = n.a / cw; out.push({ ...n.d, x: rx, y: cy, w: cw, h: ch }); cy += ch; }
      rx += cw; rw -= cw;
    } else { // 上に横の行
      const ch = s / rw;
      let cx = rx;
      for (const n of row) { const cw = n.a / ch; out.push({ ...n.d, x: cx, y: ry, w: cw, h: ch }); cx += cw; }
      ry += ch; rh -= ch;
    }
  };
  let row = [];
  for (const n of nodes) {
    const side = Math.min(rw, rh);
    if (!row.length || worst([...row, n], side) <= worst(row, side)) row.push(n);
    else { lay(row); row = [n]; }
  }
  if (row.length) lay(row);
  return out;
}
