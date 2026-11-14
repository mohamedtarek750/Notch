import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/server/db";
import { migrateDatabase } from "../src/server/migrate";
import { createWorkspace, type Workspace } from "../src/server/seed";
import type { AuthContext } from "../src/server/auth";
import {
  getMaterial,
  importSupplement,
  reviseMaterialExtracts,
  reviewMaterialChunks,
} from "../src/server/sources";
let a: Workspace, b: Workspace, version: string;
const ctx = (
  w: Workspace,
  role: "instructor" | "student" = "instructor",
): AuthContext => ({
  tenantId: w.tenantId,
  userId: w.users[role],
  role,
  courseId: "CET351",
  locale: "en",
});
beforeAll(async () => {
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_DATABASE_PATH = "memory://";
  process.env.DEMO_MODE = "true";
  await migrateDatabase();
  await db.query("SET ROLE tilwa_runtime");
  a = await createWorkspace();
  b = await createWorkspace();
  const result = await importSupplement(
    ctx(a),
    "# Original synthetic test handout\n## U1 — First\nAn explicit original first section about a labelled data table.\n## U10 — Tenth\nA separate tenth section with a readable mathematical figure description.\n## U100 — Hundredth\nA separate hundredth locator tests stable multidigit identifiers.\n",
  );
  version = result.id;
}, 30000);
afterAll(() => db.close());
describe("explicit source review and immutable batch extraction under non-owner PostgreSQL", () => {
  it("preserves distinct multidigit umbrella locators and rejects duplicates", async () => {
    const m = await getMaterial(ctx(a), version);
    expect(m.chunks.map((c) => c.section)).toEqual(["U1", "U10", "U100"]);
    await expect(
      importSupplement(
        ctx(a),
        "## U10 — duplicate one\nOriginal author section with enough readable text.\n## U10 — duplicate two\nOriginal second paragraph with the same section ID.",
      ),
    ).rejects.toMatchObject({ code: "invalid_review" });
  });
  it("denies students, cross-tenant corrections and foreign chunks without partial updates", async () => {
    const m = await getMaterial(ctx(a), version),
      row = m.chunks[0];
    const correction = [
      {
        chunkId: row.id,
        text: "Reviewed correction: a held-out evaluation needs known reference labels.",
        note: "Original synthetic test correction reviewed by instructor.",
      },
    ];
    await expect(
      reviseMaterialExtracts(ctx(a, "student"), version, correction),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      reviseMaterialExtracts(ctx(b), version, correction),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      reviewMaterialChunks(ctx(a), version, [
        {
          chunkId: row.id,
          status: "approved",
          note: "Reviewed exact source text.",
        },
        {
          chunkId: "foreign",
          status: "approved",
          note: "Invalid chunk should reject atomically.",
        },
      ]),
    ).rejects.toMatchObject({ code: "invalid_review" });
    expect(
      (await getMaterial(ctx(a), version)).chunks.every(
        (c) => c.status === "pending",
      ),
    ).toBe(true);
  });
  it("retains original text and bytes, requires a separate explicit review, and refuses stale decisions", async () => {
    const original = await getMaterial(ctx(a), version),
      old = original.chunks.find((c) => c.section === "U10")!;
    await db
      .tenant(a.tenantId)
      .query(
        "UPDATE evidence_chunks SET status='quarantined' WHERE tenant_id=$1 AND id=$2",
        [a.tenantId, old.id],
      );
    await expect(
      reviewMaterialChunks(ctx(a), version, [
        {
          chunkId: old.id,
          status: "approved",
          note: "No correction has been supplied.",
        },
      ]),
    ).rejects.toMatchObject({ code: "parse_failed" });
    const corrections = [
      {
        chunkId: old.id,
        text: "Reviewed figure transcription: horizontal axis is sample count, vertical axis is measured error.",
        note: "Figure labels transcribed from the original synthetic diagram.",
      },
    ];
    const revision = await reviseMaterialExtracts(ctx(a), version, corrections);
    const current = await getMaterial(ctx(a), revision.id);
    expect(current.chunks.every((c) => c.status === "pending")).toBe(true);
    expect(
      (await getMaterial(ctx(a), version)).chunks.find((c) => c.id === old.id)!
        .text_content,
    ).toBe(old.text_content);
    const blobs = (
      await db
        .tenant(a.tenantId)
        .query<{ same: boolean }>(
          "SELECT a.bytes=b.bytes AS same FROM material_versions a JOIN material_versions b ON a.tenant_id=b.tenant_id WHERE a.tenant_id=$1 AND a.id=$2 AND b.id=$3",
          [a.tenantId, version, revision.id],
        )
    ).rows;
    expect(blobs[0].same).toBe(true);
    await expect(
      reviewMaterialChunks(ctx(a), version, [
        {
          chunkId: old.id,
          status: "rejected",
          note: "Stale source review is not accepted.",
        },
      ]),
    ).rejects.toMatchObject({ code: "stale_source" });
    const result = await reviewMaterialChunks(
      ctx(a),
      revision.id,
      current.chunks.map((c) => ({
        chunkId: c.id,
        status: "approved",
        note: "Explicit review of each current synthetic extract.",
      })),
    );
    expect(result.approved).toBe(3);
    const retry = await reviseMaterialExtracts(ctx(a), version, corrections);
    expect(retry).toMatchObject({ id: revision.id, deduplicated: true });
    expect(
      (await getMaterial(ctx(a), revision.id)).chunks.every(
        (c) => c.status === "approved",
      ),
    ).toBe(true);
  });
});
