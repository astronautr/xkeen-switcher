import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cleanupNativeBrowsers } from "./native-browsers";
import metadata from "../baseline-environment.json" with { type: "json" };
export default async function verifyEnvironment() {
  try {
    const expected = `${metadata.platform}/${metadata.architecture}/node${metadata.node}`;
    const actual = `${process.platform}/${process.arch}/node${process.versions.node}`;
    if (actual !== expected)
      throw new Error(`Pinned baseline environment requires ${expected}; got ${actual}`);
    if (
      execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim() !== metadata.osBuild
    )
      throw new Error("macOS build changed; baseline comparison needs explicit environment review");
    for (const font of metadata.fonts)
      if (createHash("sha256").update(readFileSync(font.path)).digest("hex") !== font.sha256)
        throw new Error(`Baseline font changed: ${font.path}`);
    return cleanupNativeBrowsers;
  } catch (error) {
    cleanupNativeBrowsers();
    throw error;
  }
}
