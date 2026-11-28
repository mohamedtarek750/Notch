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
import { fingerprints, fingerprintMatch, rememberFingerprints, type Fingerprints } from "./material-fingerprints";

export const COURSE = "CET351";
export const MAX_FILE = 3_500_000;
export const sourceManifest = manifest.sources;
export class SourceError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public currentVersionId?: string,
  ) {
    super(code);
  }
}
export const sourceMessages: Record<string, [string, string]> = {
  draft_in_use: ["الملف منشور أو قيد المعالجة أو مستخدم في نتائج معتمدة. أوقف البناء الجاري أولًا إن وُجد.", "This file is published, processing, or used by approved results. Cancel an active build before removing its files."],
  draft_conflict: ["يوجد إصدار حالي لهذا الملف. لا يمكن استرجاع المسودة الآن.", "A current version exists for this file. The draft cannot be restored yet."],
  revision_required: ["يوجد إصدار بهذا العنوان. أكّد إضافة إصدار جديد.", "A version with this title exists. Confirm the revision before replacing it."],
  course_required: ["اختر المقرر أولاً.", "Select a course first."],
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
/**
 * Text read from a PDF can carry characters the database refuses: a NUL byte, other
 * control characters, or half of a surrogate pair from a broken font map. They carry no
 * meaning for a reader, so they become spaces instead of failing the whole upload.
 */
export function storable(text: string) {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, " ")
    .replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      " ",
    );
}
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
  // An error with no message of its own is a fault of ours: leave a trace of it.
  if (!sourceMessages[code])
    console.error("unexpected source error:", e.code ?? "", e.message ?? error);
  const texts = sourceMessages[code] || [
    "الخدمة غير متاحة مؤقتًا. حاول مرة أخرى.",
    "Service temporarily unavailable. Please retry.",
  ];
  return Response.json(
      { error: code, message: texts[language.startsWith("en") ? 1 : 0], ...(error instanceof SourceError && error.currentVersionId ? { currentVersionId: error.currentVersionId } : {}) },
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
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false) ON CONFLICT(tenant_id,course_id,source_key,hash) DO NOTHING`,
      [
        ctx.tenantId,
        ctx.courseId === DEFAULT_COURSE ? `registration-${sourceKey}` : `registration-${ctx.courseId}-${sourceKey}`,
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
       JOIN course_access a ON a.tenant_id=o.tenant_id AND a.course_id=o.course_id AND a.user_id=$3 AND a.active
       WHERE me.tenant_id=$1 AND me.kind='course' AND me.course_id=$2 AND me.data->>'majorId' IS NOT NULL AND o.course_id<>$2`,
      [ctx.tenantId, ctx.courseId, ctx.userId],
    )
  ).rows.map((r) => r.course_id);
}
/** A source is identified by its title within its course; the first course keeps the
 * original keys so material uploaded before courses existed is still recognised. */
const keyText = (ctx: AuthContext, title: string) =>
  (ctx.courseId === DEFAULT_COURSE ? "" : ctx.courseId + "\n") +
  title.normalize("NFKC").toLowerCase();
