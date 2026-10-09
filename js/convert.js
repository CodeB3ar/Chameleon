/* Chameleon — file support checks + shared formatting (home v1).
   Images convert locally via canvas. Audio/video/docs are stubs for now. */

export const IMAGE_TARGETS = ["png", "jpg", "svg", "webp"];

const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
  "image/heic",
  "image/heif",
];
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".svg", ".webp", ".heic", ".heif"];

// Extensions we can explicitly name as "coming soon" instead of "unsupported".
// NOTE: GIF is intentionally not listed anywhere — it is unsupported.
const STUB_EXTS = [
  ".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a",
  ".mp4", ".mov", ".webm", ".mkv", ".avi",
  ".pdf", ".docx", ".txt", ".rtf", ".epub", ".md",
  ".bmp", ".tiff", ".tif",
];

export function extOf(name) {
  const n = String(name || "").toLowerCase();
  const i = n.lastIndexOf(".");
  return i >= 0 ? n.slice(i) : "";
}

export function isSupported(file) {
  if (!file) return false;
  if (IMAGE_TYPES.includes(file.type)) return true;
  const name = String(file.name || "").toLowerCase();
  return IMAGE_EXTS.some((ext) => name.endsWith(ext));
}

/** "stub" = recognisable format family we don't convert yet; "" = unknown. */
export function stubKind(file) {
  const ext = extOf(file && file.name);
  if (!ext) return "";
  if (!STUB_EXTS.includes(ext)) return "";
  if ([".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"].includes(ext)) return "audio";
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(ext)) return "video";
  if ([".pdf", ".docx", ".txt", ".rtf", ".epub", ".md"].includes(ext)) return "document";
  return "image";
}

/** Family of a file for grouping: "image" | "audio" | "video" | "document" | "". */
export function familyOf(file) {
  if (!file) return "";
  // GIF and AVIF are unsupported — never recognise them, even via generic image/* sniffing.
  const ext = extOf(file.name);
  const t = String(file.type || "").toLowerCase();
  if (ext === ".gif" || t === "image/gif") return "";
  if (ext === ".avif" || t === "image/avif") return "";
  if (isSupported(file)) return "image";
  const kind = stubKind(file);
  if (kind) return kind;
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("video/")) return "video";
  return "";
}

/** True for files we recognise (convertible or listable stub). */
export function isKnown(file) {
  return familyOf(file) !== "";
}

// Targets actually encodable today (canvas pipeline + SVG wrapper).
// HEIC is input-only: no browser encodes it via canvas.
export const CONVERTIBLE_TARGETS = ["PNG", "JPG", "SVG", "WEBP"];

/**
 * Per-family target options for custom mode.
 * [{ v: "WEBP", soon: false }] — soon options render disabled with
 * `label` as the visible reason (e.g. "soon", "input only").
 */
export function targetsFor(family) {
  if (family === "audio") return ["MP3", "WAV", "FLAC"].map((v) => ({ v, soon: true, label: "soon" }));
  if (family === "video") return ["MP4", "MOV", "WEBM"].map((v) => ({ v, soon: true, label: "soon" }));
  if (family === "document") return ["PDF", "DOCX", "TXT"].map((v) => ({ v, soon: true, label: "soon" }));
  return [
    { v: "PNG", soon: false },
    { v: "JPG", soon: false },
    { v: "SVG", soon: false },
    { v: "WEBP", soon: false },
    { v: "HEIC", soon: true, label: "input only" },
  ];
}

/** Sensible default target for a freshly added file. */
export function defaultTargetFor(family, globalTarget) {
  if (family === "image") {
    return CONVERTIBLE_TARGETS.includes(globalTarget) ? globalTarget : "WEBP";
  }
  if (family === "audio") return "MP3";
  if (family === "video") return "MP4";
  if (family === "document") return "PDF";
  return globalTarget;
}

export function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
