// Validators precompiled from schemas/v1 (scripts/validators.mjs): no schema files to load and
// nothing compiled at runtime, so they run in browsers, under a strict CSP and on Workers
import * as generated from "./generated/validators.js";

interface ValidationError {
  instancePath: string;
  message?: string;
}

type ValidateFn = ((data: unknown) => boolean) & { errors?: ValidationError[] | null };

const validators = generated as unknown as Record<"validateChannelManifest" | "validateReleaseManifest" | "validateCollection", ValidateFn>;

// The same text as Ajv's errorsText()
function errorsText(errors: ValidationError[] | null | undefined): string {
  return errors?.length ? errors.map((e) => `data${e.instancePath} ${e.message}`).join(", ") : "No errors";
}

export function validateChannelManifest(data: any): void {
  const validate = validators.validateChannelManifest;
  if (!validate(data)) {
    throw new Error(`Invalid Channel Manifest: ${errorsText(validate.errors)}`);
  }
}

export function validateReleaseManifest(data: any): void {
  const validate = validators.validateReleaseManifest;
  if (!validate(data)) {
    throw new Error(`Invalid Release Manifest: ${errorsText(validate.errors)}`);
  }
}

export function validateCollection(data: any): void {
  const validate = validators.validateCollection;
  if (!validate(data)) {
    throw new Error(`Invalid Collection (${data.collection || "unknown"}): ${errorsText(validate.errors)}`);
  }
}
