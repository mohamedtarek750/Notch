import { requireAuth } from "@/server/auth";
import { after } from "next/server";
import { drainCourse } from "@/server/build-jobs";
import {
  editTeaching,
  generateTeaching,
  getKnowledge,
  proposeKnowledge,
  reviewProposal,
  publishKnowledge,
  editTree,
  saveTreeLayout,
  stageComprehensiveGraph,
  proposalScope,
  type Graph,
} from "@/server/knowledge";
import { knowledgeErrorResponse } from "@/server/coverage";
import {
  extractPrerequisites,
  extractStep,
  extractionQuality,
  reviewPrerequisiteEdges,
} from "@/server/prerequisites";
import {
  bankCoverage,
  bankStep,
  reviewBank,
  generateBank,
  getBankSettings,
  saveBankSettings,
} from "@/server/question-bank";
import { z } from "zod";
import { GeminiGateway, indexEmbeddings } from "@/server/ai";
export const runtime = "nodejs";
export const maxDuration = 300;
const input = z.object({
  action: z.enum([
    "propose",
    "review",
    "publish",
    "generate",
    "edit",
    "stage-comprehensive",
    "extract-prerequisites",
    "extract-step",
    "review-edges",
    "bank-settings",
    "generate-bank",
    "bank-step",
    "bank-review",
    "tree-edit",
    "tree-layout",
  ]),
  settings: z.unknown().optional(),
  conceptIds: z.unknown().optional(),
  lectureSourceKey: z.string().optional(),
  accept: z.unknown().optional(),
  resolutions: z.unknown().optional(),
  rejectConcepts: z.unknown().optional(),
  id: z.string().optional(),
  status: z.enum(["approved", "rejected"]).optional(),
  data: z.unknown().optional(),
  item: z.unknown().optional(),
  session: z.unknown().optional(),
  scope: proposalScope.optional(),
});
export async function GET(req: Request) {
  try {
    const ctx = await requireAuth(req, undefined, true);
    const knowledge = await getKnowledge(ctx);
    return Response.json(
      ctx.role === "instructor"
        ? {
            ...knowledge,
            extractionQuality: extractionQuality(
              knowledge.proposals as { data: Record<string, any> }[],
            ),
            bank: {
              settings: await getBankSettings(ctx),
              coverage: await bankCoverage(ctx),
            },
          }
        : knowledge,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return knowledgeErrorResponse(
      e,
      req.headers.get("accept-language") || "ar",
    );
  }
}
export async function POST(req: Request) {
  try {
    const ctx = await requireAuth(req, ["instructor"], true);
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > 2_000_000)
      return Response.json(
        {
          error: "graph_size",
          message: req.headers.get("accept-language")?.startsWith("en")
            ? "The submitted map is too large."
            : "حجم الخريطة المرسلة أكبر من المسموح.",
        },
        { status: 413 },
      );
    const body = input.parse(JSON.parse(raw));
    if (body.action === "extract-step")
      return Response.json(
        await extractStep(ctx, { lectureSourceKey: body.lectureSourceKey }),
      );
    if (body.action === "extract-prerequisites")
      return Response.json(
        await extractPrerequisites(ctx, undefined, {
          lectureSourceKey: body.lectureSourceKey,
        }),
      );
    if (body.action === "tree-layout")
      return Response.json(await saveTreeLayout(ctx, body.data));
    if (body.action === "tree-edit") {
      // From the shared tree a line may belong to another course; access is checked there.
      const target = (body.data as { courseId?: unknown } | undefined)
        ?.courseId;
      return Response.json(
        await editTree(
          typeof target === "string" && target
            ? { ...ctx, courseId: target }
            : ctx,
          body.data,
        ),
      );
    }
    if (body.action === "bank-settings")
      return Response.json(await saveBankSettings(ctx, body.settings));
    if (body.action === "generate-bank")
      return Response.json(
        await generateBank(ctx, undefined, { conceptIds: body.conceptIds }),
      );
    if (body.action === "bank-step")
      return Response.json(await bankStep(ctx, undefined, body.data));
    if (body.action === "bank-review")
      return Response.json(await reviewBank(ctx, body.data));
    if (body.action === "review-edges")
      return Response.json(
        await reviewPrerequisiteEdges(ctx, {
          id: body.id,
          accept: body.accept,
          resolutions: body.resolutions,
          rejectConcepts: body.rejectConcepts ?? [],
        }),
      );
    if (body.action === "stage-comprehensive")
      return Response.json(await stageComprehensiveGraph(ctx, body.data));
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
      return Response.json(await proposeKnowledge(ctx, undefined, body.scope));
    if (body.action === "publish") {
      const release = await publishKnowledge(ctx);
      if (release.recheckCourses.length) after(async () => {
        const deadline = Date.now() + 80000;
        for (const id of release.recheckCourses) {
          if (Date.now() >= deadline) break;
          await drainCourse(ctx.tenantId,id).catch(error => console.error("Automatic knowledge recheck failed",error));
        }
      });
      // Best effort: the tutor also tops the index up on demand.
      const index = await indexEmbeddings(ctx, new GeminiGateway(), 200).catch(
        () => ({ indexed: 0 }),
      );
      return Response.json({ ...release, ...index });
    }
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
    return knowledgeErrorResponse(
      e,
      req.headers.get("accept-language") || "ar",
    );
  }
}
