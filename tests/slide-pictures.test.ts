import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/server/db";
import { migrateDatabase } from "../src/server/migrate";
import { type AuthContext } from "../src/server/auth";
import { type ModelGateway, type PageImage } from "../src/server/ai";
import { getMaterial, importExtractedPages } from "../src/server/sources";
import { transcribePageImages } from "../src/server/ocr";

const tenant = randomUUID();
const instructor: AuthContext = {
  tenantId: tenant,
  userId: randomUUID(),
  role: "instructor",
  courseId: "CET351",
  locale: "en",
};
const picture = Buffer.from("x".repeat(200)).toString("base64");
let seen: PageImage[] = [];
/** Deterministic replay: NOT Gemini. "Reads" page 2 and finds nothing on page 3. */
const reader: ModelGateway = {
  modelId: "deterministic-slide-reader-NOT-GEMINI",
  async generate() {
    throw new Error("not used");
  },
  async transcribeImages(images) {
    seen = images;
    return {
      tokens: 30,
      pages: images.map((i) => ({
        page: i.page,
        text:
          i.page === 2
            ? "Backpropagation: the error flows from the output layer to the input layer."
            : "",
      })),
    };
  },
};
beforeAll(async () => {
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_DATABASE_PATH = "memory://";
  await migrateDatabase();
  await db.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [
    tenant,
    "Synthetic slide tenant",
  ]);
  await db.tenant(tenant).transaction(async (tx) => {
    await tx.query("INSERT INTO users(tenant_id,id,name) VALUES($1,$2,$3)", [
      tenant,
      instructor.userId,
      '{"ar":"اختبار","en":"Test"}',
    ]);
    await tx.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'instructor')",
      [tenant, instructor.userId],
    );
    await tx.query(
      "INSERT INTO course_access(tenant_id,user_id,course_id,access_role,can_review,can_publish) VALUES($1,$2,'CET351','instructor',true,true)",
      [tenant, instructor.userId],
    );
  });
});
afterAll(() => db.close());

describe("slides that are pictures, read from the browser's rendering", () => {
  it("replaces only text-free pages, as a new revision awaiting review", async () => {
    const lecture = await importExtractedPages(instructor, {
      mode: "lecture",
      title: "Lecture 5",
      pages: [
        {
          page: 1,
          text: "Neural networks: an overview of the course and its goals in detail.",
        },
        { page: 2, text: "" },
        { page: 3, text: "" },
      ],
    });
    const image = (page: number) => ({
      page,
      mime: "image/jpeg",
      data: picture,
    });
    // A page that already has text cannot be overwritten by a transcription.
    await expect(
      transcribePageImages(instructor, lecture.id, [image(1)], reader),
    ).rejects.toMatchObject({ code: "invalid_review" });
    await expect(
      transcribePageImages(
        instructor,
        lecture.id,
        [image(2), image(2)],
        reader,
      ),
    ).rejects.toMatchObject({ code: "invalid_review" });
    const result = await transcribePageImages(
      instructor,
      lecture.id,
      [image(2), image(3)],
      reader,
    );
    expect(seen.map((i) => i.page)).toEqual([2, 3]);
    expect(result).toMatchObject({ transcribed: 1, unreadable: 1 });
    expect(result.versionId).not.toBe(lecture.id);
    const after = await getMaterial(instructor, result.versionId);
    const second = after.chunks.find((c) => c.page === 2)!;
    expect(second.text_content).toMatch(/Backpropagation/);
    // Nothing the model wrote is trusted before the instructor checks it.
    expect(after.chunks.every((c) => c.status !== "approved")).toBe(true);
    expect(after.chunks.find((c) => c.page === 3)!.text_content).toBe("");
    // The old version is no longer current, so a late request for it is refused.
    await expect(
      transcribePageImages(instructor, lecture.id, [image(3)], reader),
    ).rejects.toMatchObject({ code: "stale_source" });
  });
  it("stores page text that carries characters the database refuses", async () => {
    // Seen in a real textbook PDF: a NUL byte and half of a surrogate pair from a font map.
    const book = await importExtractedPages(instructor, {
      mode: "umbrella",
      title: "Textbook with odd glyphs",
      rightsConfirmed: true,
      rightsReference: "Course textbook",
      pages: [
        {
          page: 130,
          text: "Gradient\u0000 descent uses the learning rate \uD835 alpha and a step \uDC00 size.\u0007",
        },
      ],
    });
    const stored = (await getMaterial(instructor, book.id)).chunks[0];
    expect(stored.text_content).toBe(
      "Gradient descent uses the learning rate alpha and a step size.",
    );
  });
});
