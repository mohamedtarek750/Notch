# CET351 comprehensive concept map / خريطة المفاهيم الشاملة

The reviewed inventory covers **225 concepts, 259 relationships and all 137 physical pages** of the six supplied lectures. Each concept links to an approved lecture page and a specific section of the **45-section original bilingual Tilwa Umbrella supplement**. The page ledger distinguishes 104 source pages approved after review, 32 excluded title/administrative pages, and one quarantined page: L4 p.16, whose stated class totals conflict with its cells.

تضم الخريطة 225 مفهوماً و259 علاقة، مع سجل مراجعة للصفحات الـ137. يرتبط كل مفهوم بصفحة من المحاضرات وقسم محدد من المرجع المساند. 180 مفهوماً مشروحاً و45 موضوعاً ورد اسمه فقط؛ تبقى الشروح التكميلية منفصلة عن ادعاء ما درّسته المحاضرة. صفحة L4/16 المعزولة لا تدخل الأدلة المعتمدة.

The graph contains 251 related links, five narrowly scoped calculation prerequisites and three optional bridges. The two existing comparison/reference-group concepts keep their previous IDs and the denominator calculation prerequisite. Publication preserves historical releases and learner records and awards no mastery automatically.

## Provenance and review

- The six authentic PDFs remain private and byte-identical. Eighty-two complete extraction replacements restore figure text or explicitly correct reviewed claims; original files and old citation IDs remain available.
- U1–U5 are unchanged. U6–U45 are original Arabic/English explanations, with a checked manifest hash and explicit per-section review decisions.
- GeeksforGeeks is registered separately. Each concept has an appropriate link from the actual supplied index or an explicitly labelled general-index fallback. **No GFG article body was imported, approved as evidence or sent to Gemini.**
- The comprehensive inventory and bilingual summaries were authored/reviewed by implementation agents under the authorized demo instructor account. This is **not institutional human sign-off**.
- Six successful bounded real Gemini advisories use two approved pages per lecture plus two original Umbrella sections. They remain pending review and are recorded as generation provenance. The complete map is the separately reviewed source inventory; it is not claimed to be a 225-concept Gemini output.

## Use and download

Open the deployed Preview, sign in using the existing reviewed demo workspace, then choose **خريطة المفاهيم / Concept map**. Search in Arabic or English, filter L1–L6, select a concept and open both source locators. The accessible list contains all concepts. JSON, CSV and bilingual HTML downloads always contain the entire approved map, even while a lecture filter is active.

The standalone HTML includes all concept explanations, source locators, typed relationships and the complete page ledger. Reading the downloaded map needs no login; opening private source passages requires an authorized Tilwa session. The exports contain no raw lecture passages, question keys or student records.

## Reproduce the reviewed publication

The reviewed private inputs and originals stay under ignored `.tilwa-private/`. They are required for a publication replay; the application and exported map do not depend on local files after the release is stored in Neon. The reusable scripts contain no private lecture text or credentials.

```bash
npx tsx scripts/build-comprehensive-inventory.ts
npx tsx scripts/publish-comprehensive-map.ts --validate
NEON_TRANSPORT=websocket LOCAL_DATABASE=0 npx tsx scripts/publish-comprehensive-map.ts --sources
NEON_TRANSPORT=websocket LOCAL_DATABASE=0 GEMINI_MODEL=gemini-3.5-flash-lite npx tsx scripts/publish-comprehensive-map.ts --advisories
NEON_TRANSPORT=websocket LOCAL_DATABASE=0 npx tsx scripts/publish-comprehensive-map.ts --publish
```

Source revision, review, advisory generation and graph publication are checkpointed separately. Successful calls are reused. Input hashes are pinned before mutation, and changed inputs require a new reviewed run rather than silently resuming an old one. The script compares hashes of existing learner records before and after publication.

For the protected Preview's real browser/export check, configure the authorized bypass securely and run:

```bash
TILWA_BASE_URL=https://YOUR-PREVIEW.vercel.app \
TILWA_WORKSPACE_CODE_FILE=.tilwa-private/demo-workspace-code \
node scripts/check-map-browser.mjs
```

This browser check makes **zero Gemini calls**. Its report is separate from the real Gemini advisory traces and from the [128 offline test results](evidence/comprehensive-offline-tests.json), which use local PostgreSQL/PGlite and injected deterministic model fixtures where needed.
