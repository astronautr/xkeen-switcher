import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../support/test";
import { createScenario, marker, openApp } from "../support/scenario";

// setRangeText models the native preedit buffer before an input event publishes a draft.
async function beginComposition(field: Locator, preedit: string) {
  await field.focus();
  await field.evaluate((node: HTMLInputElement | HTMLTextAreaElement, text) => {
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    node.setRangeText(text, 0, node.value.length, "end");
    node.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
  }, preedit);
}

async function poll(page: Page, endpoint: string, interval: number) {
  const response = page.waitForResponse((res) => new URL(res.url()).pathname === endpoint && res.ok());
  await page.clock.runFor(interval);
  await (await response).finished();
  await page.clock.runFor(20);
}

test("X02 composition protects an input after focus moves and ordinary values resume afterwards", async ({ page, baseURL }) => {
  const scenario = createScenario("IME subscription");
  await openApp(page, scenario, baseURL!);
  const toggle = marker(page, "subscription-toggle");
  await toggle.click();
  const field = marker(page, "subscription-home-url");
  await expect(field).toHaveValue(scenario.state.status.subscription_url);
  await beginComposition(field, "仮");
  await toggle.focus();

  const remote = "https://updated.example.invalid/feed";
  scenario.state.status.subscription_url = remote;
  await poll(page, "/api/status", 11000);
  await expect(toggle).toBeFocused();
  await expect(field).toHaveValue("仮");

  await field.dispatchEvent("compositionend", { data: "" });
  await poll(page, "/api/status", 11000);
  await expect(field).toHaveValue(remote);
  await expect(toggle).toBeFocused();
});

test("X02 focused routing textarea keeps its IME buffer, text child and selection while polling and resizing", async ({ page, baseURL }) => {
  const scenario = createScenario("IME routing");
  await page.setViewportSize({ width: 900, height: 844 });
  await openApp(page, scenario, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "routing-add").click();
  const field = marker(page, "condition-0");
  await field.fill("draft.example");
  const original = await field.evaluateHandle((node: HTMLTextAreaElement) => {
    // The browser reflects a textarea's default value through its text child.
    node.defaultValue = node.value;
    return { node, child: node.firstChild, text: node.textContent };
  });
  expect(await original.evaluate(({ child, text }) => child?.nodeValue === "draft.example" && text === child.nodeValue)).toBe(true);
  await beginComposition(field, "draft.仮");
  await field.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 6, "backward"));
  await page.setViewportSize({ width: 390, height: 844 });
  scenario.state.status.last_update_status = "fail";
  await poll(page, "/api/routing", 31000);
  await expect(field).toBeFocused();
  expect(await original.evaluate(({ node, child, text }) => ({
    connected: node.isConnected,
    sameChild: node.firstChild === child && node.textContent === text,
    value: node.value,
    selection: [node.selectionStart, node.selectionEnd, node.selectionDirection],
  }))).toEqual({ connected: true, sameChild: true, value: "draft.仮", selection: [2, 6, "backward"] });
  // Browsers can also publish intermediate composing input, then begin another preedit.
  const intermediateChild = await field.evaluateHandle((node: HTMLTextAreaElement) => {
    node.setRangeText("draft.に", 0, node.value.length, "end");
    node.dispatchEvent(new InputEvent("input", { bubbles: true, data: "に", inputType: "insertCompositionText", isComposing: true }));
    node.setRangeText("draft.にほ", 0, node.value.length, "end");
    return node.firstChild;
  });
  await page.setViewportSize({ width: 900, height: 844 });
  await poll(page, "/api/routing", 31000);
  await expect(field).toHaveValue("draft.にほ");
  expect(await field.evaluate((node, child) => node.firstChild === child, intermediateChild)).toBe(true);
  await field.evaluate((node: HTMLTextAreaElement) => {
    node.setRangeText("draft.日本", 0, node.value.length, "end");
    node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
    node.dispatchEvent(new InputEvent("input", { bubbles: true, data: "日本", inputType: "insertText" }));
  });
  await poll(page, "/api/routing", 31000);
  await expect(field).toHaveValue("draft.日本");
  await expect(field).toBeFocused();
  expect(scenario.count("PUT", "/api/routing/draft")).toBe(0);
});
