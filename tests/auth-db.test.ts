import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/server/db";
import { migrateDatabase } from "../src/server/migrate";
import {
  authorizeCourse,
  createSession,
  requireAuth,
  requireAdvisee,
  SESSION_COOKIE,
  WORKSPACE_COOKIE,
  type AuthContext,
} from "../src/server/auth";
import {
  createWorkspace,
  resolveWorkspace,
  type Workspace,
} from "../src/server/seed";
import { POST as demoLogin } from "../src/app/api/auth/demo/route";
import { POST as demoLogout } from "../src/app/api/auth/logout/route";
import { GET as currentUser } from "../src/app/api/auth/me/route";
const tenantA = randomUUID(),
  tenantB = randomUUID(),
  student = randomUUID(),
  advisor = randomUUID();
let token: string;
beforeAll(async () => {
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_DATABASE_PATH = "memory://";
  process.env.SESSION_SECRET =
    "test-only-session-secret-with-more-than-32-characters";
  await migrateDatabase();
  for (const tid of [tenantA, tenantB])
    await db.tenant(tid).transaction(async (tx) => {
      await tx.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [
        tid,
        "Synthetic security test",
      ]);
      await tx.query("INSERT INTO users(tenant_id,id,name) VALUES($1,$2,$3)", [
        tid,
        student,
        '{"ar":"طالب","en":"Student"}',
      ]);
      await tx.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
        [tid, student, "student"],
      );
      await tx.query(
        "INSERT INTO course_access(tenant_id,user_id,course_id,access_role) VALUES($1,$2,$3,$4)",
        [tid, student, "CET351", "student"],
      );
      await tx.query(
        "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,$3,$4,$5,$6)",
        [
          tid,
          "private",
          "learning-event",
          "CET351",
          student,
          '{"private":true}',
        ],
      );
    });
  token = await createSession(tenantA, student);
}, 30000);
afterAll(() => db.close());
const request = (value = token) =>
  new Request("http://localhost/api/test", {
    headers: { cookie: `${SESSION_COOKIE}=${value}` },
  });
