import { randomBytes, randomUUID } from "node:crypto";
import { db } from "./db";
import { hashCode, assertDemoMode, type Role } from "./auth";
import { AppError } from "./errors";
import { seedDomain } from "./domain-seed";
import { seedSis } from "./sis";
export interface Workspace {
  tenantId: string;
  workspaceCode: string;
  users: Record<Role, string>;
}
export async function resolveWorkspace(
  workspaceCode: string,
): Promise<Workspace> {
  if (workspaceCode.length < 16 || workspaceCode.length > 128)
    throw new AppError(401, "INVALID_WORKSPACE");
  const { rows } = await db.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM demo_workspaces WHERE code_hash=$1",
    [hashCode(workspaceCode)],
  );
  if (!rows[0]) throw new AppError(401, "INVALID_WORKSPACE");
  const tenantId = rows[0].tenant_id;
  const members = await db
    .tenant(tenantId)
    .query<{ user_id: string; role: Role }>(
      "SELECT user_id,role FROM memberships WHERE tenant_id=$1 AND active",
      [tenantId],
    );
  const users = {} as Record<Role, string>;
  for (const m of members.rows) users[m.role] = m.user_id;
  return { tenantId, workspaceCode, users };
}
export async function createWorkspace(
  suppliedCode?: string,
): Promise<Workspace> {
  assertDemoMode();
  const workspaceCode = suppliedCode ?? randomBytes(24).toString("base64url");
  if (workspaceCode.length < 16 || workspaceCode.length > 128)
    throw new AppError(400, "INVALID_INPUT");
  if (suppliedCode) {
    const existing = await db.query(
      "SELECT tenant_id FROM demo_workspaces WHERE code_hash=$1",
      [hashCode(suppliedCode)],
    );
    if (existing.rows.length) {
      const workspace = await resolveWorkspace(suppliedCode);
      await db
        .tenant(workspace.tenantId)
        .transaction((tx) =>
          seedDomain(tx, workspace.tenantId, workspace.users),
        );
      await seedSis(workspace.tenantId, workspace.users.student);
      return workspace;
    }
  }
  const tenantId = randomUUID(),
    users = {
      student: randomUUID(),
      instructor: randomUUID(),
      advisor: randomUUID(),
    };
  await db.tenant(tenantId).transaction(async (tx) => {
    await tx.query(
      "INSERT INTO tenants(id,name,synthetic) VALUES($1,$2,true)",
      [tenantId, "Tilwa synthetic pilot workspace"],
    );
    await tx.query(
      "INSERT INTO demo_workspaces(code_hash,tenant_id) VALUES($1,$2)",
      [hashCode(workspaceCode), tenantId],
    );
    const names = {
      student: { ar: "سلمى حسن", en: "Salma Hassan" },
      instructor: { ar: "د. أحمد علي", en: "Dr Ahmed Ali" },
      advisor: { ar: "د. مريم عادل", en: "Dr Mariam Adel" },
    };
    for (const role of ["student", "instructor", "advisor"] as const) {
      await tx.query(
        "INSERT INTO users(tenant_id,id,name,external_id) VALUES($1,$2,$3,$4)",
        [tenantId, users[role], JSON.stringify(names[role]), `demo-${role}`],
      );
      await tx.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
        [tenantId, users[role], role],
      );
      await tx.query(
        "INSERT INTO course_access(tenant_id,user_id,course_id,access_role,can_review,can_publish) VALUES($1,$2,$3,$4,$5,$5)",
        [tenantId, users[role], "CET351", role, role === "instructor"],
      );
    }
    await tx.query(
      "INSERT INTO advisor_assignments(tenant_id,advisor_id,student_id) VALUES($1,$2,$3)",
      [tenantId, users.advisor, users.student],
    );
    await seedDomain(tx, tenantId, users);
    await tx.query(
      "INSERT INTO audit_events(tenant_id,id,action,data) VALUES($1,$2,$3,$4)",
      [
        tenantId,
        randomUUID(),
        "demo.workspace.created",
        JSON.stringify({ synthetic: true, fixtureApprovals: true }),
      ],
    );
  });
  await seedSis(tenantId, users.student);
  return { tenantId, workspaceCode, users };
}
