import { createHash } from "node:crypto";
import variants from "./g1-raster-variants.json" with { type: "json" };

type Raster = { width: number; height: number; data: Buffer };
const reviewed: Record<string, { width: number; height: number; original: string; alternate: string }> = variants;
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Both complete frames must be the pair independently observed on the original G1 renderer. */
export function isReviewedRasterPair(name: string, reference: Raster, actual: Raster): boolean {
  const pair = reviewed[name];
  return !!pair && pair.width === reference.width && pair.height === reference.height
    && pair.width === actual.width && pair.height === actual.height
    && pair.original === digest(reference.data) && pair.alternate === digest(actual.data);
}
