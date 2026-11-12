import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/server/db";
import { migrateDatabase } from "../src/server/migrate";
import { type AuthContext } from "../src/server/auth";
import { readMemory, updateMemory } from "../src/server/tutor-memory";
import { importAuthorizedPassage } from "../src/server/sources";

const tenant = randomUUID(),
  otherTenant = randomUUID();
const student: AuthContext = {
  tenantId: tenant,
  userId: randomUUID(),
  role: "student",
  courseId: "CET351",
  locale: "ar",
};
const peer: AuthContext = { ...student, userId: randomUUID() };
const outsider: AuthContext = {
  ...student,
  tenantId: otherTenant,
  userId: randomUUID(),
};
const instructor: AuthContext = {
  ...student,
  userId: randomUUID(),
  role: "instructor",
};
async function put(ctx: AuthContext, id: string, kind: string, data: unknown) {
  await db
    .tenant(ctx.tenantId)
    .query(
      "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,$3,$4,$5,$6)",
      [ctx.tenantId, id, kind, "CET351", ctx.userId, JSON.stringify(data)],
    );
}
beforeAll(async () => {
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_DATABASE_PATH = "memory://";
  await migrateDatabase();
  for (const tid of [tenant, otherTenant])
    await db.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [
      tid,
      "Synthetic memory isolation test",
    ]);
  for (const ctx of [student, peer, outsider, instructor])
    await db.tenant(ctx.tenantId).transaction(async (tx) => {
      await tx.query("INSERT INTO users(tenant_id,id,name) VALUES($1,$2,$3)", [
        ctx.tenantId,
        ctx.userId,
        '{"ar":"اختبار","en":"Test"}',
      ]);
      await tx.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
        [ctx.tenantId, ctx.userId, ctx.role],
      );
      await tx.query(
        "INSERT INTO course_access(tenant_id,user_id,course_id,access_role,can_review,can_publish) VALUES($1,$2,$3,$4,$5,$5)",
        [
          ctx.tenantId,
          ctx.userId,
          "CET351",
          ctx.role,
          ctx.role === "instructor",
        ],
      );
    });
  await put(student, "own-memory", "tutor_memory", {
    question: "Explain Recall",
    answer: "Synthetic saved explanation",
    citations: [],
  });
  await put(peer, "peer-memory", "tutor_memory", {
    question: "Peer private",
    answer: "Must not be shared",
    citations: [],
  });
  await put(outsider, "outsider-memory", "tutor_memory", {
    question: "Other tenant",
    answer: "Must not be shared",
    citations: [],
  });
  await put(student, "retained-learning-event", "learning_event", {
    correct: true,
    objective: "recall.calculate",
    modelVersion: "baseline-v1",
  });
  await put(student, "retained-objective", "objective_state", {
    state: "developing",
    evidenceIds: ["retained-learning-event"],
  });
});
afterAll(() => db.close());

