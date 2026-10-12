// データ取得プロバイダー。
// どれも同じインターフェース:
//   getDailyCandles(symbol) -> [{ date:'YYYY-MM-DD', open, high, low, close, volume }]（古い順）
//   getQuotes(symbols)      -> { [symbol]: { price, prevClose, change, changePct, volume, name, marketOpen } }

const todayStr = (d = new Date()) => d.toISOString().slice(0, 10);

// ---------- デモ（APIキー不要・シミュレーション） ----------
const DEMO_META = {
  AAPL: ['Apple', 230], MSFT: ['Microsoft', 450], NVDA: ['NVIDIA', 140], TSLA: ['Tesla', 250],
  AMZN: ['Amazon', 200], GOOGL: ['Alphabet', 180], META: ['Meta', 600],
  '7203': ['トヨタ自動車', 2800], '6758': ['ソニーグループ', 3300], '9984': ['ソフトバンクG', 9000],
  '8306': ['三菱UFJ FG', 1800], '6861': ['キーエンス', 65000],
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
    const [, base] = DEMO_META[symbol] || [symbol, 50 + rnd() * 400];
    const out = [];
    let p = base, drift = (rnd() - 0.5) * 0.004;
    const d = new Date();
    d.setDate(d.getDate() - 300);
    for (;;) {
      d.setDate(d.getDate() + 1);
      if (todayStr(d) > todayStr()) break;
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      if (rnd() < 0.04) drift = (rnd() - 0.5) * 0.006; // トレンド転換
      const shock = rnd() < 0.02 ? gauss(rnd) * 0.05 : 0;
      const ret = drift + gauss(rnd) * 0.015 + shock;
      const open = p;
      const close = Math.max(1, p * (1 + ret));
      const high = Math.max(open, close) * (1 + rnd() * 0.01);
      const low = Math.min(open, close) * (1 - rnd() * 0.01);
      const volume = Math.round(1e6 * (0.6 + rnd()) * (1 + Math.abs(ret) * 40));
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
      // ティック：小さなランダムウォーク
      const move = gauss(Math.random) * 0.0025 * lastC.close;
      lastC.close = Math.max(1, lastC.close + move);
      lastC.high = Math.max(lastC.high, lastC.close);
      lastC.low = Math.min(lastC.low, lastC.close);
      lastC.volume += Math.round(Math.random() * 20000);
      res[s] = {
        price: lastC.close, prevClose: prev, change: lastC.close - prev,
        changePct: ((lastC.close - prev) / prev) * 100, volume: lastC.volume,
        name: DEMO_META[s]?.[0] || s, marketOpen: true,
        market: /^\d/.test(s) ? 'JP' : 'US', date: lastC.date,
      };
    }
    return res;
  }
}

// ---------- Twelve Data（無料キーで米国株の日足＋クォート） ----------
// https://twelvedata.com/  無料枠: 8リクエスト/分・800/日（2026年時点の公開情報。変更の可能性あり）
export class TwelveDataProvider {
  constructor(apiKey) {
    this.name = 'Twelve Data';
    this.key = apiKey;
    this.base = 'https://api.twelvedata.com';
    this.live = false;
  }

  // 無料枠（8クレジット/分）を超えないよう送信を待たせる。1銘柄 = 1クレジット。
  async _throttle(credits) {
    this._log = this._log || [];
    for (;;) {
      const now = Date.now();
      this._log = this._log.filter((t) => now - t < 61000);
      if (this._log.length + credits <= 8) break;
      await new Promise((r) => setTimeout(r, 61000 - (now - this._log[0])));
    }
    for (let i = 0; i < credits; i++) this._log.push(Date.now());
  }

  async _get(path, params) {
    await this._throttle(String(params.symbol || '').split(',').length);
    const url = new URL(this.base + path);
    Object.entries({ ...params, apikey: this.key }).forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await fetch(url);
    const j = await r.json();
    if (j.status === 'error') throw new Error(j.message || 'API error');
    return j;
  }

  async getDailyCandles(symbol) {
    const cacheKey = `kr:td:candles:${symbol}:${todayStr()}`;
    try {
      const hit = localStorage.getItem(cacheKey);
      if (hit) return JSON.parse(hit);
    } catch {}
    const j = await this._get('/time_series', { symbol, interval: '1day', outputsize: 200 });
    const out = (j.values || []).map((v) => ({
      date: v.datetime.slice(0, 10), open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +(v.volume || 0),
    })).reverse();
    try { localStorage.setItem(cacheKey, JSON.stringify(out)); } catch {}
    return out;
  }

  async getQuotes(symbols) {
    const res = {};
    for (let i = 0; i < symbols.length; i += 8) {
      const chunk = symbols.slice(i, i + 8);
      const j = await this._get('/quote', { symbol: chunk.join(',') });
      Object.assign(res, this._parseQuotes(chunk, chunk.length === 1 ? { [chunk[0]]: j } : j));
    }
    return res;
  }

  _parseQuotes(symbols, map) {
    const res = {};
    for (const s of symbols) {
      const q = map[s];
      if (!q || q.status === 'error' || q.close == null) continue;
      res[s] = {
        price: +q.close, prevClose: +q.previous_close, change: +q.change, changePct: +q.percent_change,
        volume: +(q.volume || 0), name: q.name || s, marketOpen: !!q.is_market_open,
      };
    }
    return res;
  }
}

// ---------- GitHub Actions が生成した静的データ（日米80銘柄・約15分ごと・約20分遅延） ----------
export class StaticProvider {
  constructor(base = 'data') {
    this.name = '自動取得データ（日米・15分更新）';
    this.base = base;
    this.live = false;
    this.static = true;
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
    try {
      return await this.json(`candles/${encodeURIComponent(symbol)}.json`, { fresh: true });
    } catch (e) {
      throw new Error(e.message === 'データがありません' ? '対象外の銘柄です（config/universe.json に追加すると取得されます）' : e.message);
    }
  }

  async getQuotes(symbols) {
    this.quotesDoc = await this.json('quotes.json', { fresh: true });
    const res = {};
    for (const s of symbols) if (this.quotesDoc.quotes[s]) res[s] = this.quotesDoc.quotes[s];
    return res;
  }
}

export const DEMO_SYMBOLS = Object.keys(DEMO_META);

export async function makeProvider(settings) {
  if (settings.provider === 'twelvedata' && settings.apiKey) return new TwelveDataProvider(settings.apiKey);
  if (settings.provider === 'demo') return new DemoProvider();
  const st = new StaticProvider();
  return (await st.available()) ? st : new DemoProvider();
}
