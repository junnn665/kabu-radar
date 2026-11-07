// 今日のAIピックの選び方（ホーム・AIの仮想口座・本番の答え合わせで同じものを使う）
//  1. 売買代金のある銘柄を、選んだ期間（1週間先／1か月先）の予測の高い順に
//  2. 同じ業種は2銘柄まで（地方銀行ばかり、のような偏りを防ぐ）
//  3. 決算発表が近い銘柄は外す（発表で大きく動き、値動きの予測が効かない）
//  4. もう一方の期間の予測が下半分の銘柄は外す（1週間先と1か月先の両方が良い銘柄を優先）
//  5. 相場が荒れているときは数を減らす／止める（stressOf）

export const PICK_N = 5, PICK_PER_SECTOR = 2;
export const EARNINGS_SKIP_DAYS = 3; // 決算発表まで3日（土日を挟んでおよそ2営業日）以内は外す
export const OTHER_MIN_RANK = 0.5;   // もう一方の期間の予測がこの順位未満なら外す

const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400e3);

export function earningsSoon(row, today, days = EARNINGS_SKIP_DAYS) {
  const e = row?.events?.earnings;
  if (!e || !today) return false;
  const d = daysBetween(today, e);
  return d >= 0 && d <= days;
}

// 相場の荒れ具合。level 0＝普段どおり、1＝注意（ピックを減らす）、2＝荒れている（ピックを止める）
// market: { N225: [candles], VIX: [candles] }（build_data.mjs で計算して market.json に入れる）
export function stressOf(market) {
  const notes = [];
  let level = 0;
  const n = market?.N225;
  if (n?.length >= 6) {
    const c = n.at(-1).close, r1 = c / n.at(-2).close - 1, r5 = c / n.at(-6).close - 1;
    if (r5 <= -0.07 || r1 <= -0.04) { level = 2; notes.push(`日経平均 ${r1 <= -0.04 ? `前日比${(r1 * 100).toFixed(1)}%` : `5日で${(r5 * 100).toFixed(1)}%`}`); }
    else if (r5 <= -0.04 || r1 <= -0.025) { level = Math.max(level, 1); notes.push(`日経平均 ${r1 <= -0.025 ? `前日比${(r1 * 100).toFixed(1)}%` : `5日で${(r5 * 100).toFixed(1)}%`}`); }
  }
  const v = market?.VIX?.at(-1)?.close;
  if (v >= 35) { level = 2; notes.push(`VIX ${v.toFixed(1)}`); }
  else if (v >= 28) { level = Math.max(level, 1); notes.push(`VIX ${v.toFixed(1)}`); }
  return { level, notes, n: level === 2 ? 0 : level === 1 ? 3 : PICK_N };
}

// rows: screener の行。horizon: 5 | 20。返り値は選んだ行（both：もう一方の期間でも上位20%）
export function selectPicks(rows, { horizon = 5, n = PICK_N, perSector = PICK_PER_SECTOR, today = null, stress = null, skip = null } = {}) {
  const predOf = (r) => (horizon === 20 ? r.pred20 : r.pred);
  const otherRank = (r) => (horizon === 20 ? r.aiRank : r.aiRank20);
  const limit = stress ? Math.min(n, stress.n ?? n) : n;
  const out = [], per = {};
  if (limit <= 0) return out;
  const cands = (rows || []).filter((r) => r.liquid && predOf(r) != null).sort((a, b) => predOf(b) - predOf(a));
  for (const r of cands) {
    if (skip?.(r)) continue;
    if (earningsSoon(r, today)) continue;
    const o = otherRank(r);
    if (o != null && o < OTHER_MIN_RANK) continue;
    const k = r.sector || '-';
    if ((per[k] || 0) >= perSector) continue;
    per[k] = (per[k] || 0) + 1;
    out.push({ ...r, both: o != null && o >= 0.8 });
    if (out.length >= limit) break;
  }
  return out;
}