export const UMBRELLA_PREFIX = "UMBRELLA-";
const fingerprintInput = z.object({
  mode: z.enum(["lecture","umbrella"]),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export async function checkFingerprint(ctx: AuthContext, raw: unknown) {
  await staff(ctx);
  const { mode, documentHash } = fingerprintInput.parse(raw);
  const parts = (await db.tenant(ctx.tenantId).query<{
    id:string; sourceKey:string; firstPage:number; lastPage:number; total:number;
  }>(`SELECT v.id,v.source_key AS "sourceKey", f.first_page AS "firstPage",
      f.last_page AS "lastPage", f.document_pages AS total
    FROM material_fingerprints f JOIN material_versions v ON v.tenant_id=f.tenant_id AND v.id=f.version_id
    WHERE f.tenant_id=$1 AND f.course_id=$2 AND f.role=$3 AND f.kind='file' AND f.digest=$4
      AND v.current_version ORDER BY f.first_page`,
    [ctx.tenantId, ctx.courseId, mode === "lecture" ? "instructor" : "umbrella", documentHash],
  )).rows;
  let nextPage = 1;
  for (const p of parts) {
    if (p.firstPage !== nextPage || p.total !== parts[0].total) break;
    nextPage = p.lastPage + 1;
  }
  return { complete: parts.length > 0 && nextPage === parts[0].total + 1, parts };
}
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
    revisionOf?: string;
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
  const fileHash = hashBytes(input.bytes);
  const known = await checkFingerprint(ctx, { mode: "umbrella", documentHash: fileHash });
  if (known.complete && known.parts.length === 1) {
    const part = known.parts[0];
    return { id: part.id, sourceKey: part.sourceKey, deduplicated: true, duplicate: true, pages: part.total };
  }
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
    hash: fileHash,
    fingerprint: fingerprints(pages, fileHash),
    expectedCurrentVersion: input.revisionOf,
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
  return result;
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
    revisionOf?: string;
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
  const fileHash = hashBytes(input.bytes);
  const known = await checkFingerprint(ctx, { mode: "lecture", documentHash: fileHash });
  if (known.complete && known.parts.length === 1) {
    const part = known.parts[0];
    return { id: part.id, sourceKey: part.sourceKey, deduplicated: true, duplicate: true, pages: part.total };
  }
  const pages = (await parsePdf(input.bytes)).map((text, i) => ({ text, page: i+1, section: null }));
  const result = await persistMaterial(ctx, {
    sourceKey,
    title,
    role: "instructor",
    filename: path.basename(input.filename || "lecture.pdf").normalize("NFC"),
    mime: "application/pdf",
    bytes: input.bytes,
    hash: fileHash,
    fingerprint: fingerprints(pages, fileHash),
    expectedCurrentVersion: input.revisionOf,
    pages,
    metadata: { customLecture: true, uploadedBy: ctx.userId },
  });
  return result;
}
const extractedPages = z.object({
  mode: z.enum(["umbrella", "lecture"]),
  title: z.string().trim().min(1).max(200),
  filename: z.string().max(300).default("document.pdf"),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  documentPages: z.number().int().positive().max(100000).optional(),
  rejectDuplicate: z.boolean().optional(),
  revisionOf: z.string().max(200).optional(),
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
      text: storable(p.text).replace(/\s+/g, " ").trim(),
    }));
  const text = pages.map((p) => `[${p.page}]\n${p.text}`).join("\n\n");
  if (Buffer.byteLength(text) > MAX_FILE) throw new SourceError("file_size");
  const sourceKey =
    (input.mode === "umbrella" ? UMBRELLA_PREFIX : LECTURE_PREFIX) +
    hashBytes(keyText(ctx, input.title)).slice(0, 12).toUpperCase();
  const fp = fingerprints(pages, input.documentHash, input.documentPages);
  if (input.documentHash && (!input.documentPages || fp.lastPage > input.documentPages || fp.lastPage - fp.firstPage + 1 !== pages.length))
    throw new SourceError("invalid_review");
  if (input.mode === "umbrella" && fp.contentHash && !input.documentHash) {
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
    hash: input.documentHash ? hashBytes(input.documentHash + ":" + fp.firstPage + ":" + fp.lastPage)
      : fp.contentHash ? hashBytes(text) : hashBytes(randomUUID()),
    fingerprint: fp,
    expectedCurrentVersion: input.revisionOf,
    pages,
    metadata: {
      extractedInBrowser: true,
      ...(input.documentHash ? { documentHash: input.documentHash, documentPages: input.documentPages, originalFilename: input.filename } : {}),
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
  return result;
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
const draftFiles = `FROM material_versions v WHERE v.tenant_id=$1 AND v.course_id=$2 AND v.role IN ('instructor','umbrella')
  AND (v.source_key LIKE 'LECTURE-%' OR v.source_key LIKE 'UMBRELLA-%') AND v.status<>'published'`;
export async function listBuildDrafts(ctx: AuthContext) {
  await staff(ctx);
  return (await db.tenant(ctx.tenantId).query(`SELECT min(v.id) id,coalesce(v.metadata->>'originalFilename',v.title) title,v.role,
      (v.metadata->>'removedFromBuild'='true') IS TRUE AS removed
    ${draftFiles} AND (v.current_version OR v.metadata->>'removedFromBuild'='true')
    GROUP BY COALESCE(v.metadata->>'documentHash',v.id),2,3,4 ORDER BY max(v.created_at) DESC`,[ctx.tenantId,ctx.courseId])).rows;
}

export async function changeBuildDraft(ctx: AuthContext, id: string, remove: boolean) {
  await staff(ctx,"publish");
  return db.tenant(ctx.tenantId).transaction(async tx => {
    await authorizeCourseInTransaction(ctx,ctx.courseId,"publish",tx);
    const scope = [ctx.tenantId,ctx.courseId] as const;
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))",[ctx.tenantId+":knowledge:"+ctx.courseId]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[...scope]);
    const versions = (await tx.query<{id:string;source_key:string}>(`SELECT v.id,v.source_key ${draftFiles}
      AND (v.current_version OR v.metadata->>'removedFromBuild'='true') AND ((v.metadata->>'removedFromBuild'='true') IS TRUE) <> $4::boolean
      AND EXISTS (SELECT 1 FROM material_versions original WHERE original.tenant_id=$1 AND original.course_id=$2 AND original.id=$3 AND original.role=v.role
        AND COALESCE(original.metadata->>'documentHash',original.id)=COALESCE(v.metadata->>'documentHash',v.id)) FOR UPDATE`,[...scope,id,remove])).rows;
    if (!versions.length) throw new SourceError("draft_in_use",409);
    const ids=versions.map(v=>v.id);
    if (remove) {
      const usages=await tx.query(`SELECT 1 FROM km_build_jobs j CROSS JOIN LATERAL jsonb_array_elements(j.documents) doc
          WHERE j.tenant_id=$1 AND j.course_id=$2 AND j.status IN ('queued','processing') AND doc->>'versionId'=ANY($3::text[])
        UNION ALL SELECT 1 FROM evidence_chunks e WHERE e.tenant_id=$1 AND e.version_id=ANY($3::text[]) AND (
          EXISTS (SELECT 1 FROM km_citations k WHERE k.tenant_id=e.tenant_id AND k.evidence_id=e.id)
          OR EXISTS (SELECT 1 FROM km_edges k WHERE k.tenant_id=e.tenant_id AND k.evidence ? e.id)
          OR EXISTS (SELECT 1 FROM records p WHERE p.tenant_id=e.tenant_id AND p.kind='knowledge_proposal'
            AND p.data->>'status' IN ('approved','published') AND p.data->'evidenceIds' ? e.id)) LIMIT 1`,[...scope,ids]);
      if(usages.rows.length) throw new SourceError("draft_in_use",409);
      const revision = await tx.query("SELECT 1 FROM material_versions WHERE tenant_id=$1 AND course_id=$2 AND source_key=ANY($3::text[]) AND status='published' LIMIT 1",[...scope,versions.map(v=>v.source_key)]);
      if (revision.rows.length) throw new SourceError("draft_in_use",409);
    } else {
      const conflict=await tx.query("SELECT 1 FROM material_versions WHERE tenant_id=$1 AND course_id=$2 AND current_version AND source_key=ANY($3::text[]) LIMIT 1",[...scope,versions.map(v=>v.source_key)]);
      if(conflict.rows.length) throw new SourceError("draft_conflict",409);
    }
    await tx.query(`UPDATE material_versions SET current_version=NOT $4::boolean,metadata=CASE WHEN $4 THEN metadata || '{"removedFromBuild":true}'::jsonb ELSE metadata-'removedFromBuild' END
      WHERE tenant_id=$1 AND course_id=$2 AND id=ANY($3::text[])`,[...scope,ids,remove]);
    return {changed:ids.length};
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
      !r.metadata?.removedFromBuild && ((r.role === "umbrella" && r.source_key.startsWith(UMBRELLA_PREFIX)) ||
      (r.role === "instructor" && r.source_key.startsWith(LECTURE_PREFIX))),
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
        "SELECT * FROM material_versions WHERE tenant_id=$1 AND source_key=$2 AND hash=$3 AND course_id=$4",
        [ctx.tenantId, entry.source_key, hash, ctx.courseId],
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
  fingerprint?: Fingerprints;
  authorization?: "write" | "publish";
};
async function persistMaterial(ctx: AuthContext, raw: NewMaterial) {
  const input = {
    ...raw,
    pages: raw.pages.map((p) => ({ ...p, text: storable(p.text) })),
  };
  let id: string = randomUUID();
  let sourceKey = input.sourceKey;
  let changed = 0;
  let deduplicated = false;
  await db.tenant(ctx.tenantId).transaction(async (tx) => {
    await authorizeCourseInTransaction(
      ctx,
      ctx.courseId,
      input.authorization || "write",
      tx,
    );
    // Serialize only this course's short commit phase. Extraction happens outside it.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      ctx.tenantId + ":material:" + ctx.courseId,
    ]);
    if (input.fingerprint) {
      const match = await fingerprintMatch(tx, ctx, input.role, input.fingerprint);
      if (match) {
        if (!match.current_version) throw new SourceError("stale_source", 409);
        id = match.id;
        sourceKey = match.source_key;
        deduplicated = true;
        await rememberFingerprints(tx, ctx, input.role, input.fingerprint, id);
        return;
      }
      if (input.expectedCurrentVersion) {
        const previous = (await tx.query<{source_key:string}>(
          "SELECT source_key FROM material_versions WHERE tenant_id=$1 AND course_id=$2 AND role=$3 AND id=$4 AND current_version",
          [ctx.tenantId,ctx.courseId,input.role,input.expectedCurrentVersion],
        )).rows[0];
        if (!previous) throw new SourceError("stale_source",409);
        sourceKey = previous.source_key;
      }
    }
    const existing = (
      await tx.query<{ id: string;current_version:boolean }>(
        "SELECT id,current_version FROM material_versions WHERE tenant_id=$1 AND source_key=$2 AND hash=$3 AND course_id=$4",
        [ctx.tenantId, sourceKey, input.hash, ctx.courseId],
      )
    ).rows[0];
    if (existing) {
      if (input.fingerprint && !existing.current_version) throw new SourceError("stale_source",409);
      id = existing.id;
      deduplicated = true;
      if (input.fingerprint) await rememberFingerprints(tx,ctx,input.role,input.fingerprint,id);
      return;
    }
    const current = (await tx.query<{id:string}>(
      "SELECT id FROM material_versions WHERE tenant_id=$1 AND course_id=$2 AND source_key=$3 AND current_version FOR UPDATE",
      [ctx.tenantId,ctx.courseId,sourceKey],
    )).rows[0];
    if (input.expectedCurrentVersion && current?.id !== input.expectedCurrentVersion)
      throw new SourceError("stale_source",409);
    if (current && input.fingerprint && !input.expectedCurrentVersion)
      throw new SourceError("revision_required",409,current.id);
    const old = (
      await tx.query<{
        page: number | null;
        section: string | null;
        text_content: string;
      }>(
        `SELECT c.page,c.section,c.text_content FROM evidence_chunks c JOIN material_versions v ON v.tenant_id=c.tenant_id AND v.id=c.version_id WHERE v.tenant_id=$1 AND v.source_key=$2 AND v.course_id=$3 AND v.current_version=true`,
        [ctx.tenantId, sourceKey, ctx.courseId],
      )
    ).rows;
    await tx.query(
      "UPDATE material_versions SET current_version=false WHERE tenant_id=$1 AND source_key=$2 AND course_id=$3 AND current_version",
      [ctx.tenantId, sourceKey, ctx.courseId],
    );
    await tx.query(
      `INSERT INTO material_versions(tenant_id,id,course_id,source_key,title,role,hash,filename,mime_type,bytes,page_count,rights,metadata,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')`,
      [
        ctx.tenantId,
        id,
        ctx.courseId,
        sourceKey,
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
    if (input.fingerprint) await rememberFingerprints(tx,ctx,input.role,input.fingerprint,id);
    if (current && input.metadata.extractionRevision) {
      // OCR/corrections change the extract, but the original bytes still identify it.
      await tx.query("UPDATE material_fingerprints SET version_id=$3 WHERE tenant_id=$1 AND version_id=$2 AND kind='file'", [ctx.tenantId,current.id,id]);
      await rememberFingerprints(tx,ctx,input.role,fingerprints(input.pages),id);
    }
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
    sourceKey,
    ...(deduplicated ? { duplicate: true } : {}),
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
        "SELECT id FROM material_versions WHERE tenant_id=$1 AND source_key=$2 AND hash=$3 AND course_id=$4",
        [ctx.tenantId, "TILWA-PILOT-FOUNDATIONS", hash,ctx.courseId],
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


