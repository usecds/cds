import fs from "fs/promises";
import path from "path";
import { RemoteDownloader } from "../client/src/index.js";

// Reads a FilesystemStore directory directly
export function downloaderFor(dir: string): RemoteDownloader {
  const read = (...p: string[]) => fs.readFile(path.join(dir, ...p));
  return {
    fetchChannelManifest: async (channel) => ({ manifest: JSON.parse((await read("channels", channel, "manifest.json")).toString()) }),
    fetchReleaseManifest: async (id) => JSON.parse((await read("releases", `${id}.json`)).toString()),
    fetchObject: async (hash) => (await read("objects", `${hash}.json`)).toString("utf-8"),
    fetchMedia: async (hash, ext) => read("media", `${hash}${ext}`)
  };
}
