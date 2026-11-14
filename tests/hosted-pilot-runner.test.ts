import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkHostedPilot,
  progressFingerprint,
  publicCitation,
  sameOriginUrl,
  updateCookies,
  validateOrigin,
} from "../scripts/check-hosted-pilot";

afterEach(() => vi.restoreAllMocks());
describe("hosted acceptance runner safeguards; mocked HTTP only", () => {
  it("keeps credentials on the exact configured origin and rejects unsafe base URLs", () => {
    const base = validateOrigin("https://tilwa.example/");
    expect(sameOriginUrl(base, "/sources/version?page=18").origin).toBe(base);
    for (const path of [
      "https://outside.example/",
      "//outside.example/",
      "https://user@tilwa.example/",
      "http://tilwa.example/",
    ])
      expect(() => sameOriginUrl(base, path)).toThrow();
    for (const value of [
      "https://user:password@tilwa.example/",
      "https://tilwa.example/?token=secret",
      "https://tilwa.example/path",
      "http://outside.example/",
    ])
      expect(() => validateOrigin(value)).toThrow();
  });
  it("drops the revoked session while retaining the workspace cookie", () => {
    const jar = new Map<string, string>();
    updateCookies(jar, [
      "tilwa_session=token; HttpOnly; Secure",
      "tilwa_workspace=invitation; Max-Age=7776000; HttpOnly",
    ]);
    updateCookies(jar, ["tilwa_session=; Max-Age=0; HttpOnly"]);
    expect(jar.has("tilwa_session")).toBe(false);
    expect(jar.get("tilwa_workspace")).toBe("invitation");
  });
  it("compares persisted progress independently of ordering and notices changed mastery", () => {
    const before = {
      states: [
        { id: "a", data: { status: "developing", evidence: 2 } },
        { id: "b", data: { status: "secure" } },
      ],
      progress: [{ id: "done" }],
      user: { id: "student", role: "student" },
    };
    const reordered = {
      ...before,
      states: [...before.states].reverse(),
      user: { id: "student", role: "advisor" },
    };
    expect(progressFingerprint(before)).toEqual(progressFingerprint(reordered));
    expect(
      progressFingerprint({
        ...before,
        states: [{ id: "a", data: { status: "secure" } }],
      }).sha256,
    ).not.toBe(progressFingerprint(before).sha256);
  });
  it("public citation evidence omits excerpt text and private identifiers", () => {
    const citation = publicCitation({
      id: "private-chunk",
      versionId: "private-version",
      sourceKey: "CET351-L4",
      page: 18,
      section: null,
      url: "/sources/private-version?page=18",
      text: "Private licensed lecture excerpt",
    });
    expect(citation).toEqual({
      sourceKey: "CET351-L4",
      page: 18,
      section: null,
    });
  });
  it("returns an explicit failed report on an unexpected HTTP status and never logs secrets", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ private: "unexpected-response" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const report = await checkHostedPilot({
      base: "https://tilwa.example",
      code: "secret-invitation-value",
      bypass: "secret-vercel-bypass",
      stage: "test",
      database: false,
      liveTutor: false,
    });
    expect(report.status).toBe("failed");
    expect(report.failure).toEqual({
      code: "http_200_expected_401",
      step: "unauthenticated_map",
    });
    expect(report.tutorRequests).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toMatch(
      /secret-invitation|secret-vercel|unexpected-response/,
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret/);
  });
});
