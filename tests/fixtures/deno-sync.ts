// Run by tests/deno.test.ts: one sync with the browser entry in Deno (MemoryStorage + HttpDownloader)
import { CDSClient, MemoryStorage, HttpDownloader } from "../../client/src/browser.ts";

const client = new CDSClient({ storage: new MemoryStorage(), downloader: new HttpDownloader(Deno.args[0]) });
await client.initialize();
const result = await client.sync("production");
const media = await client.getMediaContent("logo.png");
console.log(JSON.stringify({
  success: result.success,
  error: result.error?.message,
  releaseId: result.releaseId,
  text: client.use("snippets").get("welcome")?.translations.en.text,
  mediaBytes: media?.length
}));
