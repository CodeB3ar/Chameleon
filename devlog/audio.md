MP3 + WAV + OGG + AAC + M4A Support
Oct 10, 2026 — Chameleon now converts audio alongside images. All five formats decode in-browser and re-encode on-device with no uploads: Web Audio decode plus a hand-rolled WAV writer, vendored LAME for MP3, and the MediaRecorder pipeline for the rest.
• OGG encodes Opus/Vorbis through a MediaStreamDestination — the smallest files of the five
• AAC and M4A share the MP4 container path (mp4a.40.2) wherever the browser allows it
• Odd sample rates such as 96 kHz resample through OfflineAudioContext before LAME sees them
• WAV stays bit-exact 16-bit PCM and ignores the quality slider; lossy targets map it to 64–320 kbps
• Every codec failure names itself (ogg-unsupported, aac-unsupported…) in the Download view
• supportsAudioTarget disables NO SUPPORT tiles per browser while LAME preloads for MP3
