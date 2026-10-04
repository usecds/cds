import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;

// Bundlers (e.g. Nitro) may rewrite import.meta.url to a URL that isn't a file path;
// the schemas then aren't next to the code anyway, and the fallbacks below apply
const moduleDir = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
})();

// Helper to load schema files from the monorepo root
function loadSchema(filename: string): any {
  const possiblePaths = moduleDir
    ? [
        path.join(moduleDir, "..", "..", "schemas", "v1", filename),
        path.join(moduleDir, "..", "schemas", "v1", filename),
        path.join(moduleDir, "schemas", "v1", filename)
      ]
    : [];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    }
  }

  // Self-contained fallback schemas if path doesn't exist
  if (filename === "channel-manifest.json") {
    return {
      "type": "object",
      "properties": {
        "schemaVersion": { "type": "integer", "const": 1 },
        "channel": { "type": "string" },
        "releaseId": { "type": "string" },
        "updatedAt": { "type": "string" }
      },
      "required": ["schemaVersion", "channel", "releaseId", "updatedAt"]
    };
  }
  if (filename === "release-manifest.json") {
    return {
      "type": "object",
      "properties": {
        "schemaVersion": { "type": "integer", "const": 1 },
        "releaseId": { "type": "string" },
        "createdAt": { "type": "string" },
        "collections": { "type": "object" },
        "media": { "type": "object" }
      },
      "required": ["schemaVersion", "releaseId", "createdAt", "collections", "media"]
    };
  }
  if (filename === "collection.json") {
    return {
      "type": "object",
      "properties": {
        "schemaVersion": { "type": "integer", "const": 1 },
        "collection": { "type": "string" },
        "items": { "type": "array" }
      },
      "required": ["schemaVersion", "collection", "items"]
    };
  }

  throw new Error(`Schema file not found and no fallback: ${filename}`);
}

const channelManifestSchema = loadSchema("channel-manifest.json");
const releaseManifestSchema = loadSchema("release-manifest.json");
const collectionSchema = loadSchema("collection.json");

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const validateChannelManifestFn = ajv.compile(channelManifestSchema);
const validateReleaseManifestFn = ajv.compile(releaseManifestSchema);
const validateCollectionFn = ajv.compile(collectionSchema);

export function validateChannelManifest(data: any): void {
  const valid = validateChannelManifestFn(data);
  if (!valid) {
    throw new Error(
      `Invalid Channel Manifest: ${ajv.errorsText(validateChannelManifestFn.errors)}`
    );
  }
}

export function validateReleaseManifest(data: any): void {
  const valid = validateReleaseManifestFn(data);
  if (!valid) {
    throw new Error(
      `Invalid Release Manifest: ${ajv.errorsText(validateReleaseManifestFn.errors)}`
    );
  }
}

export function validateCollection(data: any): void {
  const valid = validateCollectionFn(data);
  if (!valid) {
    throw new Error(
      `Invalid Collection (${data.collection || "unknown"}): ${ajv.errorsText(validateCollectionFn.errors)}`
    );
  }
}
