import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./db";
import {
  authorizeCourse,
  type AuthContext,
  type CourseOperation,
} from "./auth";
import manifest from "../../pilot/source-manifest.json";

export const COURSE = "CET351";
export const MAX_FILE = 3_500_000;
export const sourceManifest = manifest.sources;
export class SourceError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export const sourceMessages: Record<string, [string, string]> = {
  file_size: [
    "حجم الملف أكبر من الحد المسموح (٣٫٥ ميجابايت).",
    "File exceeds the 3.5 MB limit.",
  ],
  invalid_pdf: ["الملف ليس PDF صالحًا.", "The file is not a valid PDF."],
  hash_mismatch: [
    "بصمة الملف لا تطابق النسخة الأصلية في الحزمة.",
    "File checksum does not match the original pack.",
  ],
  page_mismatch: [
    "عدد الصفحات لا يطابق البيان.",
    "Page count does not match the manifest.",
  ],
  source_missing: [
    "المصدر غير موجود أو لا تملك صلاحية فتحه.",
    "Source missing or inaccessible.",
  ],
  forbidden: [
    "ليست لديك صلاحية لتنفيذ هذا الإجراء.",
    "You are not allowed to perform this action.",
  ],
  parse_failed: [
    "تعذّرت قراءة الملف. جرّب ملفًا نصيًا أو أرفق نصًا مصححًا.",
    "Could not parse this file. Attach a corrected extract.",
  ],
  unknown_source: [
    "اختر أحد ملفات المحاضرات الستة المعروفة.",
    "Choose one of the six expected lecture files.",
  ],
};
export function sourceErrorResponse(error: unknown, language = "ar") {
  const e = error as {
    status?: number;
    code?: string;
    message?: string;
    name?: string;
  };
  if (e.name === "ZodError")
    return Response.json(
      {
        error: "invalid_input",
        message:
          language === "en"
            ? "Check the submitted fields."
            : "راجع الحقول المرسلة.",
      },
      { status: 400 },
    );
  const code =
    e.code ||
    (e.message && sourceMessages[e.message] ? e.message : "unavailable");
  const texts = sourceMessages[code] || [
    "الخدمة غير متاحة مؤقتًا. حاول مرة أخرى.",
    "Service temporarily unavailable. Please retry.",
  ];
  return Response.json(
    { error: code, message: texts[language === "en" ? 1 : 0] },
    { status: e.status || 503 },
  );
}
export async function staff(
  ctx: AuthContext,
  operation: CourseOperation = "write",
) {
  await authorizeCourse(ctx, COURSE, operation);
  if (ctx.role !== "instructor") throw new SourceError("forbidden", 403);
}
export const hashBytes = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export type Material = {
  id: string;
  source_key: string;
  title: string;
  role: string;
  hash: string;
  status: string;
  page_count: number | null;
  rights: Record<string, boolean>;
  metadata: Record<string, unknown>;
  current_version: boolean;
};
export type Evidence = {
  id: string;
  version_id: string;
  source_key: string;
  title: string;
  page: number | null;
  section: string | null;
  text_content: string;
  language: string;
  status: string;
  review_note: string | null;
  role: string;
  hash: string;
};
export async function registerPack(ctx: AuthContext) {
  await staff(ctx);
  for (const entry of sourceManifest) {
    const sourceKey = entry.source_key;
    const metadata = { ...entry, registeredBy: ctx.userId, contentUsed: false };
    const isLink = "url" in entry;
    const h = hashBytes(JSON.stringify(metadata));
    await db.tenant(ctx.tenantId).query(
      `INSERT INTO material_versions(tenant_id,id,course_id,source_key,title,role,hash,rights,metadata,status,current_version)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false) ON CONFLICT(tenant_id,source_key,hash) DO NOTHING`,
      [
        ctx.tenantId,
        `registration-${sourceKey}`,
        COURSE,
        sourceKey,
        "title" in entry ? entry.title : sourceKey,
        entry.role,
        h,
        JSON.stringify({
          link: true,
          extract: false,
          embed: false,
          displayExcerpt: false,
          sendToModel: false,
        }),
        JSON.stringify(metadata),
        isLink ? "reference_link" : "awaiting_upload",
      ],
    );
  }
  const supplement = await fs.readFile(
    path.join(process.cwd(), "pilot/umbrella/tilwa-ml-foundations.md"),
    "utf8",
  );
  return importSupplement(ctx, supplement);
}
export async function listMaterials(ctx: AuthContext) {
  await authorizeCourse(ctx, COURSE, "read");
  const rows = (
    await db
      .tenant(ctx.tenantId)
      .query<Material>(
        "SELECT id,source_key,title,role,hash,status,page_count,rights,metadata,current_version FROM material_versions WHERE tenant_id=$1 AND course_id=$2 ORDER BY source_key,created_at DESC",
        [ctx.tenantId, COURSE],
      )
  ).rows;
  return {
    materials: sourceManifest.map((entry) => ({
      sourceKey: entry.source_key,
      title: "title" in entry ? entry.title : entry.source_key,
      filename: "filename" in entry ? entry.filename : null,
      expectedPages: "physical_pages" in entry ? entry.physical_pages : null,
      versions: rows.filter((r) => r.source_key === entry.source_key),
      status:
        rows.find((r) => r.source_key === entry.source_key && r.current_version)
          ?.status ||
        rows.find((r) => r.source_key === entry.source_key)?.status ||
        "not_registered",
    })),
    gfg: {
      registered: rows.some((r) => r.source_key === "GFG-UMBRELLA"),
      textUsed: rows.some(
        (r) => r.source_key === "GFG-UMBRELLA" && r.rights.sendToModel,
      ),
    },
  };
}
export async function parsePdf(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_FILE) throw new SourceError("file_size");
  if (Buffer.from(bytes.slice(0, 5)).toString() !== "%PDF-")
    throw new SourceError("invalid_pdf");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: true,
    disableFontFace: true,
    stopAtErrors: true,
  });
  const timer = setTimeout(() => {
    void task.destroy();
  }, 20000);
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 100) throw new SourceError("parse_failed");
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 30000),
      );
      page.cleanup();
    }
    await task.destroy();
    return pages;
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("parse_failed");
  } finally {
    clearTimeout(timer);
  }
}
export async function importLecture(
  ctx: AuthContext,
  filename: string,
  bytes: Uint8Array,
  options: { allowNewVersion?: boolean } = {},
) {
  await staff(ctx);
  const safeName = path.basename(filename).normalize("NFC");
  const entry = sourceManifest.find(
    (e) => "filename" in e && e.filename === safeName,
  );
  if (!entry || !("physical_pages" in entry))
    throw new SourceError("unknown_source");
  const hash = hashBytes(bytes);
  if (!options.allowNewVersion && hash !== entry.sha256)
    throw new SourceError("hash_mismatch");
  const previous = (
    await db
      .tenant(ctx.tenantId)
      .query<Material>(
        "SELECT * FROM material_versions WHERE tenant_id=$1 AND source_key=$2 AND hash=$3",
        [ctx.tenantId, entry.source_key, hash],
      )
  ).rows[0];
  if (previous)
    return { id: previous.id, deduplicated: true, pages: previous.page_count };
  const pages = await parsePdf(bytes);
  if (!options.allowNewVersion && pages.length !== entry.physical_pages)
    throw new SourceError("page_mismatch");
  return persistMaterial(ctx, {
    sourceKey: entry.source_key,
    title: entry.title || safeName,
    role: "instructor",
    filename: safeName,
    mime: "application/pdf",
    bytes,
    hash,
    pages: pages.map((text, i) => ({ text, page: i + 1, section: null })),
    metadata: {
      manifestVerified: hash === entry.sha256,
      expectedPages: entry.physical_pages,
      reviewNote: entry.review_note,
    },
  });
}
type NewMaterial = {
  sourceKey: string;
  title: string;
  role: "instructor" | "umbrella";
  filename: string;
  mime: string;
  bytes: Uint8Array;
  hash: string;
  pages: { text: string; page: number | null; section: string | null }[];
  metadata: Record<string, unknown>;
};
async function persistMaterial(ctx: AuthContext, input: NewMaterial) {
  let id: string = randomUUID();
  let changed = 0;
  let deduplicated = false;
  await db.tenant(ctx.tenantId).transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      ctx.tenantId + ":source:" + input.sourceKey,
    ]);
    const existing = (
      await tx.query<{ id: string }>(
        "SELECT id FROM material_versions WHERE tenant_id=$1 AND source_key=$2 AND hash=$3",
        [ctx.tenantId, input.sourceKey, input.hash],
      )
    ).rows[0];
    if (existing) {
      id = existing.id;
      deduplicated = true;
      return;
    }
    const old = (
      await tx.query<{
        page: number | null;
        section: string | null;
        text_content: string;
      }>(
        `SELECT c.page,c.section,c.text_content FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE v.tenant_id=$1 AND v.source_key=$2 AND v.current_version=true`,
        [ctx.tenantId, input.sourceKey],
      )
    ).rows;
    await tx.query(
      "UPDATE material_versions SET current_version=false WHERE tenant_id=$1 AND source_key=$2",
      [ctx.tenantId, input.sourceKey],
    );
    await tx.query(
      `INSERT INTO material_versions(tenant_id,id,course_id,source_key,title,role,hash,filename,mime_type,bytes,page_count,rights,metadata,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')`,
      [
        ctx.tenantId,
        id,
        COURSE,
        input.sourceKey,
        input.title,
        input.role,
        input.hash,
        input.filename,
        input.mime,
        Buffer.from(input.bytes),
        input.pages.length,
        JSON.stringify({
          link: true,
          extract: true,
          embed: false,
          displayExcerpt: true,
          sendToModel: true,
        }),
        JSON.stringify(input.metadata),
      ],
    );
    for (const p of input.pages) {
      const flagged =
        (input.sourceKey === "CET351-L4" && p.page === 16) ||
        (input.sourceKey === "CET351-L5" &&
          [18, 21, 22, 23].includes(p.page ?? 0));
      const unreadable = p.text.length < 20;
      const prior = old.find(
        (v) => v.page === p.page && v.section === p.section,
      );
      const different = !prior || prior.text_content !== p.text;
      if (different) changed++;
      await tx.query(
        `INSERT INTO evidence_chunks(tenant_id,id,version_id,course_id,page,section,text_content,language,status,review_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          ctx.tenantId,
          `${id}-${p.section || p.page}`,
          id,
          COURSE,
          p.page,
          p.section,
          p.text,
          /\p{Script=Arabic}/u.test(p.text) ? "mixed" : "en",
          flagged || unreadable ? "quarantined" : "pending",
          flagged
            ? "Known numerical conflict: correction and instructor review required."
            : unreadable
              ? "Image-only or unreadable page: corrected extract required."
              : different
                ? "New/changed passage: review required."
                : "Unchanged passage in new source version: review required.",
        ],
      );
    }
  });
  return {
    id,
    deduplicated,
    pages: input.pages.length,
    changedPages: changed,
    status: "pending",
  };
}
export async function importSupplement(ctx: AuthContext, text: string) {
  await staff(ctx);
  const hash = hashBytes(text);
  const prior = (
    await db
      .tenant(ctx.tenantId)
      .query<{ id: string }>(
        "SELECT id FROM material_versions WHERE tenant_id=$1 AND source_key=$2 AND hash=$3",
        [ctx.tenantId, "TILWA-PILOT-FOUNDATIONS", hash],
      )
  ).rows[0];
  if (prior) return { id: prior.id, deduplicated: true };
  const sections = text.split(/(?=^## U\d)/m).filter((t) => /^## U\d/.test(t));
  return persistMaterial(ctx, {
    sourceKey: "TILWA-PILOT-FOUNDATIONS",
    title: "Tilwa supplementary foundations / أساسيات مساندة",
    role: "umbrella",
    filename: "tilwa-ml-foundations.md",
    mime: "text/markdown",
    bytes: Buffer.from(text),
    hash,
    pages: sections.map((t) => ({
      text: t.trim(),
      page: null,
      section: t.match(/^## (U\d)/)?.[1] ?? null,
    })),
    metadata: { originalSupplement: true, gfg: false },
  });
}
export async function getMaterial(ctx: AuthContext, id: string) {
  await authorizeCourse(ctx, COURSE, "read");
  const v = (
    await db
      .tenant(ctx.tenantId)
      .query<Material>(
        "SELECT id,source_key,title,role,hash,status,page_count,rights,metadata,current_version FROM material_versions WHERE tenant_id=$1 AND id=$2 AND course_id=$3",
        [ctx.tenantId, id, COURSE],
      )
  ).rows[0];
  if (
    !v ||
    (ctx.role !== "instructor" &&
      (v.status !== "published" || !v.rights.displayExcerpt))
  )
    throw new SourceError("source_missing", 404);
  const chunks = (
    await db
      .tenant(ctx.tenantId)
      .query<Evidence>(
        `SELECT c.*,v.source_key,v.title,v.role,v.hash FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE c.tenant_id=$1 AND c.version_id=$2 ${ctx.role !== "instructor" ? "AND c.status='approved'" : ""} ORDER BY c.page NULLS LAST,c.section`,
        [ctx.tenantId, id],
      )
  ).rows;
  return { material: v, chunks };
}
export async function getMaterialFile(ctx: AuthContext, id: string) {
  const { material } = await getMaterial(ctx, id);
  const row = (
    await db
      .tenant(ctx.tenantId)
      .query<{ bytes: Buffer; mime_type: string; filename: string }>(
        "SELECT bytes,mime_type,filename FROM material_versions WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId, id],
      )
  ).rows[0];
  if (!row?.bytes) throw new SourceError("source_missing", 404);
  // Students see approved extracts only: original PDF can contain quarantined/conflicting pages.
  if (ctx.role !== "instructor") throw new SourceError("forbidden", 403);
  return { material, ...row };
}
export async function reviewPage(
  ctx: AuthContext,
  id: string,
  status: "approved" | "rejected" | "quarantined",
  correctedText?: string,
) {
  await staff(ctx, "publish");
  const row = (
    await db
      .tenant(ctx.tenantId)
      .query<{ text_content: string; status: string; review_note: string }>(
        "SELECT text_content,status,review_note FROM evidence_chunks WHERE tenant_id=$1 AND id=$2 AND course_id=$3",
        [ctx.tenantId, id, COURSE],
      )
  ).rows[0];
  if (!row) throw new SourceError("source_missing", 404);
  if (status === "approved" && row.status === "quarantined" && !correctedText)
    throw new SourceError("parse_failed");
  if (correctedText) {
    // A correction creates a new extraction version; historical source IDs remain immutable.
    const version = (
      await db
        .tenant(ctx.tenantId)
        .query<{
          id: string;
          source_key: string;
          title: string;
          role: "instructor" | "umbrella";
          filename: string;
          mime_type: string;
          bytes: Buffer;
          hash: string;
          metadata: Record<string, unknown>;
        }>(
          `SELECT v.* FROM material_versions v JOIN evidence_chunks c ON c.tenant_id=v.tenant_id AND c.version_id=v.id WHERE c.tenant_id=$1 AND c.id=$2`,
          [ctx.tenantId, id],
        )
    ).rows[0];
    const all = (
      await db
        .tenant(ctx.tenantId)
        .query<{
          id: string;
          page: number | null;
          section: string | null;
          text_content: string;
        }>(
          "SELECT id,page,section,text_content FROM evidence_chunks WHERE tenant_id=$1 AND version_id=$2 ORDER BY page NULLS LAST,section",
          [ctx.tenantId, version.id],
        )
    ).rows;
    const pages = all.map((c) => ({
      text: c.id === id ? correctedText : c.text_content,
      page: c.page,
      section: c.section,
    }));
    const revision = await persistMaterial(ctx, {
      sourceKey: version.source_key,
      title: version.title,
      role: version.role,
      filename: version.filename,
      mime: version.mime_type,
      bytes: version.bytes,
      hash: hashBytes(version.hash + id + correctedText),
      pages,
      metadata: {
        ...version.metadata,
        correctedFrom: version.id,
        originalFileHash: version.metadata.originalFileHash || version.hash,
        extractionRevision: true,
      },
    });
    const original = all.find((c) => c.id === id)!;
    const correctedId = `${revision.id}-${original.section || original.page}`;
    await db
      .tenant(ctx.tenantId)
      .query(
        "UPDATE evidence_chunks SET status=$3,reviewed_by=$4,reviewed_at=now(),review_note=$5 WHERE tenant_id=$1 AND id=$2",
        [
          ctx.tenantId,
          correctedId,
          status,
          ctx.userId,
          "Corrected extract, original source version retained.",
        ],
      );
    await db
      .tenant(ctx.tenantId)
      .query(
        `INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'source_review',$3,$4,$5)`,
        [
          ctx.tenantId,
          randomUUID(),
          COURSE,
          ctx.userId,
          JSON.stringify({
            chunkId: id,
            successorChunkId: correctedId,
            status,
            reviewer: ctx.userId,
          }),
        ],
      );
    return { id: correctedId, versionId: revision.id, status };
  }
  await db
    .tenant(ctx.tenantId)
    .query(
      "UPDATE evidence_chunks SET status=$3,reviewed_by=$4,reviewed_at=now() WHERE tenant_id=$1 AND id=$2",
      [ctx.tenantId, id, status, ctx.userId],
    );
  await db
    .tenant(ctx.tenantId)
    .query(
      `INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'source_review',$3,$4,$5)`,
      [
        ctx.tenantId,
        randomUUID(),
        COURSE,
        ctx.userId,
        JSON.stringify({ chunkId: id, status, reviewer: ctx.userId }),
      ],
    );
  return { id, status };
}

export async function importAuthorizedPassage(
  ctx: AuthContext,
  input: {
    sourceKey: "GFG-UMBRELLA" | "CUSTOM-UMBRELLA";
    title: string;
    text: string;
    section: string;
    rightsConfirmed: true;
    rightsReference: string;
    url?: string;
  },
) {
  await staff(ctx);
  if (!input.rightsConfirmed || input.rightsReference.trim().length < 5)
    throw new SourceError("permission_required", 400);
  const hash = hashBytes(
    input.sourceKey + "\n" + input.section + "\n" + input.text,
  );
  return persistMaterial(ctx, {
    sourceKey: input.sourceKey,
    title: input.title,
    role: "umbrella",
    filename: "authorized-passage.txt",
    mime: "text/plain",
    bytes: Buffer.from(input.text),
    hash,
    pages: [{ text: input.text, page: null, section: input.section }],
    metadata: {
      url: input.url || null,
      authorization: {
        assertedBy: ctx.userId,
        reference: input.rightsReference,
        assertedAt: new Date().toISOString(),
      },
      contentUsed: false,
      manualAuthorizedPassage: true,
      originalSupplement: false,
    },
  });
}
