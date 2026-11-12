# Visual review / مراجعة بصرية

Reviewed the actual browser renders against `design/references/desktop.png` and `design/references/mobile.png` on 2026-11-12. These screenshots use real local PostgreSQL-compatible storage (PGlite), signed demo sessions and persisted application responses. They are not evidence of a Neon or Gemini live pass.

Reproduce:

```sh
npm run dev:local
npx playwright test tests/browser/journey.spec.ts --grep 'Desktop and mobile'
```

The focused Playwright test passed: desktop viewport 1305 × 936; mobile viewport 390 × 1508; no horizontal overflow at 390 px; mobile menu opens and closes. Full-page images are taller than the viewport where the pilot's environment/data disclosure footer adds content.

- `dashboard-desktop.png`: Arabic right rail, breadcrumb/language bar, indigo resume card, original wireframe surface, three summary tiles, evidence recommendation, agenda and academic path preserve the supplied design. The supplied embedded Arabic regular/bold fonts and logo are reused. The hero begins around y=229, versus y=225 in the reference; the wider actual practice label wraps in the rail. The new sign-out control remains visible.
- `dashboard-mobile.png`: header and menu, greeting, resume card, compact tiles, recommendation, agenda and academic path use the reference order. The hero begins at y=184, matching the reference; its rendered height is about 315 px versus about 310 px in the reference. Touch controls remain usable, the tutor uses a drawer, and dialogs trap keyboard focus and close with Escape.
- Counters show actual stored evidence: a new synthetic workspace has 0 completed sessions, 0 demonstrated objectives and 0 attempts. The reference depicts a returning learner with 2 / 1 / 1. The progress fill therefore starts at zero; it changes after server-recorded completions. No learning evidence was invented to make the screenshot match.
- The recommendation explains an unassessed skill until independent answers create a dated recommendation. Original/reference metadata is kept separate from learner evidence.
- The footer explicitly labels synthetic institutional/person records and local test storage. Published content and authentic lecture ingestion remain separately governed.

This is a manual visual comparison plus viewport/interaction assertions, not a pixel-perfect image-diff pass. Minor line wrapping, a few pixels of card spacing and the additional demo controls/disclosure differ from the references. Final screenshots were refreshed after disabling the Next.js development indicator; no development overlay is present.

بالمراجعة البصرية، ترتيب وألوان وخطوط ومكونات الواجهتين قريبة من المرجعين، مع عرض أرقام التقدّم الحقيقية من قاعدة الاختبار بدل نسخ أرقام الصورة. الاختبار يتحقق من عدم وجود تمرير أفقي ومن عمل قائمة الموبايل؛ لا يُعتبر اختبار مطابقة بكسل ببكسل أو إثباتًا لاتصال Neon/Gemini.
