import type { AuthContext } from "./auth";
import type { Queryable } from "./db";

/** Keep the reevaluation request in the same transaction as the new teaching release. */
export async function queueCrossCourseRechecks(
  tx: Queryable,
  ctx: AuthContext,
  releaseId: string,
  newConcepts: string[],
  newReferences: string[],
) {
  if (!newConcepts.length && !newReferences.length) return [];
  const result = await tx.query<{ course_id: string }>(
    `WITH terms AS (
       SELECT DISTINCT lower(term.value) term
       FROM km_memberships m CROSS JOIN LATERAL jsonb_array_elements_text(
         jsonb_build_array(m.data->'label'->>'en',m.data->'label'->>'ar') || COALESCE(m.data->'aliases','[]'::jsonb)
       ) term(value)
       WHERE m.tenant_id=$1 AND m.course_id=$2 AND m.concept_id=ANY($5::text[]) AND length(trim(term.value))>=4
       AND EXISTS (SELECT 1 FROM km_citations k JOIN evidence_chunks e ON e.tenant_id=k.tenant_id AND e.id=k.evidence_id
         JOIN material_versions v ON v.tenant_id=e.tenant_id AND v.id=e.version_id
         WHERE k.tenant_id=m.tenant_id AND k.course_id=m.course_id AND k.concept_id=m.concept_id
         AND v.course_id=$2 AND v.current_version AND v.role='instructor' AND e.status='approved')
     ), siblings AS (
       SELECT DISTINCT other.course_id FROM records own JOIN records other ON other.tenant_id=own.tenant_id
         AND other.kind='course' AND other.data->>'majorId'=own.data->>'majorId' AND other.course_id<>own.course_id
       JOIN course_access a ON a.tenant_id=other.tenant_id AND a.course_id=other.course_id AND a.user_id=$3 AND a.active
       WHERE own.tenant_id=$1 AND own.course_id=$2 AND own.kind='course'
     ), matched AS (
       SELECT DISTINCT v.course_id,v.id,v.source_key,v.title FROM siblings s JOIN material_versions v ON v.tenant_id=$1 AND v.course_id=s.course_id
       WHERE v.current_version AND v.role='instructor' AND v.rights->>'sendToModel'='true'
       AND EXISTS (SELECT 1 FROM evidence_chunks e JOIN km_citations k ON k.tenant_id=e.tenant_id AND k.evidence_id=e.id
         JOIN km_memberships m ON m.tenant_id=k.tenant_id AND m.course_id=k.course_id AND m.concept_id=k.concept_id
         WHERE e.tenant_id=$1 AND e.version_id=v.id AND e.status='approved' AND k.course_id=v.course_id
         AND COALESCE(m.data->>'scope','course')<>'foundation')
       AND (EXISTS (SELECT 1 FROM material_versions source JOIN evidence_chunks e ON e.tenant_id=source.tenant_id AND e.version_id=source.id
         WHERE source.tenant_id=$1 AND source.course_id=v.course_id AND source.current_version AND source.rights->>'sendToModel'='true'
         AND source.rights->>'displayExcerpt'='true' AND (source.id=v.id OR source.role='umbrella') AND e.status='approved'
         AND EXISTS (SELECT 1 FROM terms t WHERE strpos(lower(e.text_content),t.term)>0))
       OR EXISTS (SELECT 1 FROM evidence_chunks page JOIN km_citations k ON k.tenant_id=page.tenant_id AND k.evidence_id=page.id
         JOIN km_memberships m ON m.tenant_id=k.tenant_id AND m.course_id=k.course_id AND m.concept_id=k.concept_id
         CROSS JOIN LATERAL jsonb_each_text(m.data->'label') name(language,value)
         WHERE page.tenant_id=$1 AND page.version_id=v.id AND page.status='approved' AND k.course_id=v.course_id
         AND COALESCE(m.data->>'scope','course')<>'foundation' AND length(trim(name.value))>=4
         AND EXISTS (SELECT 1 FROM evidence_chunks ref JOIN material_versions source ON source.tenant_id=ref.tenant_id AND source.id=ref.version_id
           WHERE ref.tenant_id=$1 AND ref.version_id=ANY($7::text[]) AND ref.status='approved'
           AND source.rights->>'sendToModel'='true' AND source.rights->>'displayExcerpt'='true'
           AND strpos(lower(ref.text_content),lower(name.value))>0)))
     )
     INSERT INTO km_build_jobs(tenant_id,id,course_id,owner_id,locale,status,request_key,documents)
       SELECT $1,gen_random_uuid()::text,course_id,$3,$4,'queued','publication:' || $6,
       jsonb_agg(jsonb_build_object('versionId',id,'sourceKey',source_key,'title',title,'role','instructor',
         'cacheKey','publication:' || $6,'recheckPublished',true,'automatic',true,'status','queued','completedSteps',0,
         'error',NULL,'proposalId',NULL) ORDER BY id) FROM matched GROUP BY course_id
       ON CONFLICT DO NOTHING RETURNING course_id`,
    [
      ctx.tenantId,
      ctx.courseId,
      ctx.userId,
      ctx.locale,
      newConcepts,
      releaseId,
      newReferences,
    ],
  );
  return result.rows.map((row) => row.course_id);
}
