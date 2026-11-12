import { logout, setCookie, SESSION_COOKIE } from "@/server/auth";
import { errorResponse, localeFrom } from "@/server/errors";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    await logout(request);
    return Response.json(
      { ok: true },
      {
        headers: {
          "Set-Cookie": setCookie(SESSION_COOKIE, "", request, 0),
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (e) {
    return errorResponse(e, localeFrom(request));
  }
}
