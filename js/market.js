// 地合い（市場全体の状態）。指数・VIX・ドル円から「買いシグナルを割り引く点数」を出す。
import { sma } from './indicators.js';

const lastOnOrBefore = (dates, d, strict = false) => {
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (strict ? dates[m] < d : dates[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
};

function prep(candles) {
  if (!candles?.length) return null;
  const close = candles.map((c) => c.close);
  return { dates: candles.map((c) => c.date), close, sma25: sma(close, 25) };
}

export const INDEX_NAMES = { N225: '日経平均', SPX: 'S&P500', VIX: 'VIX', USDJPY: 'ドル円' };

// market: { N225:[candles], SPX:[...], VIX:[...], USDJPY:[...] }
export function makeRegime(market) {
  const p = Object.fromEntries(Object.entries(market || {}).map(([k, v]) => [k, prep(v)]));
  // date 時点の地合い。mkt は 'JP' | 'US'
  return function regimeAt(mkt, date) {
    const notes = [];
    let penalty = 0;
    const idx = p[mkt === 'JP' ? 'N225' : 'SPX'];
    const name = mkt === 'JP' ? '日経平均' : 'S&P500';
    if (idx) {
      const i = lastOnOrBefore(idx.dates, date);
      if (i >= 30) {
        const c = idx.close[i], s = idx.sma25[i], sp = idx.sma25[i - 5];
        if (s != null && sp != null && c < s && s < sp) { penalty += 10; notes.push(`${name}が25日線の下で下向き`); }
        const r1 = c / idx.close[i - 1] - 1;
        if (r1 <= -0.02) { penalty += 10; notes.push(`${name}が前日比${(r1 * 100).toFixed(1)}%`); }
      }
    }
    const vix = p.VIX;
    if (vix) {
      // 日本株は前日の米国市場の VIX を見る
      const i = lastOnOrBefore(vix.dates, date, mkt === 'JP');
      const v = i >= 0 ? vix.close[i] : null;
      if (v >= 30) { penalty += 15; notes.push(`VIX ${v.toFixed(1)}（強い不安）`); }
      else if (v >= 25) { penalty += 10; notes.push(`VIX ${v.toFixed(1)}（不安が高まり）`); }
    }
    const fx = p.USDJPY;
    if (fx && mkt === 'JP') {
      const i = lastOnOrBefore(fx.dates, date);
      if (i >= 1) {
        const r1 = fx.close[i] / fx.close[i - 1] - 1;
        if (r1 <= -0.015) { penalty += 5; notes.push(`急な円高（ドル円${(r1 * 100).toFixed(1)}%）`); }
      }
    }
    penalty = Math.min(25, penalty);
    const state = penalty === 0 ? { key: 'good', label: '良好' } : penalty <= 10 ? { key: 'warn', label: '注意' } : { key: 'bad', label: '悪い' };
    return { penalty, notes, state };
  };
}

export const marketOf = (sym) => (/^\d/.test(sym) ? 'JP' : 'US');
