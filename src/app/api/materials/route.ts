import { z } from "zod";
import { requireAuth } from "@/server/auth";
import {
  importAuthorizedPassage,
  checkFingerprint,
  importLecture,
  importUmbrella,
  importExtractedPages,
  importCustomLecture,
  listMaterials,
  registerPack,
  sourceErrorResponse,
  MAX_FILE,
} from "@/server/sources";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(req: Request) {
  try {
    return Response.json(await listMaterials(await requireAuth(req, undefined, true)));
  } catch (e) {
    return sourceErrorResponse(e, req.headers.get("accept-language") || "ar");
  }
}
export async function POST(req: Request) {
  try {
    const ctx = await requireAuth(req, ["instructor"], true);
    if (Number(req.headers.get("content-length") || 0) > MAX_FILE + 10000)
      return Response.json({ error: "file_size" }, { status: 413 });
    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File))
        return Response.json({ error: "invalid_file" }, { status: 400 });
      if (form.get("kind") === "umbrella")
        return Response.json(
          await importUmbrella(ctx, {
            title: String(form.get("title") || ""),
            filename: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
            revisionOf: form.get("revisionOf") ? String(form.get("revisionOf")) : undefined,
            rightsConfirmed: form.get("rightsConfirmed") === "true",
            rightsReference: String(form.get("rightsReference") || ""),
            sourceKey: form.get("sourceKey")
              ? String(form.get("sourceKey"))
              : undefined,
          }),
        );
      if (form.get("kind") === "lecture")
        return Response.json(
          await importCustomLecture(ctx, {
            title: String(form.get("title") || ""),
            filename: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
            revisionOf: form.get("revisionOf") ? String(form.get("revisionOf")) : undefined,
            sourceKey: form.get("sourceKey")
              ? String(form.get("sourceKey"))
              : undefined,
          }),
        );
      return Response.json(
        await importLecture(
          ctx,
          file.name,
          new Uint8Array(await file.arrayBuffer()),
          { allowNewVersion: form.get("allowNewVersion") === "true" },
        ),
      );
    }
    const body = await req.json();
    if (body.action === "check-fingerprint")
      return Response.json(await checkFingerprint(ctx, body));
    if (body.action === "extracted-pages")
      return Response.json(await importExtractedPages(ctx, body));
    if (body.action === "authorized-passage") {
      const input = z
        .object({
          sourceKey: z.enum(["GFG-UMBRELLA", "CUSTOM-UMBRELLA"]),
          title: z.string().min(1).max(200),
          text: z.string().min(20).max(30000),
          section: z.string().min(1).max(100),
          rightsConfirmed: z.literal(true),
          rightsReference: z.string().min(5).max(500),
          url: z
            .url()
            .refine((v) => v.startsWith("https://"))
            .optional(),
        })
        .parse(body);
      return Response.json(await importAuthorizedPassage(ctx, input));
    }
    if (body.action !== "register-pack")
      return Response.json({ error: "invalid_action" }, { status: 400 });
    await registerPack(ctx);
    return Response.json(await listMaterials(ctx));
  } catch (e) {
    return sourceErrorResponse(e, req.headers.get("accept-language") || "ar");
  }
}
