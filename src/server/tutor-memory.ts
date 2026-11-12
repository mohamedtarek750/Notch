import { randomUUID } from "node:crypto";
import { db } from "./db";
import { authorizeCourse, type AuthContext } from "./auth";
import { COURSE, SourceError } from "./sources";
export async function readMemory(ctx: AuthContext, includeArchived = false) {
  await authorizeCourse(ctx, COURSE, "tutor");
  const rows = (
    await db
      .tenant(ctx.tenantId)
      .query<{ id: string; data: Record<string, unknown>; created_at: string }>(
        `SELECT id,data,created_at FROM records WHERE tenant_id=$1 AND owner_id=$2 AND course_id=$3 AND kind='tutor_memory' ${includeArchived ? "" : "AND COALESCE(data->>'archived','false') <> 'true'"} ORDER BY created_at DESC LIMIT 100`,
        [ctx.tenantId, ctx.userId, COURSE],
      )
  ).rows;
  const ids = rows.flatMap((r) =>
    Array.isArray(r.data.citations) ? (r.data.citations as string[]) : [],
  );
  const sources = ids.length
    ? (
        await db
          .tenant(ctx.tenantId)
          .query<{
            id: string;
            source_key: string;
            page: number | null;
            section: string | null;
            version_id: string;
            text_content: string;
          }>(
            `SELECT c.id,c.version_id,c.page,c.section,c.text_content,v.source_key FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE c.tenant_id=$1 AND c.course_id=$2 AND c.id=ANY($3::text[]) AND c.status='approved' AND v.rights->>'displayExcerpt'='true'`,
            [ctx.tenantId, COURSE, ids],
          )
      ).rows
    : [];
  return {
    messages: rows
      .reverse()
      .map((r) => ({
        ...r,
        data: {
          ...r.data,
          citations: sources
            .filter((c) =>
              ((r.data.citations as string[]) || []).includes(c.id),
            )
            .map((c) => ({
              id: c.id,
              sourceKey: c.source_key,
              page: c.page,
              section: c.section,
              text: c.text_content,
              url: `/sources/${c.version_id}?${c.page ? `page=${c.page}` : `section=${c.section}`}`,
            })),
        },
      })),
  };
}
export async function updateMemory(
  ctx: AuthContext,
  input: {
    action: "correct" | "delete" | "clear-current";
    id?: string;
    correction?: string;
  },
) {
  await authorizeCourse(ctx, COURSE, "read");
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    if (input.action === "clear-current") {
      await tx.query(
        "UPDATE records SET data=data||'{\"archived\":true}'::jsonb,updated_at=now() WHERE tenant_id=$1 AND owner_id=$2 AND course_id=$3 AND kind='tutor_memory'",
        [ctx.tenantId, ctx.userId, COURSE],
      );
    } else {
      const row = (
        await tx.query<{ data: Record<string, unknown> }>(
          "SELECT data FROM records WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND course_id=$4 AND kind='tutor_memory' FOR UPDATE",
          [ctx.tenantId, ctx.userId, input.id, COURSE],
        )
      ).rows[0];
      if (!row) throw new SourceError("source_missing", 404);
      if (input.action === "delete")
        await tx.query(
          "DELETE FROM records WHERE tenant_id=$1 AND id=$2 AND owner_id=$3",
          [ctx.tenantId, input.id, ctx.userId],
        );
      else
        await tx.query(
          "UPDATE records SET data=data||$4::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND owner_id=$3",
          [
            ctx.tenantId,
            input.id,
            ctx.userId,
            JSON.stringify({
              correction: input.correction,
              correctedAt: new Date().toISOString(),
            }),
          ],
        );
    }
    await tx.query(
      "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'memory_audit',$3,$4,$5)",
      [
        ctx.tenantId,
        randomUUID(),
        COURSE,
        ctx.userId,
        JSON.stringify({
          action: input.action,
          memoryId: input.id || null,
          at: new Date().toISOString(),
        }),
      ],
    );
    return { ok: true, action: input.action };
  });
}
