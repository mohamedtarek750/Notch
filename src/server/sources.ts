import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { db, type Queryable } from "./db";
import {
  authorizeCourse,
  DEFAULT_COURSE,
  authorizeCourseInTransaction,
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
  provider_busy: [
    "النموذج مزدحم الآن عند المزوّد. انتظر دقيقة ثم أعد المحاولة؛ لم يتغيّر شيء في بياناتك.",
    "The model is overloaded at the provider right now. Wait a minute and try again; nothing in your data changed.",
  ],
  provider_quota: [
    "استُنفدت حصة النموذج المجانية مؤقتًا. انتظر دقيقة، وإن تكرر فالحصة اليومية انتهت وتتجدد غدًا.",
    "The model's free quota is used up for the moment. Wait a minute; if it repeats, the daily quota is finished and renews tomorrow.",
  ],
  provider_key: [
    "مفتاح النموذج غير مقبول عند المزوّد. راجع المفتاح في إعدادات الاستضافة.",
    "The provider did not accept the model key. Check the key in the hosting settings.",
  ],
  provider_rejected: [
    "رفض المزوّد الطلب بصيغته الحالية. أبلغ فريق المنصّة.",
    "The provider rejected the request as sent. Report this to the platform team.",
  ],
  provider_slow: [
    "تأخر ردّ النموذج أكثر من المهلة. أعد المحاولة بعد قليل.",
    "The model took longer than the time limit to answer. Try again shortly.",
  ],
  parse_failed: [
    "تعذّرت قراءة الملف. جرّب ملفًا نصيًا أو أرفق نصًا مصححًا.",
    "Could not parse this file. Attach a corrected extract.",
  ],
  unknown_source: [
    "اختر أحد ملفات المحاضرات الستة المعروفة.",
    "Choose one of the six expected lecture files.",
  ],
  stale_source: [
    "تغيّرت نسخة المصدر؛ افتح النسخة الحالية وأعد المراجعة.",
    "The source version changed; reopen the current version and review again.",
  ],
  umbrella_required: [
    "ارفع مرجعًا شاملًا واعتمد أقسامه أولًا؛ المتطلبات السابقة تُستخرج منه.",
    "Upload an umbrella reference and approve its sections first; prerequisites are extracted from it.",
  ],
  permission_required: [
    "أكّد أن لديك تصريحًا باستخدام هذا المرجع واذكر مرجع التصريح.",
    "Confirm you are permitted to use this reference and state the permission.",
  ],
  unsupported_file: [
    "ارفع المرجع بصيغة PDF أو نص عادي أو Markdown.",
    "Upload the reference as a PDF, plain text or Markdown file.",
  ],
  insufficient_evidence: [
    "لا توجد صفحات معتمدة كافية. راجع صفحات المصدر واعتمدها أولًا.",
    "Not enough approved pages. Review and approve the source pages first.",
  ],
  invalid_output: [
    "ردّ النموذج لم يجتز التحقق ولم يُحفظ منه شيء. أعد المحاولة.",
    "The model response failed validation and nothing was saved. Please retry.",
  ],
  rate_limited: [
    "وصلت إلى حد استخدام النموذج المؤقت. حاول بعد دقيقة.",
    "The temporary model usage limit was reached. Retry in a minute.",
  ],
  already_published: [
    "هذا المقترح منشور بالفعل.",
    "This proposal is already published.",
  ],
  invalid_review: [
    "راجع الصفحات المحددة وحالة اعتماد كل صفحة.",
    "Check the selected pages and their review decisions.",
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
  await authorizeCourse(ctx, ctx.courseId, operation);
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
        ctx.courseId,
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
/**
 * A reference uploaded in any course of a major serves every course of that major, so a
 * textbook is uploaded once. Returns the other courses of the open course's major.
 */
export async function majorCourses(
  ctx: AuthContext,
  // Inside a transaction, pass it: a second connection would wait on the first.
  sql: Queryable = db.tenant(ctx.tenantId),
): Promise<string[]> {
  return (
    await sql.query<{ course_id: string }>(
      `SELECT o.course_id FROM records me JOIN records o ON o.tenant_id=me.tenant_id AND o.kind='course' AND o.data->>'majorId'=me.data->>'majorId'
       WHERE me.tenant_id=$1 AND me.kind='course' AND me.course_id=$2 AND me.data->>'majorId' IS NOT NULL AND o.course_id<>$2`,
      [ctx.tenantId, ctx.courseId],
    )
  ).rows.map((r) => r.course_id);
}
/** A source is identified by its title within its course; the first course keeps the
 * original keys so material uploaded before courses existed is still recognised. */
const keyText = (ctx: AuthContext, title: string) =>
  (ctx.courseId === DEFAULT_COURSE ? "" : ctx.courseId + "\n") +
  title.normalize("NFKC").toLowerCase();
export const UMBRELLA_PREFIX = "UMBRELLA-";
const umbrellaKeyPattern = /^UMBRELLA-[0-9A-F]{12}$/;
/** Split an instructor-supplied text/Markdown reference into bounded, locatable sections. */
export function splitUmbrellaText(text: string) {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  const byHeading = clean
    .split(/(?=^#{1,3} \S)/m)
    .map((part) => part.trim())
    .filter(Boolean);
  const blocks =
    byHeading.length > 1 ? byHeading : clean.split(/\n{2,}/).filter(Boolean);
  const sections: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) sections.push(current.trim());
    current = "";
  };
  for (const block of blocks) {
    // A heading always starts a new section; plain paragraphs are packed together.
    if (byHeading.length > 1 || current.length + block.length > 1800) flush();
    let rest = block;
    while (rest.length > 6000) {
      const cut = rest.lastIndexOf("\n", 6000);
      const at = cut > 2000 ? cut : 6000;
      sections.push(rest.slice(0, at).trim());
      rest = rest.slice(at);
    }
    current += (current ? "\n\n" : "") + rest;
  }
  flush();
  return sections;
}
/** Instructor upload of the course umbrella reference (PDF, text or Markdown).
 * Sections stay pending until reviewed; nothing reaches a model or a learner before that. */
export async function importUmbrella(
  ctx: AuthContext,
  input: {
    title: string;
    filename: string;
    bytes: Uint8Array;
    rightsConfirmed: boolean;
    rightsReference: string;
    sourceKey?: string;
  },
) {
  await staff(ctx);
  const title = input.title.trim();
  if (!title || title.length > 200) throw new SourceError("invalid_review");
  if (!input.rightsConfirmed || input.rightsReference.trim().length < 5)
    throw new SourceError("permission_required", 400);
  if (input.bytes.byteLength > MAX_FILE) throw new SourceError("file_size");
  if (input.sourceKey && !umbrellaKeyPattern.test(input.sourceKey))
    throw new SourceError("invalid_review");
  const sourceKey =
    input.sourceKey ||
    UMBRELLA_PREFIX + hashBytes(keyText(ctx, title)).slice(0, 12).toUpperCase();
  const safeName = path.basename(input.filename || "umbrella").normalize("NFC");
  const isPdf = Buffer.from(input.bytes.slice(0, 5)).toString() === "%PDF-";
  let pages: NewMaterial["pages"];
  if (isPdf)
    pages = (await parsePdf(input.bytes)).map((text, i) => ({
      text,
      page: i + 1,
      section: null,
    }));
  else {
    if (input.bytes.includes(0) || !/\.(md|markdown|txt)$/i.test(safeName))
      throw new SourceError("unsupported_file");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    } catch {
      throw new SourceError("unsupported_file");
    }
    const sections = splitUmbrellaText(text);
    if (!sections.length || sections.length > 300)
      throw new SourceError("parse_failed");
    pages = sections.map((section, i) => ({
      text: section,
      page: null,
      section: `S${i + 1}`,
    }));
  }
  const result = await persistMaterial(ctx, {
    sourceKey,
    title,
    role: "umbrella",
    filename: safeName,
    mime: isPdf ? "application/pdf" : "text/plain",
    bytes: input.bytes,
    hash: hashBytes(input.bytes),
    pages,
    metadata: {
      instructorUmbrella: true,
      originalSupplement: false,
      uploadedBy: ctx.userId,
      authorization: {
        assertedBy: ctx.userId,
        reference: input.rightsReference.trim(),
        assertedAt: new Date().toISOString(),
      },
    },
  });
  return { ...result, sourceKey };
}
export const LECTURE_PREFIX = "LECTURE-";
/** Any lecture PDF the instructor teaches from, beyond the fixed pilot pack. */
export async function importCustomLecture(
  ctx: AuthContext,
  input: {
    title: string;
    filename: string;
    bytes: Uint8Array;
    sourceKey?: string;
  },
) {
  await staff(ctx);
  const title = input.title.trim();
  if (!title || title.length > 200) throw new SourceError("invalid_review");
  if (input.sourceKey && !/^LECTURE-[0-9A-F]{12}$/.test(input.sourceKey))
    throw new SourceError("invalid_review");
  const sourceKey =
    input.sourceKey ||
    LECTURE_PREFIX + hashBytes(keyText(ctx, title)).slice(0, 12).toUpperCase();
  const pages = await parsePdf(input.bytes);
  const result = await persistMaterial(ctx, {
    sourceKey,
    title,
    role: "instructor",
    filename: path.basename(input.filename || "lecture.pdf").normalize("NFC"),
    mime: "application/pdf",
    bytes: input.bytes,
    hash: hashBytes(input.bytes),
    pages: pages.map((text, i) => ({ text, page: i + 1, section: null })),
    metadata: { customLecture: true, uploadedBy: ctx.userId },
  });
  return { ...result, sourceKey };
}
const extractedPages = z.object({
  mode: z.enum(["umbrella", "lecture"]),
  title: z.string().trim().min(1).max(200),
  filename: z.string().max(300).default("document.pdf"),
  rightsConfirmed: z.boolean().optional(),
  rightsReference: z.string().max(500).optional(),
  pages: z
    .array(
      z.object({
        page: z.number().int().positive().max(100000),
        text: z.string().max(30000),
      }),
    )
    .min(1)
    .max(200),
});
/** A large PDF is read in the instructor's own browser and arrives as page text, one part
 * of up to 200 pages per request, so the file size and page limits of an upload do not
 * apply. Each part is its own source; the original file is not stored. */
export async function importExtractedPages(ctx: AuthContext, raw: unknown) {
  await staff(ctx);
  const input = extractedPages.parse(raw);
  if (
    input.mode === "umbrella" &&
    (!input.rightsConfirmed || (input.rightsReference ?? "").trim().length < 5)
  )
    throw new SourceError("permission_required", 400);
  const numbers = input.pages.map((p) => p.page);
  if (new Set(numbers).size !== numbers.length)
    throw new SourceError("invalid_review");
  const pages = [...input.pages]
    .sort((a, b) => a.page - b.page)
    .map((p) => ({
      page: p.page,
      section: null,
      text: p.text.replace(/\s+/g, " ").trim(),
    }));
  const text = pages.map((p) => `[${p.page}]\n${p.text}`).join("\n\n");
  if (Buffer.byteLength(text) > MAX_FILE) throw new SourceError("file_size");
  const sourceKey =
    (input.mode === "umbrella" ? UMBRELLA_PREFIX : LECTURE_PREFIX) +
    hashBytes(keyText(ctx, input.title)).slice(0, 12).toUpperCase();
  if (input.mode === "umbrella") {
    // The same reference already uploaded in another course of this major serves this
    // course too: recognise it instead of storing a second copy.
    const twin = (
      await db
        .tenant(ctx.tenantId)
        .query<{ id: string; source_key: string; course_id: string }>(
          "SELECT id,source_key,course_id FROM material_versions WHERE tenant_id=$1 AND course_id=ANY($2::text[]) AND role='umbrella' AND current_version=true AND hash=$3 LIMIT 1",
          [ctx.tenantId, await majorCourses(ctx), hashBytes(text)],
        )
    ).rows[0];
    if (twin)
      return {
        id: twin.id,
        sourceKey: twin.source_key,
        duplicate: true as const,
        duplicateOf: twin.course_id,
        pages: pages.length,
      };
  }
  const result = await persistMaterial(ctx, {
    sourceKey,
    title: input.title,
    role: input.mode === "umbrella" ? "umbrella" : "instructor",
    filename: path.basename(input.filename).normalize("NFC") + ".txt",
    mime: "text/plain",
    bytes: Buffer.from(text),
    hash: hashBytes(text),
    pages,
    metadata: {
      extractedInBrowser: true,
      originalStored: false,
      firstPage: pages[0].page,
      lastPage: pages.at(-1)!.page,
      uploadedBy: ctx.userId,
      ...(input.mode === "umbrella"
        ? {
            instructorUmbrella: true,
            authorization: {
              assertedBy: ctx.userId,
              reference: (input.rightsReference ?? "").trim(),
              assertedAt: new Date().toISOString(),
            },
          }
        : { customLecture: true }),
    },
  });
  return { ...result, sourceKey };
}
/** Approve every readable pending section of one current umbrella version in a single
 * explicit instructor decision. Quarantined sections still need a corrected extract. */
export async function approvePendingUmbrella(
  ctx: AuthContext,
  versionId: string,
) {
  await staff(ctx, "publish");
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    await authorizeCourseInTransaction(ctx, ctx.courseId, "publish", tx);
    const current = await tx.query(
      "SELECT id FROM material_versions WHERE tenant_id=$1 AND id=$2 AND course_id=$3 AND current_version=true AND (source_key LIKE 'UMBRELLA-%' OR source_key LIKE 'LECTURE-%') FOR UPDATE",
      [ctx.tenantId, versionId, ctx.courseId],
    );
    if (!current.rows.length) throw new SourceError("stale_source", 409);
    const updated = await tx.query<{ id: string }>(
      "UPDATE evidence_chunks SET status='approved',review_note='Approved in an explicit whole-reference review.',reviewed_by=$3,reviewed_at=now() WHERE tenant_id=$1 AND version_id=$2 AND status='pending' RETURNING id",
      [ctx.tenantId, versionId, ctx.userId],
    );
    await tx.query(
      "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'source_review',$3,$4,$5)",
      [
        ctx.tenantId,
        randomUUID(),
        ctx.courseId,
        ctx.userId,
        JSON.stringify({
          action: "umbrella-approve-pending",
          versionId,
          chunkIds: updated.rows.map((r) => r.id),
          institutionalSignoff: false,
        }),
      ],
    );
    return { versionId, approved: updated.rows.length };
  });
}
export async function listMaterials(ctx: AuthContext) {
  await authorizeCourse(ctx, ctx.courseId, "read");
  const rows = (
    await db
      .tenant(ctx.tenantId)
      .query<Material>(
        "SELECT id,source_key,title,role,hash,status,page_count,rights,metadata,current_version FROM material_versions WHERE tenant_id=$1 AND course_id=$2 ORDER BY source_key,created_at DESC",
        [ctx.tenantId, ctx.courseId],
      )
  ).rows;
  const umbrellaRows = rows.filter(
    (r) =>
      (r.role === "umbrella" && r.source_key.startsWith(UMBRELLA_PREFIX)) ||
      (r.role === "instructor" && r.source_key.startsWith(LECTURE_PREFIX)),
  );
  const counts = umbrellaRows.length
    ? (
        await db
          .tenant(ctx.tenantId)
          .query<{ version_id: string; status: string; n: string }>(
            "SELECT version_id,status,count(*) AS n FROM evidence_chunks WHERE tenant_id=$1 AND course_id=$2 AND version_id=ANY($3::text[]) GROUP BY version_id,status",
            [ctx.tenantId, ctx.courseId, umbrellaRows.map((r) => r.id)],
          )
      ).rows
    : [];
  const uploaded =
    ctx.role !== "instructor"
      ? []
      : [...new Set(umbrellaRows.map((r) => r.source_key))].map((key) => {
          const versions = umbrellaRows.filter((r) => r.source_key === key);
          const current =
            versions.find((v) => v.current_version) || versions[0];
          const sections = Object.fromEntries(
            counts
              .filter((c) => c.version_id === current.id)
              .map((c) => [c.status, Number(c.n)]),
          );
          return {
            sourceKey: key,
            title: current.title,
            status: current.status,
            currentVersionId: current.id,
            sections,
            versions: versions.map((v) => ({
              id: v.id,
              current_version: v.current_version,
              status: v.status,
            })),
          };
        });
  // References uploaded in the other courses of this major: usable here, managed there.
  const shared = (
    await db.tenant(ctx.tenantId).query<{
      id: string;
      title: string;
      course_id: string;
      approved: string;
    }>(
      `SELECT v.id,v.title,v.course_id,(SELECT count(*) FROM evidence_chunks c WHERE c.tenant_id=v.tenant_id AND c.version_id=v.id AND c.status='approved') AS approved
       FROM material_versions v WHERE v.tenant_id=$1 AND v.course_id=ANY($2::text[]) AND v.role='umbrella' AND v.current_version=true AND v.source_key LIKE 'UMBRELLA-%' ORDER BY v.title`,
      [ctx.tenantId, await majorCourses(ctx)],
    )
  ).rows.map((r) => ({
    id: r.id,
    title: r.title,
    courseId: r.course_id,
    approved: Number(r.approved),
  }));
  return {
    sharedUmbrellas: shared,
    umbrellas: uploaded.filter((u) => u.sourceKey.startsWith(UMBRELLA_PREFIX)),
    lectures: uploaded.filter((u) => u.sourceKey.startsWith(LECTURE_PREFIX)),
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
    console.error("pdf parse failed:", (error as Error)?.message);
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
  expectedCurrentVersion?: string;
  authorization?: "write" | "publish";
};
async function persistMaterial(ctx: AuthContext, input: NewMaterial) {
  let id: string = randomUUID();
  let changed = 0;
  let deduplicated = false;
  await db.tenant(ctx.tenantId).transaction(async (tx) => {
    await authorizeCourseInTransaction(
      ctx,
      ctx.courseId,
      input.authorization || "write",
      tx,
    );
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
    if (input.expectedCurrentVersion) {
      const current = await tx.query(
        "SELECT id FROM material_versions WHERE tenant_id=$1 AND source_key=$2 AND current_version=true AND id=$3",
        [ctx.tenantId, input.sourceKey, input.expectedCurrentVersion],
      );
      if (current.rows.length !== 1) throw new SourceError("stale_source", 409);
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
        ctx.courseId,
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
          ctx.courseId,
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
  const sections = text
    .split(/(?=^## U\d+\b)/m)
    .filter((t) => /^## U\d+\b/.test(t));
  const sectionIds = sections.map((t) => t.match(/^## (U\d+)\b/)?.[1]);
  if (
    !sections.length ||
    sections.length > 100 ||
    new Set(sectionIds).size !== sections.length
  )
    throw new SourceError("invalid_review");
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
      section: t.match(/^## (U\d+)\b/)?.[1] ?? null,
    })),
    metadata: { originalSupplement: true, gfg: false },
  });
}

const extractCorrections = z
  .array(
    z.object({
      chunkId: z.string().min(1).max(200),
      text: z.string().trim().min(20).max(30000),
      note: z.string().trim().min(10).max(2000),
    }),
  )
  .min(1)
  .max(100);

/** One immutable extraction revision for a reviewed set of figure transcriptions/corrections.
 * Original PDF bytes and historical source IDs remain available. Nothing is approved here.
 */
export async function reviseMaterialExtracts(
  ctx: AuthContext,
  versionId: string,
  input: unknown,
) {
  await staff(ctx, "publish");
  const corrections = extractCorrections.parse(input);
  if (new Set(corrections.map((c) => c.chunkId)).size !== corrections.length)
    throw new SourceError("invalid_review");
  const scoped = db.tenant(ctx.tenantId);
  const version = (
    await scoped.query<
      Material & { filename: string; mime_type: string; bytes: Buffer }
    >(
      "SELECT * FROM material_versions WHERE tenant_id=$1 AND id=$2 AND course_id=$3",
      [ctx.tenantId, versionId, ctx.courseId],
    )
  ).rows[0];
  if (
    !version ||
    !version.bytes ||
    !version.rights.extract ||
    !version.rights.displayExcerpt ||
    !version.rights.sendToModel
  )
    throw new SourceError("source_missing", 404);
  const chunks = (
    await scoped.query<{
      id: string;
      page: number | null;
      section: string | null;
      text_content: string;
    }>(
      "SELECT id,page,section,text_content FROM evidence_chunks WHERE tenant_id=$1 AND version_id=$2 ORDER BY page NULLS LAST,section",
      [ctx.tenantId, versionId],
    )
  ).rows;
  if (corrections.some((c) => !chunks.some((row) => row.id === c.chunkId)))
    throw new SourceError("invalid_review");
  const sorted = [...corrections].sort((a, b) =>
    a.chunkId.localeCompare(b.chunkId),
  );
  const revision = await persistMaterial(ctx, {
    sourceKey: version.source_key,
    title: version.title,
    role: version.role as "instructor" | "umbrella",
    filename: version.filename,
    mime: version.mime_type,
    bytes: version.bytes,
    hash: hashBytes(version.hash + JSON.stringify(sorted)),
    expectedCurrentVersion: version.id,
    authorization: "publish",
    pages: chunks.map((c) => ({
      page: c.page,
      section: c.section,
      text: corrections.find((x) => x.chunkId === c.id)?.text || c.text_content,
    })),
    metadata: {
      ...version.metadata,
      correctedFrom: version.id,
      originalFileHash: version.metadata.originalFileHash || version.hash,
      extractionRevision: true,
      corrections: sorted.map((c) => ({
        originalChunkId: c.chunkId,
        note: c.note,
      })),
      reviewedBy: ctx.userId,
    },
  });
  // Resume safely if creation committed but the separate review audit was interrupted.
  // Never reset an explicit review decision on a deduplicated retry.
  await scoped.transaction(async (tx) => {
    await authorizeCourseInTransaction(ctx, ctx.courseId, "publish", tx);
    const current = await tx.query(
      "SELECT id FROM material_versions WHERE tenant_id=$1 AND id=$2 AND current_version=true FOR UPDATE",
      [ctx.tenantId, revision.id],
    );
    if (!current.rows.length) throw new SourceError("stale_source", 409);
    for (const correction of corrections) {
      const old = chunks.find((c) => c.id === correction.chunkId)!;
      await tx.query(
        "UPDATE evidence_chunks SET status='pending',review_note=$3 WHERE tenant_id=$1 AND id=$2 AND reviewed_at IS NULL",
        [
          ctx.tenantId,
          `${revision.id}-${old.section || old.page}`,
          `Corrected extract pending review: ${correction.note}`,
        ],
      );
    }
    await tx.query(
      "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'source_review',$3,$4,$5) ON CONFLICT ON CONSTRAINT records_pkey DO NOTHING",
      [
        ctx.tenantId,
        `source-revision:${revision.id}`,
        ctx.courseId,
        ctx.userId,
        JSON.stringify({
          action: "batch-extraction-revision",
          previousVersionId: version.id,
          versionId: revision.id,
          correctedChunks: sorted.map((c) => c.chunkId),
          autoApproved: false,
        }),
      ],
    );
  });
  return revision;
}

const batchReviews = z
  .array(
    z.object({
      chunkId: z.string().min(1).max(200),
      status: z.enum(["approved", "rejected", "quarantined"]),
      note: z.string().trim().min(5).max(2000),
    }),
  )
  .min(1)
  .max(100);

/** Explicit per-chunk review, atomically bound to the current material version. */
export async function reviewMaterialChunks(
  ctx: AuthContext,
  versionId: string,
  input: unknown,
) {
  await staff(ctx, "publish");
  const decisions = batchReviews.parse(input);
  if (new Set(decisions.map((c) => c.chunkId)).size !== decisions.length)
    throw new SourceError("invalid_review");
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    await authorizeCourseInTransaction(ctx, ctx.courseId, "publish", tx);
    const current = await tx.query(
      "SELECT id FROM material_versions WHERE tenant_id=$1 AND id=$2 AND course_id=$3 AND current_version=true FOR UPDATE",
      [ctx.tenantId, versionId, ctx.courseId],
    );
    if (!current.rows.length) throw new SourceError("stale_source", 409);
    const chunks = (
      await tx.query<{ id: string; status: string }>(
        "SELECT id,status FROM evidence_chunks WHERE tenant_id=$1 AND version_id=$2 FOR UPDATE",
        [ctx.tenantId, versionId],
      )
    ).rows;
    if (decisions.some((c) => !chunks.some((r) => r.id === c.chunkId)))
      throw new SourceError("invalid_review");
    if (
      decisions.some(
        (c) =>
          c.status === "approved" &&
          chunks.find((r) => r.id === c.chunkId)!.status === "quarantined",
      )
    )
      throw new SourceError("parse_failed");
    await tx.query(
      `UPDATE evidence_chunks c SET status=r.status,review_note=r.note,reviewed_by=$4,reviewed_at=now() FROM jsonb_to_recordset($3::jsonb) AS r("chunkId" text,status text,note text) WHERE c.tenant_id=$1 AND c.version_id=$2 AND c.id=r."chunkId"`,
      [ctx.tenantId, versionId, JSON.stringify(decisions), ctx.userId],
    );
    await tx.query(
      "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,'source_review',$3,$4,$5)",
      [
        ctx.tenantId,
        randomUUID(),
        ctx.courseId,
        ctx.userId,
        JSON.stringify({
          action: "explicit-batch-review",
          versionId,
          decisions,
          institutionalSignoff: false,
        }),
      ],
    );
    return {
      versionId,
      reviewed: decisions.length,
      approved: decisions.filter((c) => c.status === "approved").length,
    };
  });
}
export async function getMaterial(ctx: AuthContext, id: string) {
  await authorizeCourse(ctx, ctx.courseId, "read");
  const v = (
    await db
      .tenant(ctx.tenantId)
      .query<Material>(
        "SELECT id,source_key,title,role,hash,status,page_count,rights,metadata,current_version FROM material_versions WHERE tenant_id=$1 AND id=$2 AND (course_id=$3 OR (role='umbrella' AND course_id=ANY($4::text[])))",
        [ctx.tenantId, id, ctx.courseId, await majorCourses(ctx)],
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
        [ctx.tenantId, id, ctx.courseId],
      )
  ).rows[0];
  if (!row) throw new SourceError("source_missing", 404);
  if (status === "approved" && row.status === "quarantined" && !correctedText)
    throw new SourceError("parse_failed");
  if (correctedText) {
    // A correction creates a new extraction version; historical source IDs remain immutable.
    const version = (
      await db.tenant(ctx.tenantId).query<{
        id: string;
        source_key: string;
        title: string;
        role: "instructor" | "umbrella";
        filename: string;
        mime_type: string;
        bytes: Buffer;
        hash: string;
        metadata: Record<string, unknown>;
      }>(`SELECT v.* FROM material_versions v JOIN evidence_chunks c ON c.tenant_id=v.tenant_id AND c.version_id=v.id WHERE c.tenant_id=$1 AND c.id=$2`, [ctx.tenantId, id])
    ).rows[0];
    const all = (
      await db.tenant(ctx.tenantId).query<{
        id: string;
        page: number | null;
        section: string | null;
        text_content: string;
      }>("SELECT id,page,section,text_content FROM evidence_chunks WHERE tenant_id=$1 AND version_id=$2 ORDER BY page NULLS LAST,section", [ctx.tenantId, version.id])
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
          ctx.courseId,
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
        ctx.courseId,
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
