import { requireAuth } from "@/server/auth";
import {
  getConceptMappings,
  conceptMappingAction,
} from "@/server/concept-mapping";
import { errorResponse, localeFrom } from "@/server/errors";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    return Response.json(
      await getConceptMappings(await requireAuth(request, ["instructor"])),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, localeFrom(request));
  }
}
export async function POST(request: Request) {
  try {
    return Response.json(
      await conceptMappingAction(
        await requireAuth(request, ["instructor"]),
        await request.json(),
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, localeFrom(request));
  }
}
