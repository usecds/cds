import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "child_process";
import http from "http";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { AddressInfo } from "net";
import { Publisher, FilesystemStore } from "../server/src/index.js";

// G12: the browser entry on Deno. Needs `deno` on the PATH (or CDS_DENO=<path to deno>); skipped without
const deno = process.env.CDS_DENO ?? "deno";
const hasDeno = spawnSync(deno, ["--version"], { shell: process.platform === "win32" }).status === 0;

describe.skipIf(!hasDeno)("Deno (G12)", () => {
  let dir: string;
  let server: http.Server;
  let url: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cds-deno-"));
    await new Publisher({
      getCollections: async () => ({ snippets: [{ id: "s_welcome", key: "welcome", translations: { en: { text: "Grüße 🏨" } }, media: ["logo.png"] }] }),
      getMedia: async () => [{ virtualPath: "logo.png", content: Buffer.from([137, 80, 78, 71, 0, 255]), mimeType: "image/png" }]
    }, new FilesystemStore(dir)).publish("production", "r1");
    // The store as a CDN would serve it
    server = http.createServer(async (req, res) => {
      try {
        res.end(await fs.readFile(path.join(dir, decodeURIComponent(new URL(req.url!, "http://x").pathname))));
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("syncs a release with MemoryStorage and HttpDownloader", async () => {
    // Deno runs the TypeScript sources; --unstable-sloppy-imports maps their ".js" imports to ".ts"
    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(deno, ["run", "--quiet", "--unstable-sloppy-imports", "--allow-net=127.0.0.1", "--allow-read", "--allow-env", "tests/fixtures/deno-sync.ts", url],
        { shell: process.platform === "win32" });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({ success: true, releaseId: "r1", text: "Grüße 🏨", mediaBytes: 6 });
  }, 60_000);
});