describe("private tutor memory against actual local PostgreSQL (no model calls)", () => {
  it("returns only the authenticated learner memory within their tenant", async () => {
    const result = await readMemory(student);
    expect(result.messages.map((r) => r.id)).toEqual(["own-memory"]);
    expect((await readMemory(peer)).messages.map((r) => r.id)).toEqual([
      "peer-memory",
    ]);
    expect((await readMemory(outsider)).messages.map((r) => r.id)).toEqual([
      "outsider-memory",
    ]);
  });
  it("rejects corrections and deletions of another owner or tenant memory", async () => {
    await expect(
      updateMemory(student, {
        action: "correct",
        id: "peer-memory",
        correction: "Hijack",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      updateMemory(student, { action: "delete", id: "outsider-memory" }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("retains an explicit correctable private note without rewriting learning evidence", async () => {
    await updateMemory(student, {
      action: "correct",
      id: "own-memory",
      correction: "أفضّل الشرح خطوة بخطوة.",
    });
    const [saved] = (await readMemory(student)).messages;
    const savedData = saved.data as Record<string, unknown>;
    expect(savedData.correction).toBe("أفضّل الشرح خطوة بخطوة.");
    expect(savedData.answer).toBe("Synthetic saved explanation");
  });
  it("clears current conversation while preserving archived memory, mastery and learning history", async () => {
    const before = (
      await db
        .tenant(tenant)
        .query(
          "SELECT id,data FROM records WHERE tenant_id=$1 AND id IN ($2,$3) ORDER BY id",
          [tenant, "retained-learning-event", "retained-objective"],
        )
    ).rows;
    await updateMemory(student, { action: "clear-current" });
    expect((await readMemory(student)).messages).toHaveLength(0);
    expect((await readMemory(student, true)).messages.map((r) => r.id)).toEqual(
      ["own-memory"],
    );
    const after = (
      await db
        .tenant(tenant)
        .query(
          "SELECT id,data FROM records WHERE tenant_id=$1 AND id IN ($2,$3) ORDER BY id",
          [tenant, "retained-learning-event", "retained-objective"],
        )
    ).rows;
    expect(after).toEqual(before);
    expect((await readMemory(peer)).messages).toHaveLength(1);
  });
  it("deletes only an owned memory and records a minimal audit event", async () => {
    await updateMemory(student, { action: "delete", id: "own-memory" });
    expect((await readMemory(student, true)).messages).toHaveLength(0);
    const audits = (
      await db
        .tenant(tenant)
        .query<{ data: { action: string; memoryId: string } }>(
          "SELECT data FROM records WHERE tenant_id=$1 AND owner_id=$2 AND kind='memory_audit'",
          [tenant, student.userId],
        )
    ).rows;
    expect(
      audits.some(
        (r) => r.data.action === "delete" && r.data.memoryId === "own-memory",
      ),
    ).toBe(true);
  });
  it("prevents historical tutor answers being reopened during a protected exam", async () => {
    await db
      .tenant(tenant)
      .query(
        "INSERT INTO exam_sessions(tenant_id,id,user_id,course_id) VALUES($1,$2,$3,$4)",
        [tenant, "memory-exam", student.userId, "CET351"],
      );
    await expect(readMemory(student, true)).rejects.toMatchObject({
      code: "EXAM_PROTECTED",
    });
    await db
      .tenant(tenant)
      .query(
        "UPDATE exam_sessions SET status='completed' WHERE tenant_id=$1 AND id=$2",
        [tenant, "memory-exam"],
      );
  });
});

describe("authorized passage rights (synthetic original passage)", () => {
  const passage = {
    sourceKey: "CUSTOM-UMBRELLA" as const,
    title: "Original synthetic rights fixture",
    text: "This is original synthetic test text, not retrieved GeeksforGeeks content.",
    section: "fixture-section",
    rightsConfirmed: true as const,
    rightsReference: "Original author permission: synthetic test fixture only",
  };
  it("requires a meaningful explicit permission reference before importing", async () => {
    await expect(
      importAuthorizedPassage(instructor, { ...passage, rightsReference: "" }),
    ).rejects.toMatchObject({ code: "permission_required" });
    await expect(
      importAuthorizedPassage(instructor, {
        ...passage,
        rightsConfirmed: false as unknown as true,
      }),
    ).rejects.toMatchObject({ code: "permission_required" });
    const rows = (
      await db
        .tenant(tenant)
        .query("SELECT id FROM material_versions WHERE tenant_id=$1", [tenant])
    ).rows;
    expect(rows).toHaveLength(0);
  });
  it("denies student import and keeps an authorized original passage pending instructor review", async () => {
    await expect(
      importAuthorizedPassage(student, passage),
    ).rejects.toMatchObject({ status: 403 });
    const result = await importAuthorizedPassage(instructor, passage);
    const row = (
      await db
        .tenant(tenant)
        .query<{
          status: string;
          metadata: {
            authorization: { assertedBy: string; reference: string };
            manualAuthorizedPassage: boolean;
          };
          rights: { sendToModel: boolean };
        }>(
          "SELECT status,metadata,rights FROM material_versions WHERE tenant_id=$1 AND id=$2",
          [tenant, result.id],
        )
    ).rows[0];
    expect(row.status).toBe("pending");
    expect(row.metadata.authorization.assertedBy).toBe(instructor.userId);
    expect(row.metadata.authorization.reference).toBe(passage.rightsReference);
    expect(row.metadata.manualAuthorizedPassage).toBe(true);
    expect(row.rights.sendToModel).toBe(true);
  });
});
