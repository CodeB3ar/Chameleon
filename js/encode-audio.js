/* Chameleon — local audio decode/encode helpers (no build step).
   Decode via Web Audio decodeAudioData (all six inputs).
   Encode:
     WAV: hand-rolled 16-bit PCM (always available, lossless).
     MP3: vendored LAME (assets/vendor/lame.min.js) when present,
          else MediaRecorder audio/mpeg where the browser allows it.
     OGG / AAC / M4A: MediaRecorder pipeline through a
          MediaStreamDestination, gated by supportsAudioTarget().
   Capability gating mirrors encode.js supportsWebp(): unsupported targets
   render disabled with NO SUPPORT instead of breaking the convert loop.
   Everything stays on-device. */

export const AUDIO_MIME_FOR = {
  MP3: "audio/mpeg",
  WAV: "audio/wav",
  OGG: "audio/ogg",
  AAC: "audio/aac",
  M4A: "audio/mp4",
};

// Candidate MediaRecorder mime strings per target (first supported wins).
const RECORDER_MIMES = {
  MP3: ["audio/mpeg", "audio/mp3"],
  OGG: ["audio/ogg;codecs=opus", "audio/ogg;codecs=vorbis", "audio/ogg", "audio/webm;codecs=opus"],
  AAC: ["audio/aac", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"],
  M4A: ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/aac"],
  WAV: ["audio/wav"],
};

const STANDARD_BITRATES = [64, 96, 128, 160, 192, 256, 320];
export const LOSSLESS_TARGETS = ["WAV"];

let lamePromise = null;

function recorderMimeFor(target) {
  const cands = RECORDER_MIMES[target] || [];
  try {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return null;
    for (const m of cands) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m;
      } catch {
        // try next
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Runtime check: can this browser encode this audio target right now? */
export function supportsAudioTarget(target) {
  const t = String(target || "").toUpperCase();
  if (t === "WAV") return true;
  if (t === "MP3" && hasLame()) return true;
  return recorderMimeFor(t) !== null;
}

function hasLame() {
  try {
    return !!(
      window.Mp3Encoder ||
      (window.lamejs && window.lamejs.Mp3Encoder)
    );
  } catch {
    return false;
  }
}

/** Best-effort lazy load of vendored LAME (assets/vendor/lame.min.js). */
export function ensureLame() {
  if (hasLame()) return Promise.resolve(true);
  if (lamePromise) return lamePromise;
  lamePromise = new Promise((resolve) => {
    try {
      const s = document.createElement("script");
      s.src = "./assets/vendor/lame.min.js";
      s.async = true;
      s.onload = () => resolve(hasLame());
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
      // Don't hang conversion on vendor load.
      setTimeout(() => resolve(hasLame()), 4000);
    } catch {
      resolve(false);
    }
  });
  return lamePromise;
}

/** Map 1-100 slider to a standard MP3/AAC/OGG bitrate in kbps. */
export function bitrateForQuality(quality, target) {
  if (LOSSLESS_TARGETS.includes(String(target || "").toUpperCase())) return null;
  const q = Math.min(100, Math.max(1, Number(quality) || 82));
  const raw = 64 + (q / 100) * (320 - 64);
  let best = STANDARD_BITRATES[0];
  for (const b of STANDARD_BITRATES) {
    if (Math.abs(b - raw) < Math.abs(best - raw)) best = b;
  }
  return best;
}

export function bitrateLabel(quality, target) {
  const b = bitrateForQuality(quality, target);
  return b ? `${b}kbps` : "lossless";
}

/** Decode a Blob/File to an AudioBuffer. */
export async function decodeAudio(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error("webaudio-unsupported");
  let bytes;
  try {
    bytes = await blob.arrayBuffer();
  } catch {
    throw new Error("decode-failed");
  }
  // Fresh context per decode: avoids suspended-state edge cases on Safari.
  const ctx = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    return buf;
  } catch {
    throw new Error("decode-failed");
  } finally {
    try {
      await ctx.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Lightweight duration probe without a full PCM decode (for list UI).
 * Resolves seconds or null when metadata is unreadable here.
 */
export function getAudioDuration(blob) {
  return new Promise((resolve) => {
    let url = null;
    try {
      url = URL.createObjectURL(blob);
    } catch {
      resolve(null);
      return;
    }
    try {
      const el = document.createElement("audio");
      el.preload = "metadata";
      const done = (v) => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
        resolve(v);
      };
      const timer = setTimeout(() => done(null), 8000);
      el.onloadedmetadata = () => {
        clearTimeout(timer);
        const d = Number(el.duration);
        done(Number.isFinite(d) && d > 0 ? d : null);
      };
      el.onerror = () => {
        clearTimeout(timer);
        done(null);
      };
      el.src = url;
    } catch {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
      resolve(null);
    }
  });
}

export function fmtDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s || s < 0) return "";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function floatTo16PCM(view, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return offset;
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/** 16-bit PCM WAV from an AudioBuffer (respects source channels/rate). */
export function encodeWavBuffer(audioBuffer) {
  const channels = Math.min(2, audioBuffer.numberOfChannels || 1);
  const sampleRate = audioBuffer.sampleRate || 44100;
  const len = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = len * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  const tmp = [];
  for (let c = 0; c < channels; c++) tmp.push(audioBuffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, tmp[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Resample via OfflineAudioContext (used when LAME can't take the source rate). */
async function resampleBuffer(audioBuffer, targetRate) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) throw new Error("mp3-unsupported");
  const channels = Math.min(2, audioBuffer.numberOfChannels || 1);
  const srcRate = audioBuffer.sampleRate || 44100;
  const len = Math.max(1, Math.ceil((audioBuffer.length * targetRate) / srcRate));
  const ctx = new Ctx(channels, len, targetRate);
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

// Sample rates LAME accepts. Anything else (e.g. 96kHz hi-res) is resampled.
const LAME_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

/** MP3 via vendored LAME (expects window.Mp3Encoder or window.lamejs). */
async function encodeMp3Lame(audioBuffer, bitrateKbps) {
  const Enc = window.Mp3Encoder || (window.lamejs && window.lamejs.Mp3Encoder);
  if (!Enc) throw new Error("mp3-unsupported");
  let buf = audioBuffer;
  let sampleRate = audioBuffer.sampleRate || 44100;
  if (!LAME_RATES.includes(sampleRate)) {
    try {
      buf = await resampleBuffer(audioBuffer, 44100);
      sampleRate = 44100;
    } catch {
      throw new Error("mp3-unsupported");
    }
  }
  const channels = Math.min(2, buf.numberOfChannels || 1);
  const kbps = Number(bitrateKbps) || 192;
  const enc = new Enc(channels, sampleRate, kbps);
  const left = buf.getChannelData(0);
  const right = channels > 1 ? buf.getChannelData(1) : left;
  const to16 = (f) => {
    const a = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      a[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return a;
  };
  const l16 = to16(left);
  const r16 = to16(right);
  const parts = [];
  const BLOCK = 1152;
  for (let i = 0; i < l16.length; i += BLOCK) {
    const l = l16.subarray(i, i + BLOCK);
    const r = r16.subarray(i, i + BLOCK);
    const data = channels > 1 ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
    if (data && data.length) parts.push(new Int8Array(data));
  }
  const end = enc.flush();
  if (end && end.length) parts.push(new Int8Array(end));
  return new Blob(parts, { type: "audio/mpeg" });
}

/** Generic MediaRecorder re-record of an AudioBuffer. */
async function encodeViaRecorder(audioBuffer, mime, bitrateKbps) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || typeof MediaRecorder === "undefined") throw new Error("encode-unsupported");
  const ctx = new Ctx({ sampleRate: audioBuffer.sampleRate });
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  const dest = ctx.createMediaStreamDestination();
  src.connect(dest);
  const opts = { mimeType: mime };
  if (bitrateKbps) opts.audioBitsPerSecond = bitrateKbps * 1000;
  let rec;
  try {
    rec = new MediaRecorder(dest.stream, opts);
  } catch {
    try {
      await ctx.close();
    } catch {
      // ignore
    }
    throw new Error("encode-unsupported");
  }
  const chunks = [];
  const stopped = new Promise((resolve, reject) => {
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.onerror = () => reject(new Error("encode-failed"));
    rec.onstop = () => resolve();
  });
  // Watchdog: MediaRecorder clock can stall on tiny buffers.
  const timeoutMs = Math.max(3000, (audioBuffer.duration || 1) * 1000 + 2500);
  let watchdog = null;
  const timeout = new Promise((_, reject) => {
    watchdog = setTimeout(() => {
      try {
        rec.stop();
      } catch {
        // ignore
      }
      reject(new Error("encode-timeout"));
    }, timeoutMs);
  });
  try {
    rec.start(250);
    src.start(0);
    await Promise.race([stopped, timeout]);
  } finally {
    clearTimeout(watchdog);
    try {
      src.stop();
    } catch {
      // already ended
    }
    try {
      src.disconnect();
      dest.disconnect();
    } catch {
      // ignore
    }
    try {
      await ctx.close();
    } catch {
      // ignore
    }
  }
  if (!chunks.length) throw new Error("encode-failed");
  return new Blob(chunks, { type: mime.split(";")[0] });
}

/**
 * Encode a decoded AudioBuffer to target ("MP3"|"WAV"|"OGG"|"AAC"|"M4A").
 */
export async function encodeAudio(audioBuffer, target, quality) {
  const t = String(target || "").toUpperCase();
  if (!audioBuffer) throw new Error("decode-failed");
  if (t === "WAV") return encodeWavBuffer(audioBuffer);
  if (t === "MP3") {
    const kbps = bitrateForQuality(quality, "MP3") || 192;
    if (hasLame()) return encodeMp3Lame(audioBuffer, kbps);
    const mime = recorderMimeFor("MP3");
    if (mime) return encodeViaRecorder(audioBuffer, mime, kbps);
    await ensureLame();
    if (hasLame()) return encodeMp3Lame(audioBuffer, kbps);
    throw new Error("mp3-unsupported");
  }
  const kbps = bitrateForQuality(quality, t);
  const mime = recorderMimeFor(t);
  if (!mime) {
    const code =
      t === "OGG" ? "ogg-unsupported" : t === "AAC" ? "aac-unsupported" : t === "M4A" ? "m4a-unsupported" : "encode-unsupported";
    throw new Error(code);
  }
  return encodeViaRecorder(audioBuffer, mime, kbps || undefined);
}

export function extForAudio(target) {
  const t = String(target || "").toLowerCase();
  if (t === "m4a") return "m4a";
  if (t === "aac") return "aac";
  if (t === "ogg") return "ogg";
  if (t === "wav") return "wav";
  return "mp3";
}

/** "song.wav" + "MP3" -> "song.mp3". */
export function outNameAudio(srcName, target) {
  const base = String(srcName || "converted").replace(/\.[a-z0-9]+$/i, "") || "converted";
  return `${base}.${extForAudio(target)}`;
}
