// Words that don't describe what an image shows: camera and app prefixes, generic nouns,
// AI tool names, versioning words and month names (English and German)
const FILLER = new Set([
  "img", "image", "images", "photo", "photos", "foto", "fotos", "bild", "bilder", "pic", "pics", "picture", "pictures",
  "screenshot", "screen", "shot", "bildschirmfoto", "scan", "scans", "capture",
  "dsc", "dscn", "dscf", "pxl", "mvimg", "gopr", "dji", "vid", "video", "camera", "cam",
  "whatsapp", "telegram", "signal",
  "chatgpt", "dall", "dalle", "gemini", "generated", "midjourney", "firefly", "copilot",
  "copy", "kopie", "final", "edited", "edit", "new", "neu", "old", "alt", "untitled", "unnamed", "unbenannt",
  "download", "downloads", "file", "datei", "unknown", "default", "temp", "tmp", "test", "version", "export", "uhr",
  "jan", "january", "januar", "feb", "february", "februar", "mar", "march", "maerz", "apr", "april", "may", "mai",
  "jun", "june", "juni", "jul", "july", "juli", "aug", "august", "sep", "sept", "september", "oct", "october",
  "okt", "oktober", "nov", "november", "dec", "december", "dez", "dezember"
]);

// Recognizable defaults, used to explain why a name says nothing
const DEFAULTS: { reason: string; pattern: RegExp }[] = [
  { reason: "UUID", pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { reason: "AI tool default name", pattern: /chatgpt|dall[·.\-_ ]?e|gemini[_ -]?generated|midjourney|firefly|copilot/i },
  { reason: "screenshot default name", pattern: /screen ?shot|bildschirmfoto|capture/i },
  { reason: "messenger default name", pattern: /whatsapp|telegram|signal|^photo_\d{4}-\d{2}-\d{2}/i },
  { reason: "camera default name", pattern: /^(img|dsc[nf]?|pxl|mvimg|gopr|dji|vid)[_-]?\d|^p\d{7}/i },
  { reason: "hash or random id", pattern: /^[0-9a-f_-]{12,}$/i }
];

const STOP_WORDS = new Set(["a", "an", "the", "with", "and", "of", "on", "in", "at", "to", "ein", "eine", "einem", "einer", "der", "die", "das", "mit", "und", "von", "im", "am", "zu", "auf"]);

const baseName = (path: string) => path.split("/").pop()!.replace(/\.[^.]+$/, "");

/**
 * Explains why a media file name doesn't describe the image (camera/app/AI defaults, ids,
 * dates and numbers only), or returns undefined if it contains at least one descriptive word.
 */
export function meaninglessNameReason(fileName: string): string | undefined {
  const name = baseName(fileName);
  const words = name
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .split(/[^a-z0-9]+/)
    // ids and hashes: long hex runs with digits
    .filter((token) => !(/^[0-9a-f]{6,}$/.test(token) && /\d/.test(token)))
    // "img2034" -> "img", "2034"
    .flatMap((token) => token.match(/[a-z]+|\d+/g) ?? [])
    .filter((token) => /^[a-z]{3,}$/.test(token) && !FILLER.has(token));
  if (words.length > 0) return undefined;
  return DEFAULTS.find((d) => d.pattern.test(name))?.reason ?? "no descriptive words";
}

/**
 * A name suggestion from a text such as the alt text: its first meaningful words as a slug.
 */
export function suggestMediaName(text: string, maxWords = 5): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !STOP_WORDS.has(word))
    .slice(0, maxWords)
    .join("-");
}
