import crypto from "crypto";

export function deterministicStringify(val: any): string {
  if (val === null) return "null";
  if (Array.isArray(val)) {
    return "[" + val.map(v => deterministicStringify(v)).join(",") + "]";
  }
  if (typeof val === "object") {
    const keys = Object.keys(val).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + deterministicStringify(val[k])).join(",") + "}";
  }
  return JSON.stringify(val);
}

export function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
