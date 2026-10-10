TXT + MD + RTF + PDF + DOCX + EPUB Support
Oct 10, 2026 — Chameleon now converts documents alongside images and audio. All six formats convert on-device with no uploads, sharing a block model.
• TXT / MD / RTF via hand-rolled text transforms keeping MD tables
• PDF output via a hand-rolled A4 writer with Helvetica, ruled tables, JPEG passthrough
• PDF input via vendored pdf.js text extraction; scans fall back to on-demand OCR
• DOCX / EPUB via a hand-rolled ZIP codec with central-directory parsing
• Images and tables ride along; text outputs flatten tables, describe images
• Text has no quality axis so the slider hides, except for PDF image fidelity
