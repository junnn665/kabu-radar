// データ取得プロバイダー（日本株）。
// どれも同じインターフェース:
//   getDailyCandles(symbol) -> [{ date:'YYYY-MM-DD', open, high, low, close, volume }]（古い順）
//   getQuotes(symbols)      -> { [symbol]: { price, prevClose, change, changePct, volume, name, date, marketOpen } }

const todayStr = (d = new Date()) => d.toISOString().slice(0, 10);

// ---------- デモ（データ未生成のときのシミュレーション） ----------
const DEMO_META = {
  '7203': ['トヨタ自動車', 2800], '6758': ['ソニーグループ', 3300], '9984': ['ソフトバンクグループ', 9000],
  '8306': ['三菱UFJフィナンシャル・グループ', 1800], '6861': ['キーエンス', 65000], '8035': ['東京エレクトロン', 25000],
  '9432': ['日本電信電話', 150], '6501': ['日立製作所', 3800], '7974': ['任天堂', 9000], '8058': ['三菱商事', 2800],
  '4063': ['信越化学工業', 5500], '6098': ['リクルートホールディングス', 9500], '9983': ['ファーストリテイリング', 45000],
  '7011': ['三菱重工業', 2400], '6857': ['アドバンテスト', 9000], '4568': ['第一三共', 4000],
};

function seeded(str) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rnd) => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());

export class DemoProvider {
  constructor() { this.name = 'デモ（シミュレーション）'; this.series = {}; this.live = true; }

  _build(symbol) {
    const rnd = seeded(symbol + todayStr().slice(0, 7));
    const [, base] = DEMO_META[symbol] || [symbol, 500 + rnd() * 4000];
    const out = [];
    let p = base, drift = (rnd() - 0.5) * 0.004;
    const d = new Date();
    d.setDate(d.getDate() - 300);
    for (;;) {
      d.setDate(d.getDate() + 1);
      if (todayStr(d) > todayStr()) break;
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      if (rnd() < 0.04) drift = (rnd() - 0.5) * 0.006;
      const shock = rnd() < 0.02 ? gauss(rnd) * 0.05 : 0;
      const ret = drift + gauss(rnd) * 0.015 + shock;
      const open = p * (1 + gauss(rnd) * 0.004);
      const close = Math.max(1, p * (1 + ret));
      const high = Math.max(open, close) * (1 + rnd() * 0.01);
      const low = Math.min(open, close) * (1 - rnd() * 0.01);
      const volume = Math.round(2e6 * (0.6 + rnd()) * (1 + Math.abs(ret) * 40));
      out.push({ date: todayStr(d), open, high, low, close, volume });
      p = close;
    }
    return out;
  }

  async getDailyCandles(symbol) {
    if (!this.series[symbol]) this.series[symbol] = this._build(symbol);
    return this.series[symbol].map((c) => ({ ...c }));
  }

  async getQuotes(symbols) {
    const res = {};
    for (const s of symbols) {
      const ser = this.series[s] || (this.series[s] = this._build(s));
      const lastC = ser[ser.length - 1];
      const prev = ser[ser.length - 2]?.close ?? lastC.open;
      const move = gauss(Math.random) * 0.0025 * lastC.close;
      lastC.close = Math.max(1, lastC.close + move);
      lastC.high = Math.max(lastC.high, lastC.close);
      lastC.low = Math.min(lastC.low, lastC.close);
      lastC.volume += Math.round(Math.random() * 20000);
      res[s] = {
        price: lastC.close, prevClose: prev, change: lastC.close - prev,
        changePct: ((lastC.close - prev) / prev) * 100, volume: lastC.volume,
        name: DEMO_META[s]?.[0] || s, marketOpen: true, date: lastC.date,
      };
    }
    return res;
  }
}

// ---------- GitHub Actions が生成した静的データ（東証全銘柄・取引時間中15分ごと・約20分遅延） ----------
export class StaticProvider {
  constructor(base = 'data') {
    this.name = '東証全銘柄（5分更新）';
    this.base = base;
    this.live = false;
    this.static = true;
    this.names = {};
  }

  async json(file, { fresh = false } = {}) {
    const r = await fetch(`${this.base}/${file}${fresh ? `?t=${Date.now()}` : ''}`, { cache: fresh ? 'no-store' : 'default' });
    if (!r.ok) throw new Error(r.status === 404 ? 'データがありません' : `HTTP ${r.status}`);
    return r.json();
  }

  async available() {
    try { this.quotesDoc = await this.json('quotes.json', { fresh: true }); return true; } catch { return false; }
  }

  async getDailyCandles(symbol) {
    let b;
    try {
      b = await this.json(`candles/${encodeURIComponent(symbol)}.json`, { fresh: true });
    } catch (e) {
      throw new Error(e.message === 'データがありません' ? '見つかりません（東証上場の内国株式のみ対応）' : e.message);
    }
    if (Array.isArray(b)) return b;
    return b.d.map((d, i) => ({ date: d, open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i], volume: b.v[i] }));
  }

  quote(s) {
    const doc = this.quotesDoc;
    const q = doc?.q?.[s];
    if (q) {
      const [price, prevClose, volume, date] = q;
      return { price, prevClose, change: price - prevClose, changePct: (price / prevClose - 1) * 100, volume, date, name: this.names[s] || s, marketOpen: doc.marketOpen };
    }
    return doc?.quotes?.[s] || null; // 旧形式
  }

  async getQuotes(symbols) {
    this.quotesDoc = await this.json('quotes.json', { fresh: true });
    const res = {};
    for (const s of symbols) { const q = this.quote(s); if (q) res[s] = q; }
    return res;
  }
}

export const DEMO_SYMBOLS = Object.keys(DEMO_META);

// 本物のデータが一時的に読めなくても、勝手にデモ（架空の値動き）へは切り替えない。
// デモになるのは、設定でデモを選んだときと、手元で動かしていてデータが無いときだけ。
export async function makeProvider(settings) {
  if (settings.provider === 'demo') return new DemoProvider();
  const st = new StaticProvider();
  for (let i = 0; i < 3; i++) {
    if (await st.available()) return st;
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  const local = typeof location === 'undefined' || /^(localhost|127\.|0\.0\.0\.0)/.test(location.hostname) || location.protocol === 'file:';
  if (local) return new DemoProvider();
  st.unavailable = true; // 画面に「読み込めません」と出して、次の更新で再挑戦する
  return st;
}
