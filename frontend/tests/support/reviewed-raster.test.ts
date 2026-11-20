import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { isReviewedRasterPair } from "./reviewed-raster.ts";

const { PNG } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle");

test("only the measured whole-frame G1 pair passes even within the observed icon bounds", () => {
  const name = "M02-post-pending-chromium-390x844-dark-tile-01.png";
  const expected = PNG.sync.read(readFileSync(new URL("../visual/baselines/" + name, import.meta.url)));
  const actual = { ...expected, data: Buffer.from(expected.data) };
  // G1 observed exactly these two edge pixels in the alternate frame.
  const offsets = [16, 35].map(x => 4 * (26 * actual.width + x));
  for (const offset of offsets) actual.data.set([22, 20, 19, 255], offset);
  assert.ok(isReviewedRasterPair(name, expected, actual));
  assert.equal(isReviewedRasterPair(name, actual, actual), false);
  assert.equal(isReviewedRasterPair("another-tile.png", expected, actual), false);
  assert.equal(isReviewedRasterPair(name, expected, { ...actual, width: 391 }), false);
  for (const offset of [offsets[0], 0]) {
    actual.data[offset]++;
    assert.equal(isReviewedRasterPair(name, expected, actual), false);
    actual.data[offset]--;
  }
});
