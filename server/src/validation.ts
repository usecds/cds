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
const targetSchema = loadSchema("target.json");

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const validateChannelManifestFn = ajv.compile(channelManifestSchema);
const validateReleaseManifestFn = ajv.compile(releaseManifestSchema);
const validateCollectionFn = ajv.compile(collectionSchema);
const validateTargetFn = ajv.compile(targetSchema);

// Target-provided schemas are often partial (e.g. only "required"), so strict-mode type hints are off
const contentAjv = new Ajv({ allErrors: true, strict: false });
addFormats(contentAjv);

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

export function validateTargetDefinition(data: any): void {
  const valid = validateTargetFn(data);
  if (!valid) {
    throw new Error(
      `Invalid Target Definition (${data?.id || "unknown"}): ${ajv.errorsText(validateTargetFn.errors)}`
    );
  }
}

export interface ContentSchemaError {
  keyword: string; // e.g. "required", "minLength", "maxLength", "type"
  instancePath: string; // e.g. "/alt"
  params: Record<string, any>;
  message?: string;
}

/**
 * Compiles a JSON Schema declared in a target definition (requirements/recommendations).
 * The returned function lists all violations; an empty list means valid.
 */
export function compileContentSchema(schema: object): (data: any) => ContentSchemaError[] {
  const validate = contentAjv.compile(schema);
  return (data: any) => (validate(data) ? [] : (validate.errors as ContentSchemaError[]));
}
