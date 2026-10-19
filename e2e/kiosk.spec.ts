import { test, expect, Page } from "@playwright/test";
import os from "os";

// What the kiosk shows once its sync has finished
async function status(page: Page) {
  await expect(page.locator("#status")).toContainText('"sync"');
  return JSON.parse((await page.locator("#status").textContent())!);
}

const lanAddress = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;

test("syncs from S3 into IndexedDB, serves the stored release while S3 is down, then gets a 304", async ({ page, browserName }) => {
  await page.goto("http://localhost:4173/");
  const first = await status(page);
  const config = await page.evaluate(() => (globalThis as any).kiosk.config);
  expect(first).toMatchObject({ secure: true, subtle: true, active: config.releaseId, sync: { success: true, updated: true } });
  await expect(page.locator("#welcome")).toHaveText("Grüße aus Zürich 🏨");
  expect(first.mediaHash).toBe(first.expectedMediaHash);

  // S3 unreachable: the reloaded page starts from IndexedDB, the sync fails, the content stays
  await page.route(`${config.s3.endpoint}/**`, (route) => route.abort());
  await page.reload();
  const down = await status(page);
  expect(down).toMatchObject({ active: config.releaseId, sync: { success: false } });
  await expect(page.locator("#welcome")).toHaveText("Grüße aus Zürich 🏨");
  expect(down.mediaHash).toBe(down.expectedMediaHash);

  // S3 back: the next poll of an unchanged channel is a conditional request, which S3 answers
  // with a 304. WebKit answers it from its HTTP cache, so the page sees a 200 with the cached body
  // there (verified through a logging proxy); Chromium passes the 304 on
  await page.unroute(`${config.s3.endpoint}/**`);
  await page.reload();
  expect((await status(page)).sync).toEqual({ success: true, updated: false });
  const manifest = page.waitForResponse((r) => r.url().endsWith("/channels/production/manifest.json"));
  const again = await page.evaluate(() => (globalThis as any).kiosk.sync());
  const response = await manifest;
  expect(response.request().headers()["if-none-match"]).toBeTruthy();
  if (browserName === "chromium") expect(response.status()).toBe(304);
  expect(again.sync).toEqual({ success: true, updated: false });
});

test("syncs on a LAN address over plain http (no secure context: no crypto.subtle, no Web Locks)", async ({ page }) => {
  test.skip(!lanAddress, "no LAN address");
  await page.goto(`http://${lanAddress}:4173/`);
  const result = await status(page);
  expect(result).toMatchObject({ secure: false, subtle: false, locks: false, sync: { success: true, updated: true } });
  await expect(page.locator("#welcome")).toHaveText("Grüße aus Zürich 🏨");
  expect(result.mediaHash).toBe(result.expectedMediaHash);
});
