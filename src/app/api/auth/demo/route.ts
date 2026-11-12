import { z } from "zod";
import {
  assertDemoMode,
  createSession,
  requireAuth,
  setCookie,
  SESSION_COOKIE,
  WORKSPACE_COOKIE,
  cookieValue,
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
    const code = body.workspaceCode ?? cookieValue(request, WORKSPACE_COOKIE);
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
        mode: "sandbox",
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
    return errorResponse(e, localeFrom(request));
  }
}
