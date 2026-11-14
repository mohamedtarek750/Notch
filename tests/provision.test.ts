import { describe, expect, it } from "vitest";
import { provisioningBlockers } from "../scripts/provision-preview";
describe("non-production provisioning prerequisite guard (offline)", () => {
  it("blocks missing secrets and has no network side effects when imported", () => {
    const result = provisioningBlockers({});
    expect(result.join(" ")).toContain("NEON_API_KEY");
    expect(result.join(" ")).toContain("VERCEL_TOKEN");
    expect(result.join(" ")).toContain("GEMINI_API_KEY");
    expect(result.join(" ")).toContain("PROVISION_PREVIEW");
  });
  it("blocks production even with credentials and explicit opt-in", () => {
    expect(
      provisioningBlockers({
        NEON_API_KEY: "test",
        VERCEL_TOKEN: "test",
        GEMINI_API_KEY: "test",
        PROVISION_PREVIEW: "1",
        VERCEL_ENV: "production",
      }),
    ).toEqual(["This runner cannot operate in a production environment."]);
  });
  it("permits only explicitly opted-in nonproduction setup", () => {
    expect(
      provisioningBlockers({
        NEON_API_KEY: "test",
        VERCEL_TOKEN: "test",
        GEMINI_API_KEY: "test",
        PROVISION_PREVIEW: "1",
      }),
    ).toEqual([]);
  });
});
