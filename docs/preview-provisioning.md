# Tilwa Preview provisioning / إعداد البيئة التجريبية

The provisioner creates a separate **non-production** Neon project and Vercel project. It never requests a paid plan upgrade or deploys to Production. Provider account limits still apply. This path has **not been exercised against provider accounts** in the current environment because its credentials are absent. The offline prerequisite tests are not live integration tests.

## Secure settings / الإعدادات الآمنة

Set these in secure environment settings; never paste secret values in chat:

| Setting                  | Purpose                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `NEON_API_KEY`           | API access to create/read a separate pilot project and its connection URI                                      |
| `VERCEL_TOKEN`           | Create/manage the Preview project and its Preview environment variables                                        |
| `GEMINI_API_KEY`         | Verify the selected Gemini model and run the tutor                                                             |
| `GEMINI_MODEL`           | Verified stable pilot model is `gemini-3.5-flash-lite`; availability is checked against the actual project before provisioning |
| `VERCEL_TEAM_ID`         | Optional authorized Vercel team; otherwise the token's account                                                 |
| `NEON_REGION`            | Optional Neon region; default `aws-us-east-1`                                                                  |
| `PREVIEW_GEMINI_API_KEY` | Optional raw Gemini key intended for the Vercel server if different from the local key                         |

**Proxy credentials are not portable secrets.** A cloud proxy binding may inject a real value into outgoing requests while the process holds only a placeholder. Such a placeholder must not be copied into Vercel. Use raw secret values supplied through secure process settings for this runner, or enter the Gemini key directly in Vercel's encrypted Preview settings. No key is shipped to the browser.

Required outbound destinations: `console.neon.tech`, the project's `*.neon.tech` PostgreSQL endpoint (TLS TCP 5432), `api.vercel.com`, `*.vercel.app`, and `generativelanguage.googleapis.com`. Preserve the package-manager domains already allowed. The current environment's Neon HTTP probe returned a proxy **403**, so network settings also need to permit that destination before provisioning can run.

## Run / التشغيل

```bash
PROVISION_PREVIEW=1 npm run provision:preview
```

The script first checks credentials and opt-in. With missing prerequisites it exits **2**, without creating resources. Otherwise it:

1. Verifies the requested Gemini model ID without generating a teaching answer.
2. Creates or resumes the uniquely named `tilwa-pilot-*` project and `tilwa-preview` Neon branch.
3. Runs the checked-in migrations using the migration role.
4. Creates the `tilwa_app` non-owner runtime login, grants only `tilwa_runtime`, and checks it cannot bypass row-level security.
5. Seeds synthetic demo records through the pooled runtime connection.
6. Creates or resumes the Vercel project and saves server secrets for the **Preview** target only.
7. Deploys using `vercel deploy --yes --target preview`, with the token passed through the environment.

The private receipt `.tilwa-private/provisioning.json` contains project IDs, model ID, stages and the deployed URL. The separate `.tilwa-private/provisioning-secrets.json` and `.env.preview.local` contain server secrets and are ignored by Git with filesystem mode `0600`. Preserve them to resume interrupted setup. Never commit or share them. Re-running reuses the saved projects. The migration owner connection is **not** deployed to Vercel.

A deployment URL confirms deployment, not educational acceptance. After an instructor imports and reviews the authentic lecture pack in that Preview:

```bash
# Node reads private local variables without printing them.
LIVE_SMOKE=1 LIVE_BASE_URL=https://YOUR-PREVIEW.vercel.app \
  node --env-file=.env.preview.local --import tsx scripts/live-smoke.ts
```

Supply `LIVE_WORKSPACE_CODE` securely for the workspace whose lecture pages and graph were reviewed. If Vercel Deployment Protection blocks the test client, configure an authorized bypass securely or test through an authenticated browser; do not disable protection implicitly. `npm run test:live` reports actual pass/fail/blocked outcomes. It does not silently approve source pages or substitute a deterministic model.

## SIS integration / تكامل المسجّل

`src/server/sis.ts` defines `SisPort`, `LocalDemoSisAdapter` and `ExternalContractSisAdapter`. Both feed the same tenant-scoped `demo_sis` inbox and result projections. Learning events, objective mastery and recommendations stay in Tilwa's core storage; the registrar owns only official result revisions.

To replace the local adapter, implement `SisPort.events()` against the institutional versioned contract, or use `POST /api/sis` with `SIS_WEBHOOK_SECRET` (at least 32 characters) and `SIS_TENANT_ID`. Configure these server-only; no institutional connection is claimed in the pilot. Map approved external student identifiers to local users before accepting the feed. For each JSON body, send Unix seconds in `x-sis-timestamp` and `sha256=<hex HMAC-SHA256(secret, timestamp + "." + exactBody)>` in `x-sis-signature`. Requests outside five minutes, unknown student mappings, tenant mismatches and invalid signatures are rejected.

Duplicate event IDs are idempotent. A reused event ID with different data is a conflict. Higher revisions replace projections; lower revisions are audited without overwriting newer results. Revocations set the grade to null. Same-revision changes require a new revision. The tests run both adapters against the same real local PostgreSQL engine and verify the learning records are identical after replacement; this is an **offline contract fixture**, not a live university feed.
