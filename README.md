# Tilwa | تِلوا

**Know your path · اعرف طريقك**

This repository starts with the build brief, original bilingual brand asset, supplied desktop/mobile designs and test-source manifest for the Tilwa university pilot. The brief is the starting point for the implementation.

## Start the build / بدء التنفيذ

Use [the complete Codex build prompt](docs/codex-build-prompt.md). It covers the five learning features, the database-first Gemini tutor, Arabic/English interfaces, the student/instructor/advisor demo, course assessment, multi-year memory, role authorization, a replaceable SIS and a verified Vercel Preview backed by Neon PostgreSQL.

ابدأ من [برومبت البناء الكامل](docs/codex-build-prompt.md). أول تجربة مطلوبة هي استيراد محاضرة حقيقية مع مرجع تمهيدي، ومراجعة المحتوى من حساب المدرّس، ثم اختبار الطالب ومراجعة الدليل من حساب المرشد الأكاديمي.

| Input | Location |
|---|---|
| Native bilingual logo | [PNG](public/brand/tilwa.png) |
| Supplied dashboard designs | [Desktop](design/references/desktop.png) · [Mobile](design/references/mobile.png) · [offline visual reference](design/references/workspace.html) |
| CET351 source manifest and GeeksforGeeks umbrella | [Manifest](pilot/source-manifest.json) |
| Original bilingual supplement for repeatable ingestion | [Pilot foundations](pilot/umbrella/tilwa-ml-foundations.md) |
| Original six lecture PDFs | Private input pack or [instructor folder](https://drive.google.com/drive/folders/1nJjEsAEBFeIR38snSSdiGzdRQ8jQdHCB). Use the app’s private instructor import once implemented. |

The visual reference contains synthetic UI behavior. Live acceptance requires the real application, scoped Neon retrieval, Gemini and a reviewable verification run. Keep credentials and private course files outside version control.
