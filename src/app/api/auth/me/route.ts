import { isInviteOnlyPilot, requireAuth } from "@/server/auth";
import { errorResponse, localeFrom } from "@/server/errors";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const user = await requireAuth(request);
    delete user.sessionId;
    const inviteOnly = isInviteOnlyPilot();
    const sandbox = process.env.DEMO_MODE === "true";
    return Response.json(
      {
        user,
        mode: inviteOnly ? "pilot" : sandbox ? "sandbox" : "institutional",
        accessMode: inviteOnly
          ? "invite-only"
          : sandbox
            ? "sandbox"
            : "institutional",
        synthetic: sandbox,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e, localeFrom(request));
  }
}
