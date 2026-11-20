import { readFile } from "node:fs/promises";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { marker } from "./scenario";

export async function verifyRoutingRoundTrip(page: Page, context: BrowserContext) {
  async function applyAndConfirm() {
    const response = page.waitForResponse(res =>
      res.url().endsWith("/api/routing/apply") && res.request().method() === "POST");
    await marker(page, "review-apply").click();
    const submitted = await response;
    expect(submitted.ok()).toBe(true);
    const { operation_id } = submitted.request().postDataJSON();
    await expect(marker(page, "operation-refresh")).toHaveText("back to rules");
    const journal = await context.request.get("/api/routing/operations/" + operation_id);
    expect(await journal.json()).toMatchObject({ phase: "committed", id: operation_id });
  }
  const original = await (await context.request.get("/api/routing")).json();
  const path = "/api/routing/history/" + original.current.id + "/download";
  const bytes = await (await context.request.get(path)).body();
  expect(bytes.includes(Buffer.from("\r\n"))).toBe(true);
  expect(bytes.includes(Buffer.from("//"))).toBe(true);
  await page.goto("/");
  await marker(page, "nav-routing").click();
  await marker(page, "routing-add").click();
  await marker(page, "rule-name").fill("Local fixture rule");
  await marker(page, "condition-0").fill("fixture.example");
  await marker(page, "routing-save-draft").click();
  await marker(page, "draft-review").click();
  await applyAndConfirm();
  await marker(page, "operation-versions").click();
  await marker(page, "version-" + original.current.id).click();
  const download = page.waitForEvent("download");
  await marker(page, "version-download").click();
  expect(await readFile((await (await download).path())!)).toEqual(bytes);
  await marker(page, "version-restore").click();
  await applyAndConfirm();
  const restored = await (await context.request.get("/api/routing")).json();
  expect(restored.current.sha256).toBe(original.current.sha256);
  expect(
    await (await context.request.get("/api/routing/history/" + restored.current.id + "/download")).body(),
  ).toEqual(bytes);
}
