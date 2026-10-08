/* Chameleon — conversion stub (shell build).
   No conversion yet. Answers "is this file supported?" so the shell UI can
   queue files. Real local conversion lands later. */

const TYPES = ["image/png", "image/jpeg", "image/webp"];
const EXTS = [".png", ".jpg", ".jpeg", ".webp"];

export const IMAGE_TARGETS = ["png", "jpg", "webp"];

export function isSupported(file) {
  if (!file) return false;
  if (TYPES.includes(file.type)) return true;
  const name = String(file.name || "").toLowerCase();
  return EXTS.some((ext) => name.endsWith(ext));
}

export async function convertFile(_file, _target) {
  throw new Error("Shell build — conversion is not implemented yet.");
}
