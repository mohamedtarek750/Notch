import { requireAuth } from "@/server/auth";
import {
  editTeaching,
  generateTeaching,
  getKnowledge,
  proposeKnowledge,
  reviewProposal,
  publishKnowledge,
  type Graph,
} from "@/server/knowledge";
import { sourceErrorResponse } from "@/server/sources";
import { z } from "zod";
export const runtime = "nodejs";
export const maxDuration = 60;
const input = z.object({
  action: z.enum(["propose", "review", "publish", "generate", "edit"]),
  id: z.string().optional(),
  status: z.enum(["approved", "rejected"]).optional(),
  data: z.unknown().optional(),
  item: z.unknown().optional(),
  session: z.unknown().optional(),
});
export async function GET(req: Request) {
  try {
    return Response.json(await getKnowledge(await requireAuth(req)));
  } catch (e) {
    return sourceErrorResponse(e, req.headers.get("accept-language") || "ar");
  }
}
export async function POST(req: Request) {
  try {
    const ctx = await requireAuth(req, ["instructor"]);
    const body = input.parse(await req.json());
    if (body.action === "edit") {
      if (!body.id)
        return Response.json({ error: "invalid_input" }, { status: 400 });
      return Response.json(
        await editTeaching(ctx, body.id, {
          item: body.item,
          session: body.session,
        }),
      );
    }
    if (body.action === "generate")
      return Response.json(await generateTeaching(ctx));
    if (body.action === "propose")
      return Response.json(await proposeKnowledge(ctx));
    if (body.action === "publish")
      return Response.json(await publishKnowledge(ctx));
    if (!body.id || !body.status)
      return Response.json({ error: "invalid_review" }, { status: 400 });
    return Response.json(
      await reviewProposal(
        ctx,
        body.id,
        body.status,
        body.data as Graph | undefined,
      ),
    );
  } catch (e) {
    return sourceErrorResponse(e, req.headers.get("accept-language") || "ar");
  }
}
