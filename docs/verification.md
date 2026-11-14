# Verification / نتائج التحقق

## Current hosted pilot — 13 November 2026 / التجربة المنشورة الحالية

**[https://tilwa.vercel.app](https://tilwa.vercel.app) is live** with invite-only access to an existing synthetic workspace. The root page is publicly reachable without Vercel login; data access requires its private workspace code. Build `a8f229e6e30015a5049cf26a490362633f9f4d9b` was accepted on a staged Production deployment and promoted **without rebuilding**. [Deployment receipt](evidence/hosted-pilot-deployment.json).

| Check | Result | Evidence and actual boundary |
| --- | --- | --- |
| Current automated suite | **148/148 PASS** | Local PostgreSQL/PGlite and injected provider fixtures; **offline**, not live Neon/Gemini. [Every result](evidence/hosted-pilot-offline-tests.json) |
| TypeScript / production build | **PASS** | Node.js 24.x; recorded with the offline test evidence |
| Staged Production HTTP / Neon | **14/14 PASS** | Three invited roles, invitation refusal without tenant creation, role permissions, all 149 approved locators, advisor evidence and persisted progress; one real tutor call. [Report](evidence/hosted-pilot-staged.json) |
| Staged Production map browser | **7/7 PASS** | Real Chromium/Neon: all 225 concepts and 259 relationships, six lecture filters, AR/EN source jumps, accessible list, 390px RTL/LTR and exports; **zero model calls**. [Report](evidence/hosted-pilot-staged-browser.json) |
| Canonical-domain HTTP / Neon | **13/13 requested checks PASS** | One live-Gemini check intentionally **SKIPPED** after promotion of the already accepted build; **zero model calls**. [Report](evidence/hosted-pilot-production.json) |
| Canonical-domain browser | **9/9 PASS** | Two AR/EN invitation-login checks and seven full-map/source/export/mobile checks using real Chromium and Neon; **zero model calls**, zero learning attempts and no runtime errors. [Report](evidence/hosted-pilot-production-browser.json) |
| Existing history and sources | **PASS** | All **15 existing records unchanged**, no missing records, all **7 sources unchanged**. Two expected `tutor_memory` records were added by the staged probes; auth sessions/model traces are outside this snapshot. [Read-only Neon comparison](evidence/hosted-pilot-history.json) |

The completed staged tutor check used **one real `gemini-3.5-flash-lite` call and 2,023 tokens**, answering the Arabic Recall question with openable **L4 p.19 and Umbrella U29** citations. A persisted Neon trace and a pre-call source snapshot verified retrieval before generation; progress remained unchanged. An earlier, superseded staged check was interrupted during credential cleanup: its provider call completed with **2,002 tokens**, but full HTTP answer/citation acceptance was not captured. It is recorded as **interrupted, not passed**, and explains the other added tutor-memory record. [Superseded-stage record](evidence/hosted-pilot-superseded-stage.json). These two calls are separate from the historical Preview calls below.

اختبار النطاق النهائي لم يُعِد استدعاء Gemini بعد ترقية البناء نفسه. النتيجة الفعلية للنموذج جاءت من الاختبار المرحلي المكتمل، بينما فحص النطاق النهائي تحقّق من الدخول والصلاحيات والمصادر واستمرار التقدّم. هذه حسابات ديمو اصطناعية وليست ربطًا بهوية جامعة أو SIS حي.

## Earlier comprehensive release and initial acceptance / الإصدار السابق والقبول الأولي

**Comprehensive map extension:** 225/225 concepts paired with approved lecture and Umbrella locators, 259 relationships, 137/137 reviewed pages, 103/103 teaching/figure pages mapped, and 45 original bilingual supplementary sections. Real Neon publication preserved all 14 existing learner records unchanged. [Publication evidence](evidence/comprehensive-map.json). Six real Gemini advisories succeeded from seven attempts; the rejected output was never published, and the retry succeeded. Successful calls used 11,351 tokens; failed-call usage is unknown. All seven traces show retrieval before generation, with four bounded evidence chunks per call. [Provider traces](evidence/comprehensive-gemini-traces.json). **128 offline tests passed**, with a further 46-test publication regression; these use local PostgreSQL and injected model fixtures. [Every offline result](evidence/comprehensive-offline-tests.json). See [complete map scope and replay](comprehensive-map.md).

The final comprehensive map also passed **7/7 real Vercel/Neon browser checks**, including all concepts, six lecture filters, bilingual source jumps, the accessible list, mobile layout and complete HTML/JSON/CSV exports. [Browser evidence and access cleanup](evidence/comprehensive-preview-browser.json). The post-publication real tutor regression returned **6/(6+4)=60%** with L4 pp.18–19 citations, using one Gemini call and 1,635 tokens; [direct guarded-server test](evidence/comprehensive-tutor-regression.json). [Download the full map](exports/Tilwa-CET351-approved-map.html).

The table below records the **earlier initial pilot journey**, retained as historical acceptance evidence; its two-concept graph and U1–U5 scope have been superseded by the comprehensive release above.

Current results: **13 November 2026**. Local automated tests, real provider calls and Preview readiness are reported separately. All learner/staff records are synthetic.

| Check                                   | Result                       | Evidence and scope                                                                                                                                                                                                                  |
| --------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit/integration suite                  | **110/110 PASS**             | Local PostgreSQL/PGlite, non-owner RLS, injected deterministic model replay and synthetic parser fixtures; these are **offline**, not Neon/Gemini passes                                                                            |
| TypeScript / production build           | **PASS**                     | `npm run typecheck` and the production Next.js build                                                                                                                                                                                |
| Production browser journeys             | **7/7 PASS**                 | Real HTTP and Chromium against production Next.js with local PostgreSQL/PGlite; rerun on 13 November                                                                                                                                |
| Real Neon migration / seed              | **PASS**                     | `001_core.sql`, `002_sources.sql`, `004_sis.sql`; migration rerun idempotent; three demo roles seeded; nine managed `neon_auth` tables preserved                                                                                    |
| Real Neon runtime isolation             | **PASS**                     | Non-owner runtime role and tenant RLS verified against the actual database                                                                                                                                                          |
| Authentic source import                 | **6/6 PASS**                 | All PDF SHA-256 hashes, byte sizes and physical page counts match the manifest; all six PDFs plus the original supplement imported into Neon; [integrity report](evidence/authentic-sources.json)                                   |
| Academic source spot check              | **PASS, limited scope**      | Original L4 pp.18–19 visually inspected: TP=6, FN=4, FP=20, TN=970; Recall 60%, Precision ≈23.1%, Accuracy 97.6%                                                                                                                    |
| Real Neon browser checks                | **7/7 PASS**                 | Read-only role, material, source-viewer and AR/EN/mobile checks; **zero model calls**                                                                                                                                               |
| Real guarded Gemini tutor               | **PASS**                     | `gemini-3.5-flash-lite`, exact Arabic Recall question; 19.7 seconds, 1,111 tokens, one call; cites L4 pp.18–19 and supplement U2; DB retrieval precedes generation                                                                  |
| Real Gemini graph / teaching generation | **PASS: reviewed/published** | Actual graph with two concepts and one edge, bilingual lesson and instructor-edited fresh 70% question; five browser review/publication checks passed on Neon                                                                       |
| Vercel Preview deployment               | **PASS, protected**          | [Open Preview](https://tilwa-6twb3yvyj-mohamedtarek750s-projects.vercel.app); existing Vercel login required                                                                                                                        |
| Complete Preview acceptance smoke       | **7/7 PASS**                 | Real Vercel + Neon + Gemini: AR/EN/mixed answers, approved citations, fresh unassisted practice, atomic retry, new-login persistence, cross-session exam protection and advisor isolation                                           |
| Deployed browser / access cleanup       | **6/6 PASS**                 | Exact Arabic tutor question and source opening, unsupported-evidence abstention, persisted progress in a new mobile context, RTL/LTR and advisor view; temporary test bypass revoked ([report](evidence/live-preview-browser.json)) |
| University SIS                          | **NOT CONNECTED**            | Demo and external-contract fixtures only; signed events, adapter replacement and history preservation tested locally                                                                                                                |

## Source and model provenance / حقيقة المصادر والنموذج

- **Named GFG reference:** registered as link/metadata. **No GFG article text has been used.** The manual authorized-passage flow is tested with a labelled synthetic passage.
- **Original Tilwa supplement:** actual repository content imported separately, with U1–U5 locators. It is not relabelled GFG.
- **Original lectures:** six authentic Drive files verified and imported; all six subsequently uploaded PDFs are byte-for-byte identical ([uploaded-file verification](evidence/uploaded-sources.json)). Private PDFs and rendered lecture pages remain outside Git/public assets; the committed evidence contains integrity metadata only.
- **Review authority:** L4 pp.18–19 and supplement U1–U5 were approved through the demo instructor account after agent review. This is a pilot content review, **not institutional or supervisor sign-off**. This describes the initial review; the current comprehensive page ledger is documented above.
- **Quarantine:** L4 p.16 says 60 healthy/40 patients while its cells imply 50/50. It remains quarantined. In the initial release L5 pp.18,21–23 were quarantined. They now have reviewed successor extracts based on the fully recomputed table; the originals remain unchanged.
- **Pinned model:** `gemini-3.5-flash-lite` produced the verified real tutor response and teaching/graph drafts. `gemini-2.5-flash` returned 404 for this project. Two bounded graph calls to `gemini-3.8-flash` timed out; that model has no successful teaching claim here.

The exact Arabic probe explains that 6 detected frauds out of 10 actual frauds gives 60% Recall: [redacted probe](evidence/live-tutor-probe.json). The separate [live Preview acceptance](evidence/live-smoke.json) passed three real tutor generations totaling **3,877 tokens**, including the corresponding ≈23.1% Precision explanation. A checkpointed rerun verified the remaining steps without repeating successful model calls. The separate deployed-browser test made one further real Arabic call (**1,123 tokens**) and opened its original L4 citation. Fresh practice created exactly one attempt and one answer event, even after retry. [All 110 offline test names/results](evidence/offline-tests-2026-11-13.json) and [actual source review/publication browser results](evidence/neon-browser-source-review.json) remain separate evidence.

## Application checks

The seven local production browser journeys cover independent calculation/metric-choice evidence, deliberate-error moderation, optional gradient transfer, assignment feedback, reviewed career artifacts, teaching interventions, QMS **18/24 = 75% attainment** and **24/30 = 80% coverage**, sign-out/recovery, protected exams, role isolation, RTL/LTR and 390px mobile navigation. These are real local application checks with synthetic records, not a live university connection.

Security tests cover non-owner RLS, two-tenant isolation, revoked membership/enrollment, unassigned advisors, protected exams, current source versions and rights. Pending sources cannot reach generation. Denials/database outages cause zero generation calls; authorization is checked again before and after provider generation. Historical citations, graph mappings, SIS revisions and user-scoped memory changes preserve longitudinal learning evidence.

Structured references and arithmetic validation do not prove full semantic entailment. The current agent review covers all six lecture inventories and the stated numerical corrections. Broader multilingual adversarial evaluation and institutional human academic review remain separate work.

## Rerun / إعادة الاختبار

For the current invite-only hosted deployment, follow [hosted pilot verification](hosted-pilot-verification.md). Its canonical HTTP/Neon check does not call Gemini unless the separate metered flag is explicitly enabled; do not repeat the accepted staged call merely to verify the same promoted build.

Local checks:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:production
```

For the **existing** non-production Neon/Vercel resources, use [existing-resource deployment](existing-deployment.md); do not create duplicate projects. This managed cloud environment uses `NEON_TRANSPORT=websocket` for verified WSS connections. Vercel retains the default pooled PostgreSQL TCP transport.

```bash
NEON_TRANSPORT=websocket LOCAL_DATABASE=0 npm run db:migrate
NEON_TRANSPORT=websocket LOCAL_DATABASE=0 npm run db:seed
```

Load `LIVE_WORKSPACE_CODE` securely from `.tilwa-private/demo-workspace-code`, and supply the protected Preview's authorized `VERCEL_AUTOMATION_BYPASS_SECRET` securely for automation. Do not print either value. With server credentials already supplied through secure settings:

```bash
LIVE_SMOKE=1 NEON_TRANSPORT=websocket LOCAL_DATABASE=0 \
  GEMINI_MODEL=gemini-3.5-flash-lite \
  LIVE_BASE_URL=https://tilwa-6twb3yvyj-mohamedtarek750s-projects.vercel.app \
  npm run test:live
```

The opt-in smoke is metered and checkpointed. It verifies AR/EN/mixed tutoring with actual L4 citations, DB-first trace order, protected exam/refusal behavior, attempt persistence after sign-out and assigned-advisor evidence. Successful language traces are checkpointed to avoid repeated paid calls. A new independent run requires an unused, instructor-reviewed question family. The temporary automation bypass used for verification was revoked after testing; normal browser access uses your Vercel login.

[Actual Preview desktop](evidence/live-preview-desktop.png) · [Actual Preview mobile](evidence/live-preview-mobile.png) · [Visual comparison notes](evidence/visual-review.md). Deployment, cloud-environment publication and successful live acceptance remain distinct outcomes.
