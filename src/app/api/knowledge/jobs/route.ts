import { after } from "next/server";
import { requireAuth } from "@/server/auth";
import { AppError,errorResponse,localeFrom } from "@/server/errors";
import { changeJob,listJobs,drainCourse } from "@/server/build-jobs";
export const maxDuration=300;
async function handle(req:Request,write:boolean){
  try{
    if(!req.headers.get("X-Notch-Course")) throw new AppError(400,"INVALID_INPUT");
    const ctx=await requireAuth(req,["instructor"],true);
    const result=write?{job:await changeJob(ctx,await req.json())}:{jobs:await listJobs(ctx)};
    if(write || result.jobs?.some(j=>j.status==="queued"||j.status==="processing")) after(()=>drainCourse(ctx.tenantId,ctx.courseId));
    return Response.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch(e){return errorResponse(e,localeFrom(req));}
}
export const GET=(req:Request)=>handle(req,false);
export const POST=(req:Request)=>handle(req,true);
