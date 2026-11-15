/** Public access-mode metadata only; never returns credentials or workspace identifiers. */
export function isInviteOnlyPilot(): boolean {
  return (
    process.env.DEMO_MODE === "true" &&
    process.env.TILWA_ENV === "pilot" &&
    process.env.PILOT_ACCESS_MODE === "invite-only"
  );
}
/**
 * Test-phase switch: when set to the id of a provisioned synthetic workspace,
 * visitors enter that shared workspace without typing its code.
 */
export function openPilotTenant(): string | null {
  const id = process.env.PILOT_OPEN_TENANT?.trim() ?? "";
  return isInviteOnlyPilot() && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}
