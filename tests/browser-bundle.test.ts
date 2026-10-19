import { describe, it, expect } from "vitest";
import fs from "fs";
import zlib from "zlib";
import { builtinModules } from "module";
import { build } from "esbuild";
// @ts-expect-error: a plain ES module script without types
import { generateValidators, outFile } from "../client/scripts/validators.mjs";

// G12: what a browser or edge bundler gets from @usecds/client
const BUDGET_GZIP = 15_626; // bytes: the first measurement (14,205) plus 10%

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

async function bundle(entry: string, conditions: string[]) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    conditions,
    format: "esm",
    minify: true,
    write: false,
    logLevel: "silent",
    plugins: [{
      name: "no-node-builtins",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) =>
          NODE_BUILTINS.has(args.path) ? { errors: [{ text: `Node built-in "${args.path}" imported by ${args.importer}` }] } : undefined);
      }
    }]
  });
  return result.outputFiles[0].text;
}

describe("Browser bundle of @usecds/client (G12)", () => {
  it("has no Node built-ins, no Buffer, no eval, and fits the size budget", async () => {
    const code = await bundle("client/src/browser.ts", ["browser"]);
    expect(code).not.toMatch(/\bBuffer\b/);
    expect(code).not.toMatch(/\beval\(|\bnew Function\(/);
    const gzip = zlib.gzipSync(code).length;
    console.log(`@usecds/client browser bundle: ${code.length} bytes minified, ${gzip} gzip (budget ${BUDGET_GZIP})`);
    expect(gzip).toBeLessThanOrEqual(BUDGET_GZIP);
  });

  it("the Node entry would pull in the filesystem (the check works)", async () => {
    await expect(bundle("client/src/index.ts", [])).rejects.toThrow(/Node built-in "fs/);
  });

  it("the package's browser, worker and deno conditions resolve to the browser entry", () => {
    const pkg = JSON.parse(fs.readFileSync("client/package.json", "utf-8"));
    for (const condition of ["browser", "worker", "workerd", "deno"]) {
      expect(pkg.exports["."][condition]).toEqual({ types: "./dist/browser.d.ts", default: "./dist/browser.js" });
    }
    expect(pkg.exports["."].default).toBe("./dist/index.js");
  });

  it("the precompiled validators match schemas/v1", async () => {
    const normalize = (s: string) => s.replace(/\r\n/g, "\n");
    expect(normalize(fs.readFileSync(outFile, "utf-8")), "run `pnpm --filter @usecds/client validators`")
      .toBe(normalize(await generateValidators()));
  });
});