const ctx: AuthContext = {
  tenantId: tenantA,
  userId: student,
  role: "student",
  courseId: "CET351",
  locale: "ar",
};
describe("signed sessions and database-first authorization (local PostgreSQL)", () => {
  it("verifies a real DB session and ignores role headers", async () => {
    const req = new Request("http://localhost/api/test", {
      headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-role": "instructor" },
    });
    expect((await requireAuth(req)).role).toBe("student");
  });
  it("denies tampering and unsigned role claims", async () => {
    await expect(
      requireAuth(request(token + "tampered")),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      requireAuth(new Request("http://localhost?role=instructor")),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("denies an unauthorized role and course", async () => {
    await expect(requireAuth(request(), ["instructor"])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(authorizeCourse(ctx, "OTHER")).rejects.toMatchObject({
      code: "COURSE_FORBIDDEN",
    });
  });
  it("enforces RLS as a non-owner runtime DB role", async () => {
    await db.tenant(tenantA).transaction(async (tx) => {
      await tx.query("SET LOCAL ROLE tilwa_runtime");
      const rows = await tx.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM records",
      );
      expect(rows.rows.length).toBe(1);
      expect(rows.rows[0].tenant_id).toBe(tenantA);
      await tx.query("SAVEPOINT attack_check");
      await expect(
        tx.query("INSERT INTO records(tenant_id,id,kind) VALUES($1,$2,$3)", [
          tenantB,
          "attack",
          "private",
        ]),
      ).rejects.toThrow();
      await tx.query("ROLLBACK TO SAVEPOINT attack_check");
    });
  });
  it("blocks tutor in protected mode from any session", async () => {
    await db
      .tenant(tenantA)
      .query(
        "INSERT INTO exam_sessions(tenant_id,id,user_id,course_id) VALUES($1,$2,$3,$4)",
        [tenantA, "exam", student, "CET351"],
      );
    await expect(authorizeCourse(ctx, "CET351", "tutor")).rejects.toMatchObject(
      { code: "EXAM_PROTECTED" },
    );
    await db
      .tenant(tenantA)
      .query("UPDATE exam_sessions SET status='completed' WHERE tenant_id=$1", [
        tenantA,
      ]);
  });
  it("revoked enrollment takes effect without a new token", async () => {
    await db
      .tenant(tenantA)
      .query(
        "UPDATE course_access SET active=false WHERE tenant_id=$1 AND user_id=$2",
        [tenantA, student],
      );
    await expect(authorizeCourse(ctx, "CET351", "read")).rejects.toMatchObject({
      code: "COURSE_FORBIDDEN",
    });
  });
  it("revoked membership takes effect without a new token", async () => {
    await db
      .tenant(tenantA)
      .query(
        "UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2",
        [tenantA, student],
      );
    await expect(requireAuth(request())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("sandbox role login and new-browser persistence", () => {
  it("gates demo mode before creating any account", async () => {
    process.env.DEMO_MODE = "false";
    const response = await demoLogin(
      new Request("http://localhost/api/auth/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "student" }),
      }),
    );
    expect(response.status).toBe(403);
  });
  it("refuses demo account creation in a production deployment", async () => {
    process.env.DEMO_MODE = "true";
    process.env.VERCEL_ENV = "production";
    const response = await demoLogin(
      new Request("http://localhost/api/auth/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"role":"student"}',
      }),
    );
    expect(response.status).toBe(403);
    delete process.env.VERCEL_ENV;
  });
  it("reuses private synthetic workspace with a recovery code after logout", async () => {
    process.env.DEMO_MODE = "true";
    const login = (body: unknown) =>
      demoLogin(
        new Request("http://localhost/api/auth/demo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const response = await login({ role: "student" });
    expect(response.status).toBe(200);
    const first = await response.json();
    await db
      .tenant(first.user.tenantId)
      .query(
        "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,$3,$4,$5,$6)",
        [
          first.user.tenantId,
          "persistence-proof",
          "event",
          "CET351",
          first.user.userId,
          '{"correct":true}',
        ],
      );
    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith(SESSION_COOKIE + "="))!
      .split(";")[0];
    const signedOut = await demoLogout(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(signedOut.status).toBe(200);
    await expect(
      requireAuth(
        new Request("http://localhost/api/auth/me", { headers: { cookie } }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const restored = await login({
      role: "student",
      workspaceCode: first.workspaceCode,
    });
    const second = await restored.json();
    expect(second.user.userId).toBe(first.user.userId);
    expect(
      (
        await db
          .tenant(second.user.tenantId)
          .query("SELECT id FROM records WHERE tenant_id=$1 AND id=$2", [
            second.user.tenantId,
            "persistence-proof",
          ])
      ).rows.length,
    ).toBe(1);
    const instructor = await (
      await login({ role: "instructor", workspaceCode: first.workspaceCode })
    ).json();
    expect(
      (await authorizeCourse(instructor.user, "CET351", "publish")).canPublish,
    ).toBe(true);
    const advisor = await (
      await login({ role: "advisor", workspaceCode: first.workspaceCode })
    ).json();
    await expect(
      requireAdvisee(advisor.user, first.user.userId),
    ).resolves.toBeUndefined();
    const other = await (await login({ role: "student" })).json();
    expect(other.user.tenantId).not.toBe(first.user.tenantId);
    await expect(
      requireAdvisee(advisor.user, other.user.userId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db
      .tenant(first.user.tenantId)
      .query("UPDATE advisor_assignments SET active=false WHERE tenant_id=$1", [
        first.user.tenantId,
      ]);
    await expect(
      requireAdvisee(advisor.user, first.user.userId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("accepts browser Host when Next exposes an internal hostname", async () => {
    process.env.DEMO_MODE = "true";
    const response = await demoLogin(
      new Request("http://localhost:3000/api/auth/demo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
          "sec-fetch-site": "same-origin",
        },
        body: '{"role":"student"}',
      }),
    );
    expect(response.status).toBe(200);
  });
  it("rejects cross-origin mutation before authenticating", async () => {
    const response = await demoLogin(
      new Request("http://localhost/api/auth/demo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://untrusted.example",
        },
        body: '{"role":"instructor"}',
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe("invite-only synthetic pilot on a production host (real local PostgreSQL engine)", () => {
  let invited: Workspace, nonsynthetic: Workspace, nonsyntheticToken: string;
  const environmentKeys = [
    "DEMO_MODE",
    "TILWA_ENV",
    "VERCEL_ENV",
    "PILOT_ACCESS_MODE",
  ] as const;
  const savedEnvironment: Record<string, string | undefined> = {};
  const configurePilot = () => {
    process.env.DEMO_MODE = "true";
    process.env.TILWA_ENV = "pilot";
    process.env.VERCEL_ENV = "production";
    process.env.PILOT_ACCESS_MODE = "invite-only";
  };
  const login = (body: unknown, headers: Record<string, string> = {}) =>
    demoLogin(
      new Request("https://tilwa.vercel.app/api/auth/demo", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const sessionCookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${SESSION_COOKIE}=`))!
      .split(";")[0];
  const tenantCount = async () =>
    (
      await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM tenants",
      )
    ).rows[0].count;

  beforeAll(async () => {
    for (const key of environmentKeys) savedEnvironment[key] = process.env[key];
    process.env.DEMO_MODE = "true";
    process.env.TILWA_ENV = "pilot";
    process.env.VERCEL_ENV = "preview";
    delete process.env.PILOT_ACCESS_MODE;
    invited = await createWorkspace();
    nonsynthetic = await createWorkspace();
    nonsyntheticToken = await createSession(
      nonsynthetic.tenantId,
      nonsynthetic.users.student,
    );
    await db.query("UPDATE tenants SET synthetic=false WHERE id=$1", [
      nonsynthetic.tenantId,
    ]);
    // Every acceptance assertion below executes with the non-owner runtime role.
    await db.query("SET ROLE tilwa_runtime");
  });
  beforeEach(configurePilot);
  afterAll(async () => {
    await db.query("RESET ROLE");
    for (const key of environmentKeys) {
      if (savedEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnvironment[key];
    }
  });

  it.each(["ar", "en"] as const)(
    "requires an invitation and returns a %s error without creating a tenant",
    async (locale) => {
      const before = await tenantCount();
      const response = await login({ role: "student", locale });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe("INVITE_REQUIRED");
      expect(body.error.message).toBe(body.error.messages[locale]);
      expect(body.error.message).toMatch(
        locale === "ar" ? /رمز الوصول/ : /access code/,
      );
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await tenantCount()).toBe(before);
    },
  );

  it.each(["student", "instructor", "advisor"] as const)(
    "authenticates an invited %s with database-enforced permissions",
    async (role) => {
      const response = await login({
        role,
        workspaceCode: invited.workspaceCode,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        mode: "pilot",
        accessMode: "invite-only",
        synthetic: true,
        user: { tenantId: invited.tenantId, userId: invited.users[role], role },
      });
      const cookie = sessionCookie(response);
      const me = await currentUser(
        new Request("https://tilwa.vercel.app/api/auth/me", {
          headers: { cookie },
        }),
      );
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({
        mode: "pilot",
        accessMode: "invite-only",
        synthetic: true,
        user: { tenantId: invited.tenantId, userId: invited.users[role], role },
      });
      const authenticated = await requireAuth(
        new Request("https://tilwa.vercel.app/api/auth/me", {
          headers: {
            cookie,
            "x-role": role === "student" ? "instructor" : "student",
          },
        }),
      );
      expect(authenticated.role).toBe(role);
      expect(
        (await db.query<{ current_user: string }>("SELECT current_user"))
          .rows[0].current_user,
      ).toBe("tilwa_runtime");
      await expect(
        authorizeCourse(authenticated, "OTHER"),
      ).rejects.toMatchObject({ code: "COURSE_FORBIDDEN" });
      if (role === "instructor") {
        expect(
          (await authorizeCourse(authenticated, "CET351", "publish"))
            .canPublish,
        ).toBe(true);
      } else {
        await expect(
          authorizeCourse(authenticated, "CET351", "publish"),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      if (role === "advisor") {
        await expect(
          requireAdvisee(authenticated, invited.users.student),
        ).resolves.toBeUndefined();
        await expect(
          requireAdvisee(authenticated, nonsynthetic.users.student),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      expect(
        response.headers
          .getSetCookie()
          .every(
            (value) =>
              value.includes("HttpOnly") &&
              value.includes("SameSite=Lax") &&
              value.includes("Secure"),
          ),
      ).toBe(true);
    },
  );

  it("rejects unknown codes without provisioning or returning cookies", async () => {
    const before = await tenantCount();
    const response = await login({
      role: "instructor",
      workspaceCode: `unknown-${randomUUID()}`,
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("INVALID_WORKSPACE");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await tenantCount()).toBe(before);
  });

  it("never resolves a non-synthetic workspace, even with a valid registered code or old session", async () => {
    const before = await tenantCount();
    const response = await login({
      role: "student",
      workspaceCode: nonsynthetic.workspaceCode,
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("INVALID_WORKSPACE");
    await expect(
      resolveWorkspace(nonsynthetic.workspaceCode),
    ).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
    await expect(requireAuth(request(nonsyntheticToken))).rejects.toMatchObject(
      { code: "UNAUTHORIZED" },
    );
    expect(await tenantCount()).toBe(before);
  });

  it("blocks the seed boundary with no code, a new supplied code and an existing code", async () => {
    const before = await tenantCount();
    for (const code of [
      undefined,
      `new-${randomUUID()}`,
      invited.workspaceCode,
    ]) {
      await expect(createWorkspace(code)).rejects.toMatchObject({
        code: "WORKSPACE_CREATION_DISABLED",
      });
    }
    expect(await tenantCount()).toBe(before);
  });

  it("retains the invited workspace cookie after logout and revokes the old session", async () => {
    const response = await login({
      role: "student",
      workspaceCode: invited.workspaceCode,
    });
    const cookie = sessionCookie(response);
    const workspaceCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${WORKSPACE_COOKIE}=`))!
      .split(";")[0];
    const signedOut = await demoLogout(
      new Request("https://tilwa.vercel.app/api/auth/logout", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(signedOut.status).toBe(200);
    expect(
      signedOut.headers
        .getSetCookie()
        .some((value) => value.startsWith(`${WORKSPACE_COOKIE}=`)),
    ).toBe(false);
    await expect(
      requireAuth(
        new Request("https://tilwa.vercel.app/api/auth/me", {
          headers: { cookie },
        }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const before = await tenantCount();
    const restored = await login(
      { role: "advisor" },
      { cookie: workspaceCookie },
    );
    expect(restored.status).toBe(200);
    expect((await restored.json()).user).toMatchObject({
      tenantId: invited.tenantId,
      userId: invited.users.advisor,
    });
    expect(await tenantCount()).toBe(before);
  });

  it("continues to enforce protected exams and revoked enrollment for invited sessions", async () => {
    const response = await login({
      role: "student",
      workspaceCode: invited.workspaceCode,
    });
    const authenticated = await requireAuth(
      new Request("https://tilwa.vercel.app/api/auth/me", {
        headers: { cookie: sessionCookie(response) },
      }),
    );
    await db
      .tenant(invited.tenantId)
      .query(
        "INSERT INTO exam_sessions(tenant_id,id,user_id,course_id) VALUES($1,$2,$3,$4)",
        [invited.tenantId, "invite-test-exam", invited.users.student, "CET351"],
      );
    await expect(
      authorizeCourse(authenticated, "CET351", "tutor"),
    ).rejects.toMatchObject({ code: "EXAM_PROTECTED" });
    await db
      .tenant(invited.tenantId)
      .query("UPDATE exam_sessions SET status='completed' WHERE tenant_id=$1", [
        invited.tenantId,
      ]);
    await db
      .tenant(invited.tenantId)
      .query(
        "UPDATE course_access SET active=false WHERE tenant_id=$1 AND user_id=$2",
        [invited.tenantId, invited.users.student],
      );
    await expect(
      authorizeCourse(authenticated, "CET351", "read"),
    ).rejects.toMatchObject({ code: "COURSE_FORBIDDEN" });
    await db
      .tenant(invited.tenantId)
      .query(
        "UPDATE course_access SET active=true WHERE tenant_id=$1 AND user_id=$2",
        [invited.tenantId, invited.users.student],
      );
  });

  it.each(["DEMO_MODE", "TILWA_ENV", "PILOT_ACCESS_MODE"] as const)(
    "keeps production closed if %s is not explicitly enabled",
    async (key) => {
      delete process.env[key];
      const before = await tenantCount();
      const response = await login(
        { role: "instructor", workspaceCode: invited.workspaceCode },
        { "x-pilot-access-mode": "invite-only", "x-role": "instructor" },
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("DEMO_DISABLED");
      expect(await tenantCount()).toBe(before);
    },
  );

  it("does not turn a standard production environment into a pilot", async () => {
    process.env.TILWA_ENV = "production";
    const response = await login({
      role: "student",
      workspaceCode: invited.workspaceCode,
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("DEMO_DISABLED");
  });

  it("preserves anonymous workspace creation in the default Preview sandbox", async () => {
    process.env.VERCEL_ENV = "preview";
    delete process.env.PILOT_ACCESS_MODE;
    const before = await tenantCount();
    const response = await login({ role: "student" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ mode: "sandbox", synthetic: true });
    expect(body.user.tenantId).not.toBe(invited.tenantId);
    expect(await tenantCount()).toBe(before + 1);
  });
});
