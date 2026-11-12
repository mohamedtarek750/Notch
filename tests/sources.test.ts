import { syntheticPdf } from "./fixtures/synthetic-pdf";
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  extractPackZip,
  inspectPackZip,
  verifyOriginal,
  expectedFiles,
} from "../scripts/import";

// These are intentionally synthetic parser/security fixtures, NOT the original CET351 lectures.
function zip(entries: Record<string, Uint8Array>) {
  return zipSync(entries, { level: 1 });
}

describe("CET351 import manifest and bounded ZIP (synthetic fixtures)", () => {
  it("requires six pinned real-document hashes and physical page counts", () => {
    expect(expectedFiles).toHaveLength(6);
    expect(expectedFiles.map((e) => e.physical_pages)).toEqual([
      18, 24, 18, 25, 26, 26,
    ]);
    for (const entry of expectedFiles)
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("extracts expected entries without writing public files", () => {
    const bytes = zip({ "Lec 1-ML.pdf": strToU8("%PDF-synthetic") });
    expect(inspectPackZip(bytes)).toHaveLength(1);
    expect(
      Buffer.from(extractPackZip(bytes).get("Lec 1-ML.pdf")!).toString(),
    ).toBe("%PDF-synthetic");
  });
  it("rejects path traversal before decompressing", () => {
    expect(() =>
      inspectPackZip(zip({ "../Lec 1-ML.pdf": strToU8("x") })),
    ).toThrow("unexpected_entry");
  });
  it("rejects unexpected entries before decompressing", () => {
    expect(() => inspectPackZip(zip({ "secret.txt": strToU8("x") }))).toThrow(
      "unexpected_entry",
    );
  });
  it("rejects archives with more than six entries", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [`${i}.pdf`, strToU8("x")]),
    );
    expect(() => inspectPackZip(zip(entries))).toThrow("zip_limits");
  });
  it("rejects decompression bombs from metadata before allocating an inflater", () => {
    const bytes = zip({ "Lec 1-ML.pdf": new Uint8Array(3_500_001) });
    expect(() => inspectPackZip(bytes)).toThrow("zip_limits");
  });
  it("checks actual decompressed bytes even when metadata understates the size", () => {
    const b = Buffer.from(
      zip({ "Lec 1-ML.pdf": new Uint8Array(1000).fill(65) }),
    );
    const central = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    b.writeUInt32LE(1, central + 24);
    b.writeUInt32LE(1, 22);
    expect(() => extractPackZip(b)).toThrow();
  });
  it("rejects duplicate normalized expected names", () => {
    const b = Buffer.from(
      zip({ "Lec 1-ML.pdf": strToU8("a"), "Lec 2-ML.pdf": strToU8("b") }),
    );
    const from = Buffer.from("Lec 2-ML.pdf");
    const to = Buffer.from("Lec 1-ML.pdf");
    for (let p = b.indexOf(from); p >= 0; p = b.indexOf(from, p + to.length))
      to.copy(b, p);
    expect(() => inspectPackZip(b)).toThrow("duplicate_entry");
  });
  it("rejects invalid archive and altered originals", () => {
    expect(() => inspectPackZip(strToU8("not a zip"))).toThrow("pack_size");
    expect(() =>
      verifyOriginal("Lec 4-ML.pdf", strToU8("%PDF-synthetic")),
    ).toThrow("hash_mismatch");
  });
  it("rejects central/local filename disagreement", () => {
    const b = Buffer.from(zip({ "Lec 1-ML.pdf": strToU8("x") }));
    b[30] = "X".charCodeAt(0);
    expect(() => inspectPackZip(b)).toThrow("invalid_zip");
  });
});

describe("PDF parser using synthetic, explicitly non-lecture bytes", () => {
  it("extracts the actual page text and physical page count", async () => {
    const { parsePdf } = await import("../src/server/sources");
    const pages = await parsePdf(syntheticPdf());
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain(
      "Synthetic parser test - not CET351 lecture evidence",
    );
  }, 30000);
  it("rejects a non-PDF before invoking the parser", async () => {
    const { parsePdf } = await import("../src/server/sources");
    await expect(parsePdf(strToU8("pretend document"))).rejects.toThrow(
      "invalid_pdf",
    );
  });
});
