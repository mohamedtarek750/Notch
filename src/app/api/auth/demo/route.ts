import { z } from "zod";
import {
  assertDemoMode,
  createSession,
  requireAuth,
  setCookie,
  SESSION_COOKIE,
  WORKSPACE_COOKIE,
  cookieValue,
  isInviteOnlyPilot,
} from "@/server/auth";
import { createWorkspace, resolveWorkspace } from "@/server/seed";
import {
  AppError,
  checkOrigin,
  errorResponse,
  localeFrom,
} from "@/server/errors";
export const runtime = "nodejs";
export async function POST(request: Request) {
  let locale = localeFrom(request);
  try {
    checkOrigin(request);
    assertDemoMode();
    const body = z
      .object({
        role: z.enum(["student", "instructor", "advisor"]),
        workspaceCode: z.string().min(16).max(128).optional(),
        locale: z.enum(["ar", "en"]).optional(),
      })
      .parse(await request.json());
    locale = body.locale ?? locale;
    const inviteOnly = isInviteOnlyPilot();
    const code = body.workspaceCode ?? cookieValue(request, WORKSPACE_COOKIE);
    if (inviteOnly && !code) throw new AppError(401, "INVITE_REQUIRED");
    const workspace = code
      ? await resolveWorkspace(code)
      : await createWorkspace();
    const userId = workspace.users[body.role];
    if (!userId) throw new AppError(403, "FORBIDDEN");
    const token = await createSession(workspace.tenantId, userId);
    const fake = new Request(request.url, {
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        "x-language": body.locale ?? localeFrom(request),
      },
    });
    const user = await requireAuth(fake);
    delete user.sessionId;
    const response = Response.json(
      {
        user,
        workspaceCode: workspace.workspaceCode,
        mode: inviteOnly ? "pilot" : "sandbox",
        accessMode: inviteOnly ? "invite-only" : "sandbox",
        synthetic: true,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    response.headers.append(
      "Set-Cookie",
      setCookie(SESSION_COOKIE, token, request),
    );
    response.headers.append(
      "Set-Cookie",
      setCookie(
        WORKSPACE_COOKIE,
        workspace.workspaceCode,
        request,
        60 * 60 * 24 * 90,
      ),
    );
    return response;
  } catch (e) {
    return errorResponse(e, locale);
  }
}
