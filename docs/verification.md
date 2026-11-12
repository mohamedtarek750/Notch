# Verification / نتائج التحقق

Run date: **12 November 2026**. This report distinguishes actual local SQL/browser behavior from unavailable live services. Full test names and outcomes are in [verification.json](evidence/verification.json).

| Check                                    | Result                           | What actually ran                                                                                                                                        |
| ---------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations                               | PASS                             | `001_core.sql`, `002_sources.sql`, `004_sis.sql` on a new local PostgreSQL/PGlite database; rerun was idempotent                                         |
| Demo seed                                | PASS                             | Two seeds reused the same workspace; production browser checks also created separate synthetic workspaces                                                |
| Unit/integration tests                   | 89 PASS, 0 failed, 0 skipped     | Local SQL, non-owner RLS, deterministic injected model replay, synthetic PDF fixtures; **not Neon/Gemini**                                               |
| TypeScript                               | PASS                             | `npm run typecheck`                                                                                                                                      |
| Production build                         | PASS                             | Next.js 16.4.6 / React 19 / Node 24, all application/API routes compiled                                                                                 |
| Production browser journeys              | 7 PASS                           | System Chromium, real HTTP, signed sessions and production Next.js server; local persistent PostgreSQL, no model simulation in application routes        |
| Desktop/mobile visual check              | PASS with documented differences | Actual 1305px/390px renders inspected against supplied reference images; no horizontal overflow; actual progress counts replace reference fixture counts |
| Provisioner prerequisite guard           | PASS                             | Missing credentials return exit 2; no resources created                                                                                                  |
| Live Neon + Gemini                       | BLOCKED, not run                 | Missing `NEON_API_KEY`/database, `GEMINI_API_KEY` and project model verification                                                                         |
| Authentic six lecture checksums/pages    | BLOCKED, not run                 | No private attachment bytes available; Drive request returned proxy CONNECT 403                                                                          |
| Actual L4 pp.18–19 academic verification | BLOCKED, not run                 | Original PDF unavailable. Exact “Recall 60%” request abstains without reviewed L4 evidence                                                               |
| Vercel Preview                           | BLOCKED, not deployed            | `VERCEL_TOKEN`/authorized account access absent. There is no Preview URL yet                                                                             |
| University SIS                           | NOT CONNECTED                    | Local-demo / external-contract fixtures only; signed adapter contract and preservation tested                                                            |

## Seven production browser journeys

1. Calculate Recall correctly, choose a poor metric and retain separate objective evidence in AR/EN.
2. Identify a deliberate solution error, explain it, moderate the explanation as instructor, then attempt an optional gradient-transfer task.
3. Submit an assignment, save custom formative feedback, submit a selected career artifact and review its rubric as assigned advisor.
4. Create a bilingual teaching intervention and verify QMS **18/24 = 75% attainment**, **24/30 = 80% coverage** and small-group suppression.
5. Student UI login, source lesson, atomic retry, sign-out and recovery in a new browser context; switch RTL/LTR.
6. Role denial, instructor-controlled protected exam across browser contexts, advisor assignment visibility.
7. Desktop/mobile dashboard screenshots, mobile navigation and overflow check.

These demonstrate local application behavior. They do not establish live Neon persistence or Gemini answer quality.

## Source truth / حقيقة المصادر

- **GFG reference registration:** verified in SQL tests. It remains link/metadata by default.
- **Approved GFG article text actually used:** **no**. Manual import of separately authorized passages with section locators and rights attestation is implemented and tested using a synthetic passage, not scraped article content.
- **Original Tilwa supplement ingestion:** verified from the actual repository file, including hash and section locators.
- **Supplement plus real lecture ingestion:** blocked by missing original PDF bytes. Parser/ZIP/hash/quarantine behavior uses explicitly synthetic PDF fixtures in tests.
- **L4 p.16 and L5 pp.18,21–23:** quarantined by ingestion rules, pending academic correction/review.
- **Gemini model:** candidate `gemini-2.5-flash`; actual project availability and generated teaching answers remain unverified. The provisioner performs a real model lookup before deployment when configured.

## Security evidence

Tests execute under a non-owner `tilwa_runtime` role, including cross-tenant denial, revoked membership/enrollment, unassigned advisor denial, course policy lookup, protected exams, current source versions and rights. Trace tests prove retrieval precedes injected generation and denials/database outages cause zero generation calls. A second authorization check rejects responses if exam/assignment state changes during generation. Shared reviewed items never expose private answer keys in student selection payloads.

Source corrections preserve previous citation IDs. Reviewed graph rename/merge/split operations preserve historical attempts/mastery/recommendations; split successors start unassessed. SIS duplicate/out-of-order/revised/revoked events cannot overwrite formative history. Tutor-memory correction/archive/delete is user-scoped and does not erase mastery.

Scope filtering uses a versioned lexical baseline, structured output validation and bounded arithmetic/academic checks. This is not a general proof of semantic entailment. Real academic spot checks with the original lectures and an actual Gemini model remain necessary.

## Rerun / إعادة الاختبار

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:production
```

Create external resources after securely supplying `NEON_API_KEY`, `VERCEL_TOKEN`, `GEMINI_API_KEY` and allowing the required destinations:

```bash
PROVISION_PREVIEW=1 npm run provision:preview
```

Then import the six original PDFs, review/publish L4 pp.18–19 and the supplement, publish bilingual teaching items, set the reviewed workspace's `LIVE_WORKSPACE_CODE`, and run:

```bash
LIVE_SMOKE=1 LIVE_BASE_URL=https://YOUR-PREVIEW.vercel.app \
  node --env-file=.env.preview.local --import tsx scripts/live-smoke.ts
```

The provisioner and live integration path are prepared but have **not** been exercised on provider accounts. Consult [provider setup](preview-provisioning.md) for secure credentials, network/TCP access, resumable receipts and deployment protection.

## Images

[Desktop render](evidence/dashboard-desktop.png) · [Mobile render](evidence/dashboard-mobile.png) · [Visual comparison notes](evidence/visual-review.md).

Cloud environment draft requirements were saved for review. No cloud environment publication was performed in this implementation turn. Publication, a Vercel deployment and a successful live acceptance run are separate outcomes.
