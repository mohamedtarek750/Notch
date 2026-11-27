import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { authorizeCourse, type AuthContext } from "./auth";
import { db } from "./db";
import { AppError } from "./errors";
import { extractStep } from "./prerequisites";
import type { BuildJob, BuildDocument } from "./build-job-types";

const columns = 'id,course_id AS "courseId",status,documents,created_at AS "createdAt",updated_at AS "updatedAt"';
const action = z.discriminatedUnion("action", [
  z.object({action:z.literal("create"),documentIds:z.array(z.string().max(200)).min(1).max(300)}),
  z.object({action:z.enum(["cancel","retry"]),id:z.uuid()}),
]);
export async function listJobs(ctx:AuthContext) {
  await authorizeCourse(ctx,ctx.courseId,"write");
  return (await db.tenant(ctx.tenantId).query<BuildJob>("SELECT "+columns+" FROM km_build_jobs WHERE tenant_id=$1 AND course_id=$2 ORDER BY created_at DESC LIMIT 30",[ctx.tenantId,ctx.courseId])).rows;
}
export async function changeJob(ctx:AuthContext, raw:unknown) {
  await authorizeCourse(ctx,ctx.courseId,"generate");
  const input=action.parse(raw), scope=[ctx.tenantId,ctx.courseId];
  return db.tenant(ctx.tenantId).transaction(async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",scope);
    if(input.action!=="create") {
      const job=(await tx.query<BuildJob>("SELECT "+columns+" FROM km_build_jobs WHERE tenant_id=$1 AND course_id=$2 AND id=$3 FOR UPDATE",[...scope,input.id])).rows[0];
      if(!job) throw new AppError(404,"NOT_FOUND");
      const cancel=input.action==="cancel";
      if(!(cancel?["queued","processing"]:["cancelled","failed"]).includes(job.status)) throw new AppError(409,"INVALID_INPUT");
      const docs=job.documents.map(d=>d.status==="completed"?d:{...d,error:null,status:cancel?"cancelled":"queued"});
      return (await tx.query<BuildJob>("UPDATE km_build_jobs SET status=$4,documents=$5,updated_at=now() WHERE tenant_id=$1 AND course_id=$2 AND id=$3 RETURNING "+columns,[...scope,job.id,cancel?"cancelled":"queued",JSON.stringify(docs)])).rows[0];
    }
    const ids=[...new Set(input.documentIds)].sort();
    const docs=(await tx.query<BuildDocument>(`SELECT id AS "versionId",source_key AS "sourceKey",title,role FROM material_versions WHERE tenant_id=$1 AND course_id=$2 AND current_version AND role IN ('instructor','umbrella') AND id=ANY($3::text[]) ORDER BY id`,[...scope,ids])).rows;
    if(docs.length!==ids.length) throw new AppError(400,"INVALID_INPUT");
    const snapshot=(await tx.query<{key:string}>("SELECT md5(coalesce(string_agg(c.id,',' ORDER BY c.id),'')) AS key FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE v.tenant_id=$1 AND v.course_id=$2 AND v.current_version AND v.role='umbrella' AND c.status='approved'",scope)).rows[0].key;
    const key=createHash("sha256").update(JSON.stringify([ids,snapshot])).digest("hex");
    const old=(await tx.query<BuildJob>("SELECT "+columns+" FROM km_build_jobs WHERE tenant_id=$1 AND course_id=$2 AND request_key=$3 AND status IN ('completed','processing','queued') ORDER BY created_at DESC LIMIT 1",[...scope,key])).rows[0];
    if(old) return old;
    return (await tx.query<BuildJob>("INSERT INTO km_build_jobs(tenant_id,course_id,id,owner_id,locale,status,request_key,documents) VALUES($1,$2,$3,$4,$5,'queued',$6,$7) RETURNING "+columns,[...scope,randomUUID(),ctx.userId,ctx.locale,key,JSON.stringify(docs.map(d=>({...d,status:"queued",completedSteps:0,error:null,proposalId:null})))])).rows[0];
  });
}
export async function drainCourse(tenantId:string,courseId:string) {
  const sql=db.tenant(tenantId), scope=[tenantId,courseId], end=Date.now()+160000;
  while(Date.now()<end) {
    const token=randomUUID();
    const job=await sql.transaction(async tx=>{
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",scope);
      return (await tx.query<BuildJob & {owner_id:string;locale:"en"|"ar"}>("UPDATE km_build_jobs SET status='processing',lease_token=$3,lease_until=now()+interval '6 minutes',updated_at=now() WHERE tenant_id=$1 AND course_id=$2 AND id=(SELECT id FROM km_build_jobs WHERE tenant_id=$1 AND course_id=$2 AND status IN ('queued','processing') ORDER BY created_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM km_build_jobs WHERE tenant_id=$1 AND course_id=$2 AND lease_until>now()) RETURNING "+columns+",owner_id,locale",[...scope,token])).rows[0];
    });
    if(!job) return;
    const d=job.documents.find(doc=>doc.status!=="completed")!;
    try {
      const ctx:AuthContext={tenantId,courseId,userId:job.owner_id,role:"instructor",locale:job.locale};
      await authorizeCourse(ctx,courseId,"generate");
      if(!(await sql.query("SELECT 1 FROM material_versions WHERE tenant_id=$1 AND course_id=$2 AND id=$3 AND current_version",[...scope,d.versionId])).rows.length) throw new Error("version_changed");
      if(d.role==="instructor") {
        const result=await extractStep(ctx,{lectureSourceKey:d.sourceKey});
        d.completedSteps++;
        if(result.done){d.proposalId=result.proposal.id;d.status="completed";} else d.status="processing";
      } else { d.status="completed";d.completedSteps=1; }
    } catch(e) {d.status="failed";d.error=e instanceof Error?e.message:"processing_failed";}
    const status=d.status==="failed"?"failed":job.documents.every(v=>v.status==="completed")?"completed":"processing";
    await sql.query("UPDATE km_build_jobs SET documents=CASE WHEN status='processing' THEN $5::jsonb ELSE documents END,status=CASE WHEN status='processing' THEN $6 ELSE status END,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE tenant_id=$1 AND course_id=$2 AND id=$3 AND lease_token=$4",[...scope,job.id,token,JSON.stringify(job.documents),status]);
  }
}
