import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeed, jstParts, liveWindow } from '../js/providers.js';

const at = (iso) => Date.parse(iso); // UTC 指定
const doc = (t, date) => ({ t: t / 1000, asOf: t / 1000 - 1200, date, syms: ['7203', '9434'], p: [3000, 240], pc: [2900, 250], o: [2950, 249], h: [3010, 251], l: [2940, 239], v: [1e6, 2e6], ts: [0, -60], idx: {} });

test('JSTの時刻とファイル名', () => {
  const p = jstParts(at('2026-10-14T05:03:40Z'));
  assert.equal(p.date, '2026-10-14');
  assert.equal(p.hm, 1403);
  assert.equal(p.stamp, '20261014-1403');
  assert.ok(liveWindow(at('2026-10-14T00:00:00Z')));   // 水 9:00
  assert.ok(!liveWindow(at('2026-10-17T02:00:00Z')));  // 土
  assert.ok(!liveWindow(at('2026-10-14T07:00:00Z')));  // 16:00
});

test('1分ごとのファイルを読む：75秒前の分→無ければその前の分', async () => {
  const now = at('2026-10-14T05:03:40Z'); // JST 14:03:40 → 14:02 を探す
  const seen = [];
  const files = { '20261014-1401.json': doc(now - 150e3, '2026-10-14') };
  const fetchFn = async (u) => { const n = u.split('/').pop(); seen.push(n); return files[n] ? { ok: true, json: async () => files[n] } : { ok: false }; };
  const f = new LiveFeed('o/r', { fetchFn });
  assert.equal(await f.poll(now), true);
  assert.deepEqual(seen, ['20261014-1402.json', '20261014-1401.json']);
  assert.ok(f.fresh(now));
  const q = f.quote('7203');
  assert.equal(q.price, 3000);
  assert.ok(Math.abs(q.changePct - (3000 / 2900 - 1) * 100) < 1e-9);
  assert.equal(q.live, true);
  // 同じ分なら読み直さない
  seen.length = 0;
  files['20261014-1402.json'] = undefined;
  assert.equal(await f.poll(now + 1000), false);
  assert.deepEqual(seen, ['20261014-1402.json']); // 1401 は読み込み済みなので取りに行かない
});

test('見つからない・取引時間外は読みに行かない', async () => {
  let calls = 0;
  const f = new LiveFeed('o/r', { fetchFn: async () => { calls++; return { ok: false }; } });
  assert.equal(await f.poll(at('2026-10-17T02:00:00Z')), false); // 土曜
  assert.equal(calls, 0);
  const now = at('2026-10-14T02:40:00Z'); // 昼休み 11:40
  await f.poll(now); await f.poll(now + 60e3);
  const c = calls;
  await f.poll(now + 120e3); // 2回続けて無い → 5分休む
  assert.equal(calls, c);
  assert.ok(!f.fresh(now));
});

test('前日のデータは使わない', async () => {
  const now = at('2026-10-14T00:30:00Z');
  const f = new LiveFeed('o/r', { fetchFn: async () => ({ ok: true, json: async () => doc(now - 60e3, '2026-10-13') }) });
  await f.poll(now);
  assert.equal(f.fresh(now), false);
});
