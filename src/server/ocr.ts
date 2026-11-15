import { randomUUID } from "node:crypto";
import { db } from "./db";
import { type AuthContext } from "./auth";
import { COURSE, SourceError, reviseMaterialExtracts, staff } from "./sources";
import {
  GeminiGateway,
  prepareStaffGeneration,
  saveTrace,
  type ModelGateway,
} from "./ai";

/** A page whose text layer is this short is a picture of a slide, or a title over a figure. */
export const SPARSE_PAGE_CHARS = 60;
const MAX_PAGES_PER_RUN = 8;

/**
 * Read image-only or nearly empty PDF pages with the model. The transcription becomes a new
 * extraction revision whose pages are all pending: the instructor checks each one against
 * the original before it can be approved, cited or sent to a learner.
 */
export async function transcribeSparsePages(
  ctx: AuthContext,
  versionId: string,
  gateway: ModelGateway = new GeminiGateway(),
) {
  await staff(ctx, "publish");
  if (!gateway.transcribe) throw new SourceError("provider_unconfigured", 503);
  const prepared = await prepareStaffGeneration(ctx);
  const scoped = db.tenant(ctx.tenantId);
  const version = (
    await scoped.query<{
      bytes: Buffer | null;
      mime_type: string | null;
      rights: Record<string, boolean>;
    }>(
      "SELECT bytes,mime_type,rights FROM material_versions WHERE tenant_id=$1 AND id=$2 AND course_id=$3 AND current_version=true",
      [ctx.tenantId, versionId, ctx.courseId],
    )
  ).rows[0];
  if (!version) throw new SourceError("stale_source", 409);
  if (
    !version.bytes ||
    version.mime_type !== "application/pdf" ||
    !version.rights.sendToModel
  )
    throw new SourceError("unsupported_file", 400);
  const sparse = (
    await scoped.query<{ id: string; page: number }>(
      "SELECT id,page FROM evidence_chunks WHERE tenant_id=$1 AND version_id=$2 AND page IS NOT NULL AND length(text_content) < $3 ORDER BY page LIMIT $4",
      [ctx.tenantId, versionId, SPARSE_PAGE_CHARS, MAX_PAGES_PER_RUN + 1],
    )
  ).rows;
  if (!sparse.length) return { versionId, transcribed: 0, remaining: 0 };
  const batch = sparse.slice(0, MAX_PAGES_PER_RUN);
  const base = {
    id: randomUUID(),
    operation: "transcribe-pages",
    policyVersion: prepared.policyVersion,
    retrievedAt: new Date().toISOString(),
    evidenceIds: batch.map((c) => c.id),
    modelId: gateway.modelId,
  };
  await saveTrace(ctx, { ...base, outcome: "retrieved" });
  const generatedAt = new Date().toISOString();
  let result: Awaited<ReturnType<NonNullable<ModelGateway["transcribe"]>>>;
  try {
    result = await gateway.transcribe(
      new Uint8Array(version.bytes),
      batch.map((c) => c.page),
    );
  } catch (error) {
    await saveTrace(ctx, {
      ...base,
      generatedAt,
      outcome:
        error instanceof SourceError ? error.code : "provider_unavailable",
    });
    throw error;
  }
  const corrections = batch.flatMap((chunk) => {
    const text = result.pages
      .find((p) => p.page === chunk.page)
      ?.text?.trim()
      .slice(0, 30000);
    // A page the model could not read stays as it was, for a manual extract.
    return text && text.length >= 20
      ? [
          {
            chunkId: chunk.id,
            text,
            note: `Model transcription of a page with no usable text layer (${gateway.modelId}). Check against the original page before approval.`,
          },
        ]
      : [];
  });
  await saveTrace(ctx, {
    ...base,
    generatedAt,
    outcome: corrections.length ? "pending_review" : "invalid_output",
    tokens: result.tokens,
  });
  if (!corrections.length) throw new SourceError("invalid_output", 422);
  const revision = await reviseMaterialExtracts(ctx, versionId, corrections);
  return {
    versionId: revision.id,
    transcribed: corrections.length,
    unreadable: batch.length - corrections.length,
    remaining: Math.max(0, sparse.length - batch.length),
  };
}
