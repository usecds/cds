import { configDefaults, defineConfig } from "vitest/config";

// e2e/ is Playwright's (pnpm test:e2e)
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"]
  }
});
