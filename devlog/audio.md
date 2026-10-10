MP3 + WAV + OGG + AAC + M4A Support
Oct 10, 2026 — Chameleon now converts audio alongside images. All five formats decode in-browser and re-encode on-device with no uploads, using Web Audio plus vendored MP3.
• Decode everything via decodeAudioData to an AudioBuffer in a fresh context
• WAV output via a hand-rolled lossless 16-bit PCM RIFF writer
• MP3 output via vendored LAME blocks, lazy-loaded by ensureLame
• OGG / AAC / M4A output via a MediaRecorder pipeline through MediaStreamDestination
• Quality slider maps lossy targets to 64–320 kbps; WAV ignores it
• supportsAudioTarget gating marks unsupported targets NO SUPPORT without breaking the loop
