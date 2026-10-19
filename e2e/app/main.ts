// A kiosk: shows its stored release at once, then syncs from S3 with the device group's key
import { CDSClient, IndexedDBStorage, SyncResult, sha256 } from "@usecds/client";
import { S3Downloader } from "../../s3/src/downloader.js";

const config = await (await fetch("config.json")).json();
const client = new CDSClient({ storage: new IndexedDBStorage({ name: "e2e-kiosk" }), downloader: new S3Downloader(config.s3) });
await client.initialize();

async function render(sync: SyncResult) {
  const media = await client.getMediaContent("logo.png");
  document.querySelector("#welcome")!.textContent = client.use("snippets").get("welcome")?.translations.en.text ?? "(no content)";
  const status = {
    secure: globalThis.isSecureContext,
    subtle: Boolean(globalThis.crypto?.subtle),
    locks: Boolean(globalThis.navigator?.locks),
    active: client.getActiveRelease()?.releaseId ?? null,
    mediaHash: media ? await sha256(media) : null,
    expectedMediaHash: client.getMediaInfo("logo.png")?.hash ?? null,
    sync: { success: sync.success, updated: sync.updated, ...(sync.error ? { error: sync.error.message } : {}) }
  };
  document.querySelector("#status")!.textContent = JSON.stringify(status);
  return status;
}

const sync = async () => render(await client.sync(config.channel));
(globalThis as any).kiosk = { sync, config };
await sync();
