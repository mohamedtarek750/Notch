import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { db } from "../src/server/db";
import { migrateDatabase } from "../src/server/migrate";
import { createWorkspace } from "../src/server/seed";
import {
  createSession,
  requireAuth,
  logout,
  type AuthContext,
} from "../src/server/auth";
import {
  bkt,
  deriveObjective,
  learningAction,
  publishedPrerequisiteSupport,
  qmsCounts,
  workspace,
} from "../src/server/learning";
let student: AuthContext,
  instructor: AuthContext,
  advisor: AuthContext,
  other: AuthContext;
beforeAll(async () => {
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_DATABASE_PATH = "memory://";
  process.env.DEMO_MODE = "true";
  process.env.SESSION_SECRET =
    "test-only-long-session-secret-never-for-deployment";
  await migrateDatabase();
  const a = await createWorkspace();
  const b = await createWorkspace();
  const ctx = (
    tid: string,
    uid: string,
    role: AuthContext["role"],
  ): AuthContext => ({
    tenantId: tid,
    userId: uid,
    role,
    courseId: "CET351",
    locale: "ar",
  });
  student = ctx(a.tenantId, a.users.student, "student");
  instructor = ctx(a.tenantId, a.users.instructor, "instructor");
  advisor = ctx(a.tenantId, a.users.advisor, "advisor");
  other = ctx(b.tenantId, b.users.student, "student");
});
afterAll(() => db.close());
async function select(ctx: AuthContext, objectiveId: string) {
  return learningAction(ctx, { action: "select-practice", objectiveId });
}
async function answer(
  ctx: AuthContext,
  deliveryId: string,
  value: string,
  key: string,
  explanation?: string,
) {
  return learningAction(ctx, {
    action: "attempt",
    deliveryId,
    answer: value,
    idempotencyKey: key,
    explanation,
  });
}
describe("learning evidence, LMS and private advising — local PostgreSQL; no model mock used", () => {
  it("keeps unknown evidence unassessed; ignores assistance, repeated families and stale evidence", () => {
    expect(deriveObjective([]).status).toBe("unassessed");
    const now = new Date().toISOString();
    expect(
      deriveObjective([
        { familyId: "a", correct: true, assisted: true, at: now },
      ]).status,
    ).toBe("unassessed");
    expect(
      deriveObjective([
        { familyId: "a", correct: true, assisted: false, at: now },
        { familyId: "a", correct: true, assisted: false, at: now },
      ]).status,
    ).toBe("developing");
    expect(
      deriveObjective([
        {
          familyId: "a",
          correct: true,
          assisted: false,
          at: "2024-01-01T00:00:00Z",
        },
      ]).status,
    ).toBe("unassessed");
    expect(bkt(0.2, true)).toBeGreaterThan(0.2);
    expect(bkt(0.8, false)).toBeLessThan(0.8);
  });
  it("scores fresh families and separates calculation from metric choice; retry is exactly once", async () => {
    const p = await select(student, "recall.calculate");
    expect(p.item.data.key).toBeUndefined();
    expect(p.item.data.feedback).toBeUndefined();
    const a = await answer(student, p.deliveryId, "a", "calc-first-request");
    expect(a.attempt.correct).toBe(true);
    expect(a.state.status).toBe("developing");
    expect(
      await answer(student, p.deliveryId, "a", "calc-first-request"),
    ).toEqual(a);
    const count = await db
      .tenant(student.tenantId)
      .query<{ n: number }>(
        "SELECT count(*)::int n FROM records WHERE tenant_id=$1 AND kind='event' AND data->>'attemptId'=$2",
        [student.tenantId, a.attempt.id],
      );
    expect(count.rows[0].n).toBe(1);
    await expect(
      answer(student, p.deliveryId, "b", "calc-first-request"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const p2 = await select(student, "recall.calculate");
    expect(p2.item.data.familyId).not.toBe(p.item.data.familyId);
    const a2 = await answer(student, p2.deliveryId, "b", "calc-second-request");
    expect(a2.state.status).toBe("secure");
    const choose = await select(student, "metric.choose");
    const c = await answer(
      student,
      choose.deliveryId,
      "accuracy",
      "choose-first-request",
    );
    expect(c.state.status).toBe("developing");
    expect(c.recommendation.objectiveId).toBe("metric.choose");
    const snapshot = await workspace(student);
    expect(
      snapshot.states.find(
        (r: any) => r.data.objectiveId === "recall.calculate",
      )?.data.status,
    ).toBe("secure");
  });
  it("persists across sign-out and fresh signed server session", async () => {
    const old = await createSession(student.tenantId, student.userId);
    const req = new Request("http://localhost/api/auth/logout", {
      headers: { cookie: `tilwa_session=${old}` },
    });
    await logout(req);
    await expect(requireAuth(req)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const token = await createSession(student.tenantId, student.userId);
    const ctx = await requireAuth(
      new Request("http://localhost/api/workspace", {
        headers: { cookie: `tilwa_session=${token}` },
      }),
    );
    expect(
      (await workspace(ctx)).states.some(
        (r: any) =>
          r.data.objectiveId === "recall.calculate" &&
          r.data.status === "secure",
      ),
    ).toBe(true);
  });
  it("requires critique explanation and instructor moderation, records first wrong step separately", async () => {
    const p = await select(student, "solution.review");
    await expect(
      answer(student, p.deliveryId, "2", "critique-no-explain"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const result = await answer(
      student,
      p.deliveryId,
      "2",
      "critique-with-explain",
      "المقام الصحيح هو الحالات الإيجابية الفعلية وليس التنبيهات.",
    );
    expect(result.attempt.errorLocation).toBe("2");
    expect(result.attempt.moderation).toBe("pending");
    expect(result.state.status).toBe("unassessed");
    const review = await learningAction(instructor, {
      action: "review-attempt",
      attemptId: result.attempt.id,
      score: 1,
      feedback: {
        ar: "تصحيح واضح للمقام.",
        en: "Clear denominator correction.",
      },
    });
    expect(review.state.independentFamilies).toBe(1);
  });
  it("offers optional transfer and a targeted recommendation for update direction", async () => {
    const p = await select(student, "gradient.transfer");
    expect(p.item.data.supplemental).toBe(true);
    const result = await answer(
      student,
      p.deliveryId,
      "up",
      "transfer-wrong-direction",
    );
    expect(result.attempt.correct).toBe(false);
    expect(result.recommendation.title.en).toContain("derivative");
  });
  it("enforces cross-tenant object ownership and assigned-advisor views", async () => {
    const p = await select(other, "metric.choose");
    await expect(
      answer(student, p.deliveryId, "recall", "cross-tenant-attack"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await workspace(advisor)).events.some(
        (r: any) => r.ownerId === student.userId,
      ),
    ).toBe(true);
    await db
      .tenant(student.tenantId)
      .query(
        "UPDATE advisor_assignments SET active=false WHERE tenant_id=$1 AND advisor_id=$2",
        [student.tenantId, advisor.userId],
      );
    expect((await workspace(advisor)).events).toHaveLength(0);
    await db
      .tenant(student.tenantId)
      .query(
        "UPDATE advisor_assignments SET active=true WHERE tenant_id=$1 AND advisor_id=$2",
        [student.tenantId, advisor.userId],
      );
  });
  it("blocks practice in a protected exam across sessions and hides bank keys", async () => {
    await learningAction(instructor, {
      action: "start-exam",
      studentId: student.userId,
    });
    await expect(select(student, "metric.choose")).rejects.toMatchObject({
      code: "EXAM_PROTECTED",
    });
    expect((await workspace(student)).items).toHaveLength(0);
    await expect(
      learningAction(student, {
        action: "end-exam",
        studentId: student.userId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await learningAction(instructor, {
      action: "end-exam",
      studentId: student.userId,
    });
  });
  it("supports assignment feedback, reviewed career artifacts and student visibility choice", async () => {
    const submission = await learningAction(student, {
      action: "submit-assignment",
      assignmentId: "assignment:evaluation",
      text: "Compare recall and precision using held-out data.",
    });
    const feedback = await learningAction(instructor, {
      action: "feedback",
      submissionId: submission.id,
      score: 80,
      feedback: { ar: "وضّح تكلفة الخطأ.", en: "Explain error costs." },
    });
    expect(feedback.data.officialGrade).toBe(false);
    const artifact = await learningAction(student, {
      action: "portfolio",
      title: "Evaluation notebook",
      description: "Recall and precision on held-out cases.",
      url: "https://example.com/private/notebook",
      include: false,
    });
    await expect(
      learningAction(other, {
        action: "portfolio-visibility",
        artifactId: artifact.id,
        include: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const reviewed = await learningAction(advisor, {
      action: "review-portfolio",
      artifactId: artifact.id,
      rubric: { analysis: 2, code: 2, communication: 1, reproducibility: 2 },
      feedback: {
        ar: "أضف وصفًا لإعادة التشغيل.",
        en: "Add reproduction steps.",
      },
    });
    expect(reviewed.data.status).toBe("reviewed");
    expect(reviewed.data.include).toBe(false);
    const included = await learningAction(student, {
      action: "portfolio-visibility",
      artifactId: artifact.id,
      include: true,
    });
    expect(included.data.include).toBe(true);
  });
  it("saves intervention wording and reversible instructor overrides", async () => {
    const intervention = await learningAction(instructor, {
      action: "intervention",
      objectiveId: "metric.choose",
      title: { ar: "تكلفة الخطأ", en: "Error costs" },
      body: {
        ar: "قارن حالتين لهما تكاليف مختلفة.",
        en: "Compare two settings with different costs.",
      },
    });
    expect(intervention.data.before.length).toBeGreaterThan(0);
    const changed = await learningAction(instructor, {
      action: "override",
      studentId: student.userId,
      objectiveId: "metric.choose",
      status: "secure",
      reason: "Reviewed independent oral explanation.",
    });
    expect(changed.data.model).toBe("instructor-override");
    expect(
      (await workspace(student)).recommendations.find(
        (r) => r.data.objectiveId === "metric.choose",
      )?.data.nextAction,
    ).toBe("next-objective");
    const restored = await learningAction(instructor, {
      action: "undo-override",
      overrideId: changed.data.overrideId,
    });
    expect(restored.data.status).toBe("developing");
    expect(
      (await workspace(student)).recommendations.find(
        (r) => r.data.objectiveId === "metric.choose",
      )?.data.nextAction,
    ).toBe("fresh-independent-probe");
  });
  it("redacts intervention identities and suppresses small-group after comparisons", async () => {
    const studentView = await workspace(student);
    expect(studentView.interventions.length).toBeGreaterThan(0);
    for (const i of studentView.interventions)
      expect("before" in i.data).toBe(false);
    const instructorView = await workspace(instructor);
    expect((instructorView.interventions[0].data as any).after.suppressed).toBe(
      true,
    );
  });
  it("persists enrollment through an allowed catalog instead of granting role claims", async () => {
    await db
      .tenant(student.tenantId)
      .query(
        "UPDATE course_access SET active=false WHERE tenant_id=$1 AND user_id=$2",
        [student.tenantId, student.userId],
      );
    await expect(workspace(student)).rejects.toMatchObject({
      code: "COURSE_FORBIDDEN",
    });
    await expect(
      learningAction(student, { action: "enroll", courseId: "CET351" }),
    ).rejects.toMatchObject({ code: "COURSE_FORBIDDEN" });
    await db
      .tenant(student.tenantId)
      .query(
        "UPDATE course_access SET active=true WHERE tenant_id=$1 AND user_id=$2",
        [student.tenantId, student.userId],
      );
    expect(
      await learningAction(student, { action: "enroll", courseId: "CET351" }),
    ).toMatchObject({ enrolled: true });
    expect((await workspace(student)).courses[0].data.code).toBe("CET351");
    await expect(
      learningAction(student, { action: "enroll", courseId: "OTHER" }),
    ).rejects.toThrow();
  });
  it("uses only a published graph with current approved evidence for prerequisite support", async () => {
    await db.tenant(student.tenantId).transaction(async (tx) => {
      const graph = {
        concepts: [
          {
            id: "conditional",
            label: { ar: "الاحتمال الشرطي", en: "Conditional probability" },
            aliases: ["conditional"],
            evidenceIds: ["graph-evidence"],
          },
          {
            id: "stable-recall",
            label: { ar: "الاستدعاء", en: "Recall" },
            aliases: ["recall"],
            evidenceIds: ["graph-evidence"],
          },
        ],
        edges: [
          {
            from: "conditional",
            to: "stable-recall",
            type: "prerequisite",
            evidenceIds: ["graph-evidence"],
          },
        ],
      };
      await tx.query(
        "INSERT INTO records(tenant_id,id,kind,course_id,data) VALUES($1,'pending-graph','knowledge_proposal','CET351',$2::jsonb)",
        [student.tenantId, JSON.stringify({ status: "pending", graph })],
      );
      expect(
        await publishedPrerequisiteSupport(
          tx,
          student,
          student.userId,
          "recall.calculate",
        ),
      ).toBeNull();
      await tx.query(
        "INSERT INTO material_versions(tenant_id,id,course_id,source_key,title,role,hash,rights,status) VALUES($1,'graph-version','CET351','TEST-GRAPH','Synthetic graph evidence','umbrella','graphhash','{\"displayExcerpt\":true}','published')",
        [student.tenantId],
      );
      await tx.query(
        "INSERT INTO evidence_chunks(tenant_id,id,version_id,course_id,text_content,status) VALUES($1,'graph-evidence','graph-version','CET351','Synthetic test claim, not course content.','approved')",
        [student.tenantId],
      );
      await tx.query(
        "INSERT INTO records(tenant_id,id,kind,course_id,data) VALUES($1,'published-graph','graph_release','CET351',$2::jsonb)",
        [
          student.tenantId,
          JSON.stringify({ publishedAt: new Date().toISOString(), graph }),
        ],
      );
      const support = await publishedPrerequisiteSupport(
        tx,
        student,
        student.userId,
        "recall.calculate",
      );
      expect(support?.releaseId).toBe("published-graph");
      expect(support?.concepts[0].status).toBe("unassessed");
      await tx.query(
        "UPDATE material_versions SET current_version=false WHERE tenant_id=$1 AND id='graph-version'",
        [student.tenantId],
      );
      expect(
        await publishedPrerequisiteSupport(
          tx,
          student,
          student.userId,
          "recall.calculate",
        ),
      ).toBeNull();
    });
  });
  it("reports correct QMS denominators with synthetic labels", async () => {
    expect(qmsCounts(30, 24, 18)).toMatchObject({
      attainment: 75,
      coverage: 80,
    });
    const qms = (await workspace(instructor)).qms!;
    expect(qms.fixture).toBe(true);
    expect(qms.attainment).toBe(75);
    expect(qms.coverage).toBe(80);
    expect((await workspace(student)).qms).toBeNull();
  });
});
