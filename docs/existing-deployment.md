# Deploy to the existing Tilwa project / نشر تِلوا على المشروع الموجود

Use the existing **Tilwa Neon database** and **`tilwa` Vercel project** in `mohamedtarek750s-projects`. This workflow creates no Neon project, database, branch or Vercel project. It deploys only a **Vercel Preview**.

This command remains Preview-only even though the application also supports an explicitly configured, invite-only synthetic pilot on a Production host. That separate deployment requires an existing synthetic workspace and all three server flags: `DEMO_MODE=true`, `TILWA_ENV=pilot`, and `PILOT_ACCESS_MODE=invite-only`. Production demo entry is otherwise denied; invite-only mode does not provision workspaces. See [hosted pilot configuration and verification](hosted-pilot-verification.md). These instructions do not claim that a Production deployment has completed.

قاعدة البيانات الجديدة ممكن تكون فارغة تمامًا. أمر التهيئة ينشئ جداول التطبيق ثم يضيف حسابات وتجارب تعليمية مصطنعة. لا تحتاج ملفات بيانات طلاب أو بيانات من نظام جامعة. بعد النشر تدخل كمدرّس وترفع مواد المقرر من الواجهة.

## Secure settings / الإعدادات الآمنة

Inject the credentials through the environment's secure settings, not a shell command, source file or chat:

- `DATABASE_URL`: the existing Neon connection supplied for this pilot. An owner connection is accepted for first-time table setup. The runner creates a separate non-owner pooled login for the application when needed.
- `DATABASE_URL_UNPOOLED` or `POSTGRES_URL_NON_POOLING`: use either existing Neon alias if already supplied. There is no need to invent another database credential. The migration connection priority is `MIGRATION_DATABASE_URL`, then `DATABASE_URL_UNPOOLED`, then `POSTGRES_URL_NON_POOLING`, then `DATABASE_URL`.
- `VERCEL_TOKEN`, or a completed Vercel CLI device login using `--global-config .tilwa-private/vercel-cli`: access to the existing project and Preview settings. The runner refreshes the CLI session when needed and reads its access token only in memory.
- `GEMINI_API_KEY`: a raw server-side Google API key. `GEMINI_MODEL` defaults to the live-tested stable model `gemini-3.5-flash-lite`; actual project availability is checked before database changes.
- `SESSION_SECRET` is optional. An existing Preview value is preserved. On first setup a random value is generated in memory and sent directly to Vercel's encrypted Preview settings.

Proxy secret placeholders are not portable keys. The runner always preserves an existing `GEMINI_API_KEY` in Vercel Preview unless an explicit raw `PREVIEW_GEMINI_API_KEY` is supplied. It never copies the local `GEMINI_API_KEY` binding into Vercel. If the Preview key is absent, enter it securely in Vercel Preview settings, or inject the explicit raw Preview key securely. Never prefix server credentials with `NEXT_PUBLIC_`.

The target names are public identifiers and can be passed directly:

```bash
DEPLOY_EXISTING=1 \
VERCEL_PROJECT_NAME=tilwa \
VERCEL_TEAM_SLUG=mohamedtarek750s-projects \
npm run deploy:existing
```

Alternatively specify the existing `VERCEL_PROJECT_ID` and `VERCEL_ORG_ID`/`VERCEL_TEAM_ID`. An unknown or mismatched target stops the command instead of creating a replacement. No Neon API key is needed for this route.

## What the command does / خطوات التنفيذ

1. Checks that the required credentials are injected and that the explicit target is Preview.
2. Resolves the existing Vercel project with a read-only API call. A conflicting local project link is preserved and reported.
3. Inspects the existing PostgreSQL schema in a **read-only transaction**. Empty databases are accepted. Existing Tilwa databases must have matching migration history. Provider-managed `neon_auth` tables are excluded from this inventory and remain untouched. Unrelated application tables, incompatible schemas, unknown migrations or non-synthetic tenants stop initialization without running migrations.
4. Verifies the chosen Gemini model exists in the Google project.
5. Initializes or updates Tilwa's tables using the checked-in migrations. It does not import an existing student dataset.
6. Uses a verified non-owner runtime login when supplied. Otherwise it creates a separately named Preview login in the existing database, checks RLS and connects using Neon pooling. It never changes the password or permissions of an existing unrelated login.
7. Seeds synthetic student, instructor and advisor records through the application runtime role.
8. Writes only the necessary **Preview** environment overrides for the current feature branch, then deploys the existing Vercel project with `--target preview`. Set `VERCEL_PREVIEW_BRANCH` only when it matches the checked-out branch; the default is the actual current branch.

TLS certificate verification and PostgreSQL channel binding remain enabled. The application receives the pooled runtime URL, never the owner migration URL. Generated runtime credentials are kept in memory and Vercel's encrypted Preview configuration; the script writes no provider URL, database password, API key or token to disk. The seed command retains only its demo workspace recovery code in the ignored private directory. Existing Production variables and deployments are untouched. A variable shared between Production and Preview is preserved. The runner creates a separate override for the checked-out feature branch instead. Variables for other branches stay unchanged; only an existing override for this exact Preview branch can be updated.

Vercel CLI state is kept under the ignored `.tilwa-private/vercel-cli` directory through `--global-config`; it does not require a writable home directory. The non-secret result is saved to `.tilwa-private/existing-preview-receipt.json` and the verified project link to `.vercel/project.json`.

Repeated runs against an owner URL may create a new separately named Preview login so active deployment credentials are not rotated. To reuse one runtime login, inject the verified pooled `DATABASE_URL` and retain the owner connection under one of the supported non-pooling aliases. Old unused Preview logins can be retired by the database administrator after verifying no deployment uses them; the script does not delete roles.

## Validation / التحقق

The automated tests exercise the credential guard, connection-alias matching, read-only schema inventory against local PostgreSQL/PGlite, schema conflict refusal and isolation of Preview variable changes. They are **offline tests**. A successful command prints a Preview URL only after Vercel completes deployment. That alone does not prove the live educational journey.

After importing and reviewing the authentic CET351 lecture pack in the Preview, run:

```bash
LIVE_SMOKE=1 LIVE_BASE_URL=https://YOUR-PREVIEW.vercel.app npm run test:live
```

`LIVE_WORKSPACE_CODE` must be injected securely for that reviewed demo workspace. The smoke test uses real Neon/Gemini and checks approved L4 locators, three language modes, database-first traces, practice persistence and the assigned advisor view. Missing live credentials or sources are reported as blocked rather than passed.

For the separately deployed invite-only Production pilot, use the [hosted acceptance runner](hosted-pilot-verification.md). Its staged check can make one explicitly enabled real tutor call before promotion; the canonical check can then verify the same deployment over HTTP without another model call. Do not use the Preview deployment runner to change Production settings.

Required access is `api.vercel.com`, the deployment under `*.vercel.app`, `generativelanguage.googleapis.com`, and the selected Neon endpoint over TLS PostgreSQL on port 5432. An available database URL does not by itself establish that the environment can reach that endpoint. Connection errors are reported without printing the URL or password.

When a managed cloud environment allows HTTPS but cannot open PostgreSQL TCP connections, prefix setup and verification commands with `NEON_TRANSPORT=websocket`. This explicitly selects Neon's official serverless `Pool` over certificate-verified WSS, honors the inherited HTTPS proxy and retains interactive transactions and tenant RLS. It connects to the real database; it is not a local fallback. Vercel continues to use the default pooled PostgreSQL TCP connection. The managed `neon_auth` schema is excluded from Tilwa's inventory and left unchanged.
