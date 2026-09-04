import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to load schema files from the monorepo root
function loadSchema(filename: string): any {
  // We look for schemas first in ../../schemas/v1/ (development/test run)
  // or inside a relative path depending on build outputs.
  const possiblePaths = [
    path.join(__dirname, "..", "..", "schemas", "v1", filename),
    path.join(__dirname, "..", "schemas", "v1", filename),
    path.join(__dirname, "schemas", "v1", filename)
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    }
  }

  throw new Error(`Schema file not found: ${filename}`);
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
