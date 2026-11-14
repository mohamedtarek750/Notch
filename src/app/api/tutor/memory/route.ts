import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { readMemory, updateMemory } from "@/server/tutor-memory";
import { sourceErrorResponse } from "@/server/sources";
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("clear-current") }),
  z.object({
    action: z.literal("correct"),
    id: z.string().min(1),
    correction: z.string().trim().min(1).max(3000),
  }),
]);
export async function GET(req: Request) {
  try {
    return Response.json(
      await readMemory(
        await requireAuth(req),
        new URL(req.url).searchParams.get("archived") === "1",
      ),
    );
  } catch (e) {
    return sourceErrorResponse(e, req.headers.get("accept-language") || "ar");
  }
}
export async function POST(req: Request) {
  try {
    return Response.json(
      await updateMemory(await requireAuth(req), input.parse(await req.json())),
    );
  } catch (e) {
    return sourceErrorResponse(e, req.headers.get("accept-language") || "ar");
  }
}
export async function DELETE(req: Request) {
  try {
    const ctx = await requireAuth(req);
    const { id } = z.object({ id: z.string().min(1) }).parse(await req.json());
    return Response.json(await updateMemory(ctx, { action: "delete", id }));
  } catch (e) {
    return sourceErrorResponse(e, req.headers.get("accept-language") || "ar");
  }
}
