// Serves the kiosk page and its bundle (e2e/app, e2e/.work) on all interfaces, so the test can
// also open it on the LAN address, which isn't a secure context
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };

http.createServer(async (req, res) => {
  const name = path.basename(new URL(req.url, "http://x").pathname) || "index.html";
  for (const dir of ["app", ".work"]) {
    try {
      const body = await fs.readFile(path.join(here, dir, name));
      res.writeHead(200, { "content-type": types[path.extname(name)] ?? "application/octet-stream", "cache-control": "no-store" });
      return res.end(body);
    } catch {
      // not in this folder
    }
  }
  res.writeHead(404).end();
}).listen(4173, "0.0.0.0");
