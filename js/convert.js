/* Chameleon — file support checks + shared formatting (home v1).
   Images convert locally via canvas. Audio converts locally via Web Audio
   decode + WAV PCM / MediaRecorder / vendored MP3 encode. Video/docs are stubs. */

export const IMAGE_TARGETS = ["png", "jpg", "svg", "webp"];
export const AUDIO_TARGETS = ["mp3", "wav", "flac", "aac", "ogg", "m4a"];

const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
  "image/heic",
  "image/heif",
];
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".svg", ".webp", ".heic", ".heif"];
const AUDIO_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/x-mp3",
  "audio/x-mpeg",
  "audio/mpeg3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/flac",
  "audio/x-flac",
  "audio/aac",
  "audio/aacp",
  "audio/ogg",
  "audio/opus",
  "audio/x-opus",
  "audio/mp4",
  "audio/x-m4a",
  "audio/webm",
  "audio/3gpp",
  "audio/3gpp2",
];
const AUDIO_EXTS = [".mp3", ".wav", ".flac", ".aac", ".ogg", ".oga", ".opus", ".m4a", ".weba", ".3gp"];

// Extensions we can explicitly name as "coming soon" instead of "unsupported".
// NOTE: GIF is intentionally not listed anywhere — it is unsupported.
const STUB_EXTS = [
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
  const t = String(file.type || "").toLowerCase();
  if (IMAGE_TYPES.includes(t)) return true;
  if (AUDIO_TYPES.includes(t)) return true;
  const name = String(file.name || "").toLowerCase();
  return (
    IMAGE_EXTS.some((ext) => name.endsWith(ext)) ||
    AUDIO_EXTS.some((ext) => name.endsWith(ext))
  );
}

/** "stub" = recognisable format family we don't convert yet; "" = unknown. */
export function stubKind(file) {
  const ext = extOf(file && file.name);
  if (!ext) return "";
  if (!STUB_EXTS.includes(ext)) return "";
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
  if (IMAGE_TYPES.includes(t) || IMAGE_EXTS.some((e) => String(file.name || "").toLowerCase().endsWith(e)))
    return "image";
  if (AUDIO_TYPES.includes(t) || AUDIO_EXTS.some((e) => String(file.name || "").toLowerCase().endsWith(e)))
    return "audio";
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
// Audio targets encodable via encode-audio.js (WAV always; the rest gated
// per-browser by supportsAudioTarget(), mirroring supportsWebp()).
export const AUDIO_CONVERTIBLE_TARGETS = ["MP3", "WAV", "FLAC", "AAC", "OGG", "M4A"];

/**
 * Per-family target options for custom mode.
 * [{ v: "WEBP", soon: false }] — soon options render disabled with
 * `label` as the visible reason (e.g. "soon", "input only").
 */
export function targetsFor(family) {
  if (family === "audio")
    return ["MP3", "WAV", "OGG", "FLAC", "AAC", "M4A"].map((v) => ({ v, soon: false }));
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
  if (family === "audio") {
    return AUDIO_CONVERTIBLE_TARGETS.includes(globalTarget) ? globalTarget : "MP3";
  }
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
