import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { AppError, errorResponse, localeFrom } from "@/server/errors";
import {
  ExternalContractSisAdapter,
  getOfficialGrades,
  SisContractError,
  SisResultSchema,
  syncSis,
  verifySisSignature,
} from "@/server/sis";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = await requireAuth(request, ["student"]);
    return Response.json(
      {
        grades: await getOfficialGrades(ctx.tenantId, ctx.userId),
        source: "sis",
        description: {
          ar: "نتائج رسمية من واجهة المسجّل؛ النتائج التجريبية مميزة بوضوح.",
          en: "Registrar result projections; synthetic demo results are explicitly marked.",
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, localeFrom(request));
  }
}
async function boundedBody(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length") ?? 0) > 131072)
    throw new AppError(413, "INVALID_INPUT");
  if (!request.body) throw new AppError(400, "INVALID_INPUT");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 131072) {
        await reader.cancel();
        throw new AppError(413, "INVALID_INPUT");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
/** Dedicated signed server feed. Interactive users cannot change official grades. */
export async function POST(request: Request): Promise<Response> {
  try {
    const secret = process.env.SIS_WEBHOOK_SECRET;
    const tenantId = process.env.SIS_TENANT_ID;
    if (!secret || !tenantId) throw new AppError(503, "PROVIDER_UNAVAILABLE");
    const body = await boundedBody(request);
    if (
      !verifySisSignature(
        body,
        request.headers.get("x-sis-timestamp"),
        request.headers.get("x-sis-signature"),
        secret,
      )
    )
      throw new AppError(401, "UNAUTHORIZED");
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new AppError(400, "INVALID_INPUT");
    }
    const batch = z
      .object({
        version: z.literal(1),
        events: z.array(SisResultSchema).min(1).max(25),
      })
      .strict()
      .parse(raw);
    if (batch.events.some((event) => event.tenantId !== tenantId))
      throw new AppError(403, "FORBIDDEN");
    const results = await syncSis(
      new ExternalContractSisAdapter(batch.events),
      tenantId,
    );
    return Response.json(
      { results, adapter: "external-contract" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SisContractError)
      return errorResponse(
        new AppError(
          error.code === "EVENT_CONFLICT" ? 409 : 403,
          error.code === "EVENT_CONFLICT" ? "INVALID_INPUT" : "FORBIDDEN",
        ),
        localeFrom(request),
      );
    return errorResponse(error, localeFrom(request));
  }
}
