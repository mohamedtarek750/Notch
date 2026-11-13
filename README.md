# Tilwa | تِلوا

**Know your path · اعرف طريقك**

**التجربة المنشورة / Hosted pilot:** [https://tilwa.vercel.app](https://tilwa.vercel.app) — افتح الرابط مباشرة، وأدخل رمز مساحة التجربة الموجودة، ثم اختر **مدرّس** أو **طالب** أو **مرشد أكاديمي**. لا يلزم تسجيل دخول Vercel؛ رمز المساحة هو الدعوة إلى الحسابات الاصطناعية. احصل عليه من الملف الخاص `.tilwa-private/demo-workspace-code` ولا تنشره.

تجربة تعليمية جامعية كاملة الطبقات بـNext.js وTypeScript، مع PostgreSQL، مصادر خاصة، وصلاحيات فعلية للطالب والمدرّس والمرشد. Gemini يعمل من السيرفر بعد التحقق من الصلاحيات واسترجاع الدليل المعتمد. بيانات الأشخاص والمؤسسة والسجل السابق اصطناعية ومعلّمة داخل التطبيق.

A bilingual university pilot with authenticated, tenant-scoped learning, private source ingestion/review, objective-level formative evidence, advising and replaceable SIS integration. The original logo, Arabic fonts and dashboard illustration/styles come from the supplied design references.

**Current acceptance — 13 November 2026:** **148/148 offline tests**, TypeScript and production build passed. Before canonical promotion, the exact deployed build passed **14/14 real HTTP/Neon checks**, including one real Gemini Recall answer (**2,023 tokens**), and **7/7 map browser checks**. The canonical domain then passed **13/13 requested HTTP/Neon checks** and **9/9 browser checks**; the repeat Gemini check was deliberately skipped, with zero further model calls. All **15 pre-existing learner-history records** and seven sources remained unchanged; two expected tutor-memory records were added by the two staged probes. [Measured results and boundaries](docs/verification.md) · [Deployment receipt](docs/evidence/hosted-pilot-deployment.json).

**Comprehensive map:** **225 concepts, 259 relationships and all 137 lecture pages** are reviewed and published in real Neon. Every concept has an approved lecture locator and an original Umbrella section (45 sections). Six bounded Gemini advisories succeeded; one invalid response was rejected before a successful retry. The complete map is the separately reviewed source inventory. See [map details and rerun commands](docs/comprehensive-map.md), [real database evidence](docs/evidence/comprehensive-map.json), and [actual Gemini traces](docs/evidence/comprehensive-gemini-traces.json). The earlier complete student/instructor/advisor journey remains documented separately in [measured verification](docs/verification.md).

**Earlier Vercel Preview acceptance:** [Open Preview](https://tilwa-git-feat-tilwa-pilot-v1-mohamedtarek750s-projects.vercel.app) — **live acceptance passed** against real Neon and Gemini in Arabic, English and mixed language. Vercel retains its existing login protection. Fresh practice, sign-out persistence, protected exams and assigned-advisor isolation passed on this deployment.

**الخريطة الكاملة:** [HTML ثنائي اللغة](docs/exports/Tilwa-CET351-approved-map.html) · [CSV](docs/exports/Tilwa-CET351-approved-map.csv) · [JSON](docs/exports/Tilwa-CET351-approved-map.json). نجحت اختبارات المتصفح على [النطاق النهائي](https://tilwa.vercel.app) **9/9**: اختباران للدخول وسبعة للخريطة والمصادر والتصدير والموبايل؛ [النتيجة الفعلية](docs/evidence/hosted-pilot-production-browser.json). افتح «خريطة المفاهيم» بنفس مساحة الديمو المراجعة.

## مسار التكيّف: من المرجع الشامل إلى مسار الطالب

هذا المسار يعمل على أي محاضرة ومرجع يرفعهما المدرّس، وكل ما ينتجه النموذج يبقى مسودة حتى يعتمده المدرّس وينشره.

1. **المصادر والاستيراد:** ارفع المحاضرة (من الحزمة أو من «محاضرات إضافية») و**المرجع الشامل** (PDF أو نص أو Markdown)، ثم اعتمد الصفحات والأقسام.
2. **مراجعة المعرفة ← استخراج المفاهيم والمتطلبات السابقة:** يقرأ النموذج كل صفحات المحاضرة المعتمدة، ثم يقترح لكل مفهوم ما يسبقه مستشهدًا بمقطع من المرجع الشامل. يرفض التطبيق آليًّا أي علاقة بلا استشهاد أو تصنع دورة أو تشير إلى خارج المحاضرة.
3. **اعتماد كل علاقة على حدة:** أبقِ العلاقة أو احذفها أو غيّر نوعها، ثم «نشر المعتمد». تظهر نسبة ما اعتمدته من اقتراحات النموذج مقياسًا لجودة الاستخراج.
4. **بنك الأسئلة:** حدّد نِسَب الأنواع والصعوبة وأسلوب الامتحان ونماذج سابقة، ثم ولّد مسودات لكل مفهوم وراجعها وانشرها. المفهوم يصبح قابلًا للقياس عند نشر أول سؤال له.
5. **الطالب:** «اختبار تشخيصي سريع» ثم «سؤال جديد»؛ يُختار المفهوم بحسب ترتيب المتطلبات السابقة والصعوبة بحسب أدائه، ويعرف المساعد مستواه وما ينقصه من متطلبات.

**الإعداد:** `GEMINI_API_KEY` و`GEMINI_MODEL` مطلوبان. اختياريًّا `GEMINI_QUESTION_MODEL` (نموذج أقوى لصياغة الأسئلة) و`GEMINI_EMBEDDING_MODEL` (الاسترجاع الدلالي، الافتراضي `gemini-embedding-001`). حد المدرّس اليومي `STAFF_DAILY_TOKEN_BUDGET` (الافتراضي 300000) و12 طلبًا في الدقيقة.

**تجربة حية (13 نوفمبر 2026)** على نص المحاضرة الخامسة الحقيقية (25 صفحة) ومرجع شامل تجريبي من عشرة أقسام، عبر Gemini الحقيقي:

- الاستخراج بـ`gemini-3.5-flash-lite`: من 7 إلى 14 مفهومًا ومن 5 إلى 8 متطلبات سابقة في 7 إلى 21 ثانية بحسب التشغيل، كلها مستشهَد بها من المرجع، ومنها سلسلة «الاحتمال الشرطي ← نظرية بايز ← بايز الساذج».
- بنك الأسئلة بـ`gemini-3.5-flash`: 8 أسئلة لمفهومين في نحو 60 ثانية (طلب لكل مفهوم)، بسيناريوهات وأرقام تتبع وصف الأسلوب. النموذج الأخف أسرع لكنه يميل إلى أسئلة التعريفات.
- المساعد: سؤال عامي عن «بايز الساذج» وسؤال عربي عن «k فردي» أُجيبا باستشهاد من الشرائح الإنجليزية، ورُفض سؤال خارج المقرر ومحاولة حقن تعليمات دون استدعاء النموذج.
- حدود ظهرت: الخدمة ترد أحيانًا بازدحام (503) فأضيفت إعادتا محاولة؛ عدد المفاهيم المستخرجة يتفاوت بين تشغيل وآخر؛ وسؤال عن «الاحتمال صفر» لم يجد صفحته لأنها تخلط موضوعين في مقطع واحد.

الاختبارات الآلية لهذا المسار في `tests/prerequisites.test.ts` وتستخدم بدائل حتمية للنموذج. بطاقة مراجعة العلاقات في الواجهة لم تُجرَّب بعد مع نتيجة حية داخل المتصفح.

## Run locally / التشغيل المحلي

Node.js 24.x (the pinned and validated runtime), npm, Chromium for browser tests.

```bash
npm ci
npm run dev:local
```

`dev:local` explicitly uses disk-persistent PostgreSQL/PGlite, applies migrations, seeds synthetic demo records and starts Next. It creates a private session-signing secret under ignored `.tilwa-private/`. It never silently substitutes local storage for Neon; local mode is refused on Vercel. Gemini remains unavailable without a real key: no mock model is used by application routes.

Open the running application using your development environment's browser. The onboarding UI has no supported public localhost Preview link.

### أسرع تجربة للأدوار

1. افتح [تِلوا](https://tilwa.vercel.app)، ثم أدخل رمز مساحة الديمو المحفوظ محليًا في `.tilwa-private/demo-workspace-code` دون مشاركته علنًا. اختر **مدرّس**: المحاضرات الست والملحق مستوردة ومراجعة بالفعل. افتح المصادر والخريطة الكاملة، ثم الجلسة والسؤال العربي/الإنجليزي. الخريطة والجلسة والسؤال الجديد المعدّل بنتيجة **70%** معتمدة ومنشورة. يمكنك توليد مقترح جديد ومراجعته قبل اعتماده؛ الدخول الحالي لا ينشئ مساحة أو يعيد تهيئة البيانات.
2. سجّل الخروج واختر **طالب** بنفس المساحة؛ يحتفظ المتصفح برمزها. افتح الجلسة المعتمدة واسأل «ليه الـRecall هنا 60%؟». افتح مصدر L4 ص18–19، ثم حل سؤال التدريب الجديد. التجربة المنشورة وPreview يحفظان البيانات في Neon؛ التشغيل المحلي الصريح يستخدم PostgreSQL/PGlite.
3. من التفضيلات احتفظ برمز المساحة للعودة من متصفح آخر؛ هو رمز وصول لحسابات الديمو الثلاثة. سجل الخروج ثم ادخل بنفس الرمز للتحقق من التقدّم.
4. اختر **مرشد أكاديمي** لمراجعة دليل الطالب المعيّن والتوصية وRubric أعماله. حساب المدرّس يستطيع متابعة الجودة والتدخلات ومراجعة الإجابات المفتوحة.

In the default local/Preview sandbox, a fresh visitor can receive a separate synthetic workspace. Production-hosted demo entry is denied by default. The explicitly configured invite-only pilot requires all three server settings: `DEMO_MODE=true`, `TILWA_ENV=pilot` and `PILOT_ACCESS_MODE=invite-only`. It accepts a valid code for an existing synthetic workspace, including its remembered HttpOnly workspace cookie; it never provisions a workspace anonymously. A non-synthetic workspace is refused, including when an old signed session exists.

في التجربة المحلية وPreview الافتراضي، يمكن إنشاء مساحة اصطناعية منفصلة للزائر الجديد. أما تجربة الإنتاج بالدعوة فتتطلب الإعدادات الثلاثة المذكورة ورمز مساحة اصطناعية موجودة مسبقًا؛ ولا تنشئ مساحة جديدة للزائر. اختيار الطالب أو المدرّس أو المرشد هنا يخص حسابات الديمو الاصطناعية، وليس تسجيل دخول رسميًا لحسابات جامعة.

Signed HttpOnly cookies identify sessions; client role headers/query params confer no authority. The workspace code is a bearer credential for all three synthetic demo roles. Server membership, course, advisor-assignment and protected-exam checks still apply. Institutional access needs verified identity-to-membership mapping, such as SSO, with those authorization and RLS controls retained. See [invite-only configuration and hosted acceptance](docs/hosted-pilot-verification.md) for the recorded deployment and checks.

## Neon, Gemini and Vercel / الإعداد والنشر

The database is designed from scratch in [migrations](migrations). **“Migrations” are the SQL commands that create Tilwa’s tables in an empty database. You do not need to supply an old database, migration files or student records.**

For the existing Neon database and the Vercel project `mohamedtarek750s-projects/tilwa`, use [deploy to existing resources](docs/existing-deployment.md). This path initializes the tables, creates the demo accounts and deploys a Preview in that project. It does not create another Neon or Vercel project and needs no Neon API key.

`deploy:existing` and `provision:preview` remain Preview-only commands. Hosting the synthetic pilot on the canonical Production domain is a separate deployment with the explicit invite-only settings described in the [hosted pilot guide](docs/hosted-pilot-verification.md). Provision and review the existing synthetic workspace before enabling that access mode; its application entry points do not create or reseed workspaces.

```bash
GEMINI_MODEL=gemini-3.5-flash-lite NEON_TRANSPORT=websocket DEPLOY_EXISTING=1 npm run deploy:existing
```

Supply the existing owner connection as `DATABASE_URL`, the Gemini key and authorized Vercel access through secure settings. The deployment command handles the schema and restricted application connection. Course PDFs are uploaded separately through the instructor interface or the private import command.

The alternative provisioner below is only for creating **new** provider resources. With authorized account credentials, the [provisioning runner](docs/preview-provisioning.md) creates isolated Neon and Vercel resources, applies the schema, creates a non-owner pooled runtime login and deploys only to Preview.

Set `NEON_API_KEY`, `VERCEL_TOKEN`, `GEMINI_API_KEY` securely; never put values in chat or Git. The pinned model is **`GEMINI_MODEL=gemini-3.5-flash-lite`**, verified through real guarded tutoring and generation in this project. `gemini-2.5-flash` returned 404 for this project; two bounded `gemini-3.8-flash` graph attempts timed out. Neither is claimed as a successful teaching model here. Preserve the existing server-only Gemini secret in Vercel Preview; cloud-proxy credential placeholders are not portable deployment keys.

```bash
PROVISION_PREVIEW=1 npm run provision:preview
```

With an existing non-production database, set server-only `DATABASE_URL` (pooled, non-owner), `MIGRATION_DATABASE_URL` (migration owner), `SESSION_SECRET` (32+ random characters), `GEMINI_API_KEY`, `GEMINI_MODEL`, `DEMO_MODE=true`, `LOCAL_DATABASE=0` in local/Preview settings. For private local `.env.local` files, load them explicitly:

```bash
NEON_TRANSPORT=websocket node --env-file=.env.local --import tsx scripts/migrate.ts
NEON_TRANSPORT=websocket node --env-file=.env.local --import tsx scripts/seed.ts
npm run build
npm run start
```

Use `NEON_TRANSPORT=websocket` for commands from this managed cloud environment; it uses the official Neon driver over verified WSS and retains real transactions/RLS. Vercel uses the default pooled PostgreSQL **TCP** transport. Existing `neon_auth` tables are preserved.

Next loads `.env.local` itself; CLI commands only read process environment unless `--env-file` is supplied. Seed is idempotent, preserving existing learner data. Schema migrations are tracked transactionally. The app fails closed when the database is unavailable.

## Sources / المصادر

[Source manifest](pilot/source-manifest.json) is authoritative for six PDF names, SHA-256 checksums and physical page counts. Original PDFs belong in private storage, never Git/public assets. Browser uploads are per-file and capped at 3.5 MB. The resumable CLI accepts a private directory or strictly bounded expected-file ZIP and imports files separately. See [source import](docs/source-import.md).

```bash
NEON_TRANSPORT=websocket LOCAL_DATABASE=0 npm run import:pack -- --tenant TENANT_UUID --user INSTRUCTOR_UUID --directory PRIVATE_DIR --register
# or --zip PRIVATE_ZIP instead of --directory
```

The GFG URL is registered as link/metadata only. It is **not** retrieved article evidence. Specifically authorized excerpts can be imported with locators/rights. The original bilingual `pilot/umbrella/tilwa-ml-foundations.md` is a separate source. L4 p.16 remains quarantined because of its unresolved class-total contradiction. L5 pp.18,21–23 now have explicitly corrected, reviewed successor extracts; original files and earlier versions remain unchanged. All six authentic PDFs now match their manifest hashes, sizes and page counts and have been imported into Neon: [integrity evidence](docs/evidence/authentic-sources.json). L4 pp.18–19 were visually inspected against the original PDF: TP=6, FN=4 and FP=20 give **60% Recall** and **≈23.1% Precision**. The complete page ledger now records 104 approved source pages (including one repeated page), 32 title/administrative exclusions, and one quarantine. The 45 original supplementary sections received agent review through the demo instructor account; this is **not institutional supervisor sign-off**.

Sources are hashed and versioned; duplicate uploads deduplicate, corrections create successor extracts and preserve historical citation IDs. Graph proposals remain pending until review/publication. Hard prerequisites reject cycles, self-loops, duplicate edges and phantom endpoints. Deterministic bilingual aliases retain concept identity. Publication and source access require course permissions.

## Modules and data contract

```mermaid
flowchart LR
  UI[AR / EN Next.js UI] --> Auth[Signed session + membership + course + exam policy]
  Auth --> DB[(Neon PostgreSQL + tenant RLS)]
  DB --> Evidence[Permitted approved source passages]
  Evidence --> Gate[Versioned server model gateway]
  Gate --> Gemini[Google Gen AI SDK]
  Gemini --> Validate[Structured output / citations / arithmetic checks]
  Validate --> UI
  DB --> Learning[Attempts / objective evidence / recommendations]
  SIS[SisPort: demo or external contract] --> Projection[Separate demo_sis result projection]
```

- Core SQL tables hold institutions/workspaces, users, memberships, course and advisor assignments, sessions, exam state, policies and audit records. A tenant-keyed typed JSONB record store holds domain objects/events with course/owner indexes. Source/version/chunk/blob/trace tables hold private material and model provenance. `demo_sis` owns integration inbox and official result projections.
- Independent calculate/choose/justify objectives; transparent first-unassisted-family baseline and tested BKT comparator. Completion, help/time and official grades remain separate.
- Deliberate-error critique stores wrong-step location and explanation; open responses need instructor moderation.
- Gradient transfer is explicitly supplemental; instructor interventions compare fresh independent item families descriptively, suppressing small groups.
- Career artifacts retain student inclusion choice and human rubric review; no employability/GPA prediction.
- Every external model call follows authorization and DB retrieval. Retrieval filters tenant/course/current version/rights/review before ranking; no web fallback, protected question keys, grade records, rosters or advisor notes in model payloads.
- SIS replacement, signed events, deduplication, revisions and revocations are documented in [SIS/provisioning](docs/preview-provisioning.md). Offline tests verify learner history and recommendations survive adapter replacement.

## Verification / الاختبارات

```bash
npm test                 # Local PostgreSQL + pure tests; model tests explicitly inject a deterministic gateway
npm run typecheck
npm run build
npm run dev:local       # Separate terminal for browser checks
npm run test:e2e         # Chromium; set CHROMIUM_PATH if needed
```

To repeat the actual non-production Preview acceptance:

```bash
LIVE_SMOKE=1 NEON_TRANSPORT=websocket LOCAL_DATABASE=0 \
  GEMINI_MODEL=gemini-3.5-flash-lite \
  LIVE_BASE_URL=https://tilwa-git-feat-tilwa-pilot-v1-mohamedtarek750s-projects.vercel.app \
  node --env-file=.env.preview.local --import tsx scripts/live-smoke.ts
```

Set `LIVE_WORKSPACE_CODE` securely for the reviewed workspace (private local code file above); do not print or commit it. Automated access to this protected Preview also needs its securely configured `VERCEL_AUTOMATION_BYPASS_SECRET`; normal browser visitors use the existing Vercel login. The live smoke makes three bounded real tutor requests (AR, EN, mixed), checks actual L4 locators/DB-first traces, verifies zero generation on out-of-scope refusal, persists an attempt across sign-out and opens assigned-advisor evidence. Missing prerequisites exit 2 and are reported as blocked. Actual reports and screenshot comparisons: [verification](docs/verification.md).

## Current limits

This is a pilot, not a deployed university service. Institutional history/QMS counts, supplementary reviewed items and SIS events are marked synthetic. Human academic review remains necessary: structured citations and arithmetic checks do not prove entailment. The lexical course-scope gate is a conservative baseline; broad multilingual adversarial coverage and formal learning-model validation require more evaluation. Production SSO, distributed ingestion workers, private object storage at scale and university SIS credentials are integration points. The initial real tutor acceptance covers the L4 example. The comprehensive graph now covers all six lectures with explicit page review; excluded and quarantined pages stay outside approved model evidence. The core Preview journey passed with real providers. The university SIS is represented by explicit local/external-contract fixtures, not a live university connection.
