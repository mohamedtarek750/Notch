import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { authorizeCourse, type AuthContext } from "./auth";
import { db } from "./db";
import { AppError } from "./errors";
import { majorCourses } from "./sources";
import { extractStep } from "./prerequisites";
import type { BuildJob, BuildDocument } from "./build-job-types";

const columns =
  'id,course_id AS "courseId",status,documents,created_at AS "createdAt",updated_at AS "updatedAt"';
const action = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    documentIds: z.array(z.string().max(200)).min(1).max(300),
  }),
  z.object({ action: z.enum(["cancel", "retry"]), id: z.uuid() }),
]);
export async function listJobs(ctx: AuthContext) {
  await authorizeCourse(ctx, ctx.courseId, "write");
  return (
    await db
      .tenant(ctx.tenantId)
      .query<BuildJob>(
        "SELECT " +
          columns +
          " FROM km_build_jobs WHERE tenant_id=$1 AND course_id=$2 ORDER BY created_at DESC LIMIT 30",
        [ctx.tenantId, ctx.courseId],
      )
  ).rows;
}
export async function changeJob(ctx: AuthContext, raw: unknown) {
  await authorizeCourse(ctx, ctx.courseId, "generate");
  const input = action.parse(raw),
    scope = [ctx.tenantId, ctx.courseId];
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
      scope,
    );
    if (input.action !== "create") {
      const job = (
        await tx.query<BuildJob>(
          "SELECT " +
            columns +
            " FROM km_build_jobs WHERE tenant_id=$1 AND course_id=$2 AND id=$3 FOR UPDATE",
          [...scope, input.id],
        )
      ).rows[0];
      if (!job) throw new AppError(404, "NOT_FOUND");
      const cancel = input.action === "cancel";
      if (
        !(cancel ? ["queued", "processing"] : ["cancelled", "failed"]).includes(
          job.status,
        )
      )
        throw new AppError(409, "INVALID_INPUT");
      const docs = job.documents.map((d) =>
        d.status === "completed"
          ? d
          : { ...d, error: null, status: cancel ? "cancelled" : "queued" },
      );
      return (
        await tx.query<BuildJob>(
          "UPDATE km_build_jobs SET status=$4,documents=$5,updated_at=now() WHERE tenant_id=$1 AND course_id=$2 AND id=$3 RETURNING " +
            columns,
          [
            ...scope,
            job.id,
            cancel ? "cancelled" : "queued",
            JSON.stringify(docs),
          ],
        )
      ).rows[0];
    }
    const ids = [...new Set(input.documentIds)].sort();
    const docs = (
      await tx.query<BuildDocument>(
        `SELECT id AS "versionId",source_key AS "sourceKey",title,role FROM material_versions WHERE tenant_id=$1 AND course_id=$2 AND current_version AND role IN ('instructor','umbrella') AND id=ANY($3::text[]) ORDER BY id`,
        [...scope, ids],
      )
    ).rows;
    if (docs.length !== ids.length) throw new AppError(400, "INVALID_INPUT");
    const refs=docs.filter(d=>d.role==="umbrella").map(d=>d.versionId);
    if(refs.length){
      // Revisit published lectures whose reviewed concepts actually occur in the new reference.
      const affected=await tx.query<BuildDocument>(`SELECT DISTINCT v.id AS "versionId",v.source_key AS "sourceKey",v.title,v.role
        FROM material_versions v JOIN evidence_chunks e ON e.tenant_id=v.tenant_id AND e.version_id=v.id
        JOIN km_citations k ON k.tenant_id=e.tenant_id AND k.evidence_id=e.id AND k.course_id=v.course_id
        JOIN km_memberships m ON m.tenant_id=k.tenant_id AND m.course_id=k.course_id AND m.concept_id=k.concept_id
        WHERE v.tenant_id=$1 AND v.course_id=$2 AND v.role='instructor' AND v.current_version AND e.status='approved'
          AND NOT(v.id=ANY($3::text[])) AND EXISTS(SELECT 1 FROM evidence_chunks r
            WHERE r.tenant_id=v.tenant_id AND r.version_id=ANY($4::text[]) AND r.status='approved'
              AND EXISTS(SELECT 1 FROM jsonb_each_text(m.data->'label') term WHERE length(term.value)>=3 AND strpos(lower(r.text_content),lower(term.value))>0))
        ORDER BY v.id`,[...scope,ids,refs]);
      docs.push(...affected.rows);
    }
    const referenceCourses = [ctx.courseId, ...(await majorCourses(ctx, tx))];
    const snapshot = (
      await tx.query<{ key: string }>(
        "SELECT md5(coalesce(string_agg(c.id,',' ORDER BY c.id),'')) AS key FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE v.tenant_id=$1 AND v.course_id=ANY($2::text[]) AND v.current_version AND v.role='umbrella' AND c.status='approved'",
        [ctx.tenantId, referenceCourses],
      )
    ).rows[0].key;
    const key = createHash("sha256")
      .update(JSON.stringify([ids, snapshot]))
      .digest("hex");
    const old = (
      await tx.query<BuildJob>(
        "SELECT " +
          columns +
          " FROM km_build_jobs WHERE tenant_id=$1 AND course_id=$2 AND request_key=$3 AND status IN ('completed','processing','queued') ORDER BY created_at DESC LIMIT 1",
        [...scope, key],
      )
    ).rows[0];
    if (old) return old;
    return (
      await tx.query<BuildJob>(
        "INSERT INTO km_build_jobs(tenant_id,course_id,id,owner_id,locale,status,request_key,documents) VALUES($1,$2,$3,$4,$5,'queued',$6,$7) RETURNING " +
          columns,
        [
          ...scope,
          randomUUID(),
          ctx.userId,
          ctx.locale,
          key,
          JSON.stringify(
            docs.map((d) => ({
              ...d,
              cacheKey: snapshot,
              status: "queued",
              completedSteps: 0,
              error: null,
              proposalId: null,
            })),
          ),
        ],
      )
    ).rows[0];
  });
}
export async function drainCourse(tenantId: string, courseId: string) {
  const sql = db.tenant(tenantId),
    scope = [tenantId, courseId],
    end = Date.now() + 160000;
  while (Date.now() < end) {
    const token = randomUUID();
    const job = await sql.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
        scope,
      );
      return (
        await tx.query<BuildJob & { owner_id: string; locale: "en" | "ar" }>(
          "UPDATE km_build_jobs SET status='processing',lease_token=$3,lease_until=now()+interval '6 minutes',updated_at=now() WHERE tenant_id=$1 AND course_id=$2 AND id=(SELECT id FROM km_build_jobs WHERE tenant_id=$1 AND course_id=$2 AND status IN ('queued','processing') ORDER BY created_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM km_build_jobs WHERE tenant_id=$1 AND course_id=$2 AND lease_until>now()) RETURNING " +
            columns +
            ",owner_id,locale",
          [...scope, token],
        )
      ).rows[0];
    });
    if (!job) return;
    const d = job.documents.find((doc) => doc.status !== "completed")!;
    try {
      const ctx: AuthContext = {
        tenantId,
        courseId,
        userId: job.owner_id,
        role: "instructor",
        locale: job.locale,
      };
      await authorizeCourse(ctx, courseId, "generate");
      if (
        !(
          await sql.query(
            "SELECT 1 FROM material_versions WHERE tenant_id=$1 AND course_id=$2 AND id=$3 AND current_version",
            [...scope, d.versionId],
          )
        ).rows.length
      )
        throw new Error("version_changed");
      if (d.role === "instructor") {
        const cacheKey = d.cacheKey ?? job.id;
        const cached = (
          await sql.query<{ proposal_id: string }>(
            "SELECT r.proposal_id FROM km_build_results r JOIN records p ON p.tenant_id=r.tenant_id AND p.course_id=r.course_id AND p.id=r.proposal_id WHERE r.tenant_id=$1 AND r.course_id=$2 AND r.version_id=$3 AND r.cache_key=$4",
            [...scope, d.versionId, cacheKey],
          )
        ).rows[0];
        if (cached) {
          d.proposalId = cached.proposal_id;
          d.status = "completed";
        } else {
          const result = await extractStep(ctx, {
            lectureSourceKey: d.sourceKey, lectureOnlyAllowed: true,
          });
          d.completedSteps++;
          if (result.done) {
            d.proposalId = result.proposal.id;
            d.status = "completed";
            await sql.query(
              "INSERT INTO km_build_results(tenant_id,course_id,version_id,cache_key,proposal_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
              [...scope, d.versionId, cacheKey, d.proposalId],
            );
          } else d.status = "processing";
        }
      } else {
        d.status = "completed";
        d.completedSteps = 1;
      }
    } catch (e) {
      d.status = "failed";
      d.error = e instanceof Error ? e.message : "processing_failed";
    }
    const status =
      d.status === "failed"
        ? "failed"
        : job.documents.every((v) => v.status === "completed")
          ? "completed"
          : "processing";
    await sql.query(
      "UPDATE km_build_jobs SET documents=CASE WHEN status='processing' THEN $5::jsonb ELSE documents END,status=CASE WHEN status='processing' THEN $6 ELSE status END,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE tenant_id=$1 AND course_id=$2 AND id=$3 AND lease_token=$4",
      [...scope, job.id, token, JSON.stringify(job.documents), status],
    );
  }
}
