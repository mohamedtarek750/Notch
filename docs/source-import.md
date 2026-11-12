# Private CET351 import / استيراد مصادر CET351 الخاصة

The six original PDFs are identified by exact SHA-256 hashes and physical page counts in `pilot/source-manifest.json`. Keep originals in an ignored private directory, never under `public/`. `Tilwa_Pilot_Inputs.zip` is ignored by Git.

بعد إنشاء مساحة الديمو والدخول كمدرّس، استخدم معرّف المؤسسة ومعرّف المدرّس الفعليين من جلسة الديمو:

```sh
npm run import:pack -- --tenant TENANT_ID --user INSTRUCTOR_USER_ID --directory /private/CET351 --register
# Or the local ZIP. This command does not POST a complete ZIP to a Vercel Function.
npm run import:pack -- --tenant TENANT_ID --user INSTRUCTOR_USER_ID --zip /private/Tilwa_Pilot_Inputs.zip --register
```

The command verifies the instructor's active DB membership and course write permission. `--register` registers the named GFG link as metadata and ingests the original bilingual Tilwa supplement separately. It does not scrape GFG or claim that article text was retrieved. Without local originals, `--register` can run alone.

Each PDF is verified and imported separately. Six statuses are emitted and any failed file yields process exit code 1 after the remaining files are attempted. Rerun the same command after correcting a failed file; matching hashes deduplicate and preserve previous source versions. A ZIP accepts at most six flat, expected PDF names, no traversal, encrypted entries, ZIP64 or duplicate names; compressed and actual decompressed sizes are bounded. Hash checks apply after decompression.

The server parser enforces file size, page count and duration bounds. Image-only/unreadable pages and known numerical conflicts are quarantined; the instructor supplies a corrected extract before approval. Import does not approve or publish materials automatically.

Offline tests contain synthetic ZIP/PDF-shaped bytes for integrity and archive bounds. They are not authentic lecture bytes and cannot count as successful original-source import or academic PDF spot checks.
