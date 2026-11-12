import { requireAuth } from "@/server/auth";
import { getMaterialFile, sourceErrorResponse } from "@/server/sources";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const row = await getMaterialFile(
      await requireAuth(req),
      (await params).id,
    );
    return new Response(new Uint8Array(row.bytes), {
      headers: {
        "Content-Type": row.mime_type,
        "Content-Disposition": `inline; filename="${row.filename.replace(/[^\w. -]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return sourceErrorResponse(e, req.headers.get("accept-language") || "ar");
  }
}
