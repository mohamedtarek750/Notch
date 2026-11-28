import { createHash } from "node:crypto";
import type { AuthContext } from "./auth";
import type { Queryable } from "./db";

export type Fingerprints = {
  fileHash?: string;
  contentHash?: string;
  firstPage: number;
  lastPage: number;
  documentPages: number;
};

export function fingerprints(
  pages: { text: string; page: number | null }[],
  fileHash?: string,
  documentPages?: number,
): Fingerprints {
  const normalized = pages.map(p => p.text.normalize("NFKC").replace(/\s+/gu, " ").trim());
  // A cover page and unreadable slides can occur in otherwise unrelated scanned books.
  const readable = normalized.length && normalized.filter(s => s.length >= 60).length >= Math.ceil(normalized.length * 0.9);
  return {
    fileHash,
    contentHash: readable
      ? createHash("sha256").update(normalized.join(" ")).digest("hex")
      : undefined,
    firstPage: pages[0]?.page ?? 1,
    lastPage: pages.at(-1)?.page ?? pages.length,
    documentPages: documentPages ?? pages.at(-1)?.page ?? pages.length,
  };
}

export async function fingerprintMatch(
  sql: Queryable, ctx: AuthContext, role: string, fp: Fingerprints,
) {
  return (await sql.query<{id: string; source_key: string; current_version: boolean}>(
    `SELECT v.id,v.source_key,v.current_version FROM material_fingerprints f JOIN material_versions v
       ON v.tenant_id=f.tenant_id AND v.id=f.version_id
     WHERE f.tenant_id=$1 AND f.course_id=$2 AND f.role=$3 AND
       ((f.kind='file' AND f.digest=$4) OR (f.kind='content' AND f.digest=$5))
       AND f.first_page=$6 AND f.last_page=$7 ORDER BY v.current_version DESC LIMIT 1`,
    [ctx.tenantId,ctx.courseId,role,fp.fileHash ?? null,fp.contentHash ?? null,fp.firstPage,fp.lastPage],
  )).rows[0];
}

export async function rememberFingerprints(
  sql: Queryable, ctx: AuthContext, role: string, fp: Fingerprints, versionId: string,
) {
  for (const [kind,digest] of [["file",fp.fileHash],["content",fp.contentHash]]) {
    if (!digest) continue;
    await sql.query(
      `INSERT INTO material_fingerprints(tenant_id,course_id,role,kind,digest,first_page,last_page,document_pages,version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [ctx.tenantId,ctx.courseId,role,kind,digest,fp.firstPage,fp.lastPage,fp.documentPages,versionId],
    );
  }
}

