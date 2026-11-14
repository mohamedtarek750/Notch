# Invite-only hosted pilot / تجربة مستضافة بالدعوة

**Deployed 13 November 2026:** [https://tilwa.vercel.app](https://tilwa.vercel.app). Open the site directly and enter the private code for the existing synthetic workspace, then choose a demo role. The same build passed staged acceptance and was promoted without rebuilding. [Deployment receipt](evidence/hosted-pilot-deployment.json) · [Staged 14-check acceptance](evidence/hosted-pilot-staged.json) · [Canonical 13-check acceptance](evidence/hosted-pilot-production.json) · [Canonical 9-check browser acceptance](evidence/hosted-pilot-production-browser.json) · [Measured verification and limits](verification.md). The canonical run deliberately skipped another Gemini call after the staged real-model pass.

The application denies demo sign-in on a Vercel Production host by default. The synthetic pilot exception requires **all three server-side settings**, scoped to the intended deployment:

```dotenv
DEMO_MODE=true
TILWA_ENV=pilot
PILOT_ACCESS_MODE=invite-only
```

Vercel sets `VERCEL_ENV` for its deployment target; do not spoof it to bypass the guard. `TILWA_ENV=production` continues to deny demo sign-in even if the other flags are set. Keep the existing Preview branch settings unchanged: the Preview deployment runners remain Preview-only and do not configure or publish this Production pilot.

Use the existing pooled, non-owner Neon runtime connection with `LOCAL_DATABASE=0`, the server-only Gemini key and model, and a securely configured session-signing secret. Preserve existing credentials through the project's secure settings; none belongs in client code or a `NEXT_PUBLIC_` variable. Node.js 24.x is the pinned runtime. Vercel uses pooled PostgreSQL TCP; managed-cloud verification may explicitly use `NEON_TRANSPORT=websocket`.

Invite-only entry requires a valid recovery code for an **existing synthetic workspace**. Provision and review that workspace before enabling the mode. The endpoint and seed boundary refuse anonymous or new-workspace provisioning in this mode. A remembered HttpOnly workspace cookie can supply the code after sign-out. Non-synthetic workspaces are refused, and previously signed sessions are rejected if their tenant is no longer marked synthetic. Possession of a valid existing synthetic workspace code grants access to its three demo roles; this is not a separate invitation or institutional credential for each role.

تتطلب تجربة الإنتاج الإعدادات الثلاثة أعلاه ورمز مساحة اصطناعية موجودة مسبقًا. لا تنشئ مساحة للزائر دون دعوة، وتسمح بالعودة عبر رمز المساحة أو ملف الارتباط المحفوظ. اختيار دور الطالب أو المدرّس أو المرشد يخص حسابات وبيانات متعلمين اصطناعية؛ ولا يحل محل هوية الجامعة أو تسجيل الدخول الموحد. تظل صلاحيات العضوية والمقرر والطالب المعيّن ووضع الامتحان مطبقة على السيرفر.

The role selector is for this synthetic pilot, not institutional authentication. Membership, course permissions, advisor assignments, protected-exam policy and tenant RLS remain enforced. Institutional access requires verified identity-to-membership integration. The evidence linked above records this deployment; the settings here describe how its access mode is configured.

## Hosted acceptance / التحقق من التجربة المستضافة

Run the hosted acceptance check after staging invite-only pilot access. The invitation file contains the existing workspace code as one plain-text line and stays under `.tilwa-private/`. Configure credentials through environment variables; do not paste invitation codes or connection strings into reports.

```bash
TILWA_BASE_URL=https://your-staged-deployment.vercel.app \
TILWA_WORKSPACE_CODE_FILE=.tilwa-private/demo-workspace-code \
npx tsx scripts/check-hosted-pilot.ts --stage staged
```

For the canonical deployment, change `TILWA_BASE_URL` and use `--stage production`. Set `VERCEL_AUTOMATION_BYPASS_SECRET` if the staged deployment requires an automation bypass. The runner sends that header only to the configured origin and rejects redirects to other origins.

`DATABASE_URL` is optional. When present, it must identify real Neon and enables independent read-only tenant-count, advisor-assignment and model-trace checks. Without it, those SQL checks are explicitly marked skipped; authorized HTTP checks still run. Existing student progress, attempts, mastery and recommendations must already be present.

To verify the Production Gemini configuration before changing the canonical domain, set `HOSTED_PILOT_LIVE_TUTOR=1` when checking the staged Production deployment. This permits exactly one Arabic Recall request with no retry. After promoting that same deployment, run the canonical HTTP checks without the live flag; the earlier report records the real provider verification. The request can write a model trace and tutor memory, but the runner checks that saved progress and mastery remain unchanged. Without the flag, no tutor call is made and that run makes no new Gemini availability claim.

Reports are written to `docs/evidence/hosted-pilot-staged.json` or `docs/evidence/hosted-pilot-production.json`. They contain safe counts, progress fingerprints, source locators and verification boundaries. They exclude invitation codes, cookies, connection strings, private excerpts, questions, answers and assessment keys. Exit status is `0` only when all requested checks pass, `1` for verification failure, and `2` for configuration failure. A failed or skipped live check is never presented as a real-provider pass.

This runner checks real HTTP responses and exact approved material API locators. Use `scripts/check-map-browser.mjs` separately for rendering, downloads, mobile layout and RTL/LTR interaction. Neither runner imports material, creates workspaces, submits attempts, modifies mastery, publishes curriculum or deploys a site. Sign-in and sign-out create and revoke authentication sessions.
