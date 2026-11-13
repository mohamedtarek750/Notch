/** Public access-mode metadata only; never returns credentials or workspace identifiers. */
export function isInviteOnlyPilot(): boolean {
  return (
    process.env.DEMO_MODE === "true" &&
    process.env.TILWA_ENV === "pilot" &&
    process.env.PILOT_ACCESS_MODE === "invite-only"
  );
}
