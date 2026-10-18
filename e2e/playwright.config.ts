import { defineConfig } from "@playwright/test";

// G12 end to end: a kiosk page in Chromium and WebKit syncs from S3 into IndexedDB.
// Needs an S3 server and the same CDS_S3_TEST_* variables as tests/s3.test.ts (see e2e/README.md).
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  workers: 1,
  timeout: 60_000,
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } }
  ],
  webServer: {
    command: "node server.mjs",
    url: "http://localhost:4173/",
    reuseExistingServer: false
  }
});
