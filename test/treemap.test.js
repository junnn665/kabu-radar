import { test } from 'node:test';
import assert from 'node:assert/strict';
import { squarify } from '../js/treemap.js';

test('ヒートマップの敷き詰め：面積が値に比例し、はみ出さない', () => {
  const items = [6, 6, 4, 3, 2, 2, 1].map((value, i) => ({ value, id: i }));
  const r = squarify(items, 0, 0, 600, 400);
  assert.equal(r.length, 7);
  const total = 24;
  for (const t of r) {
    assert.ok(Math.abs(t.w * t.h - (t.value / total) * 600 * 400) < 1e-6);
    assert.ok(t.x >= -1e-9 && t.y >= -1e-9 && t.x + t.w <= 600 + 1e-6 && t.y + t.h <= 400 + 1e-6);
  }
  // 0 や負の値は除く
  assert.equal(squarify([{ value: 0 }, { value: 1 }], 0, 0, 10, 10).length, 1);
});
