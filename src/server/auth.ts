import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { db, scopedDb, type Queryable } from "./db";
import { AppError, checkOrigin, localeFrom, type Locale } from "./errors";
import { isInviteOnlyPilot } from "./access-mode";
export { isInviteOnlyPilot } from "./access-mode";
export type Role = "student" | "instructor" | "advisor";
export interface AuthContext {
  tenantId: string;
  userId: string;
  role: Role;
  courseId: string;
  locale: Locale;
  name?: { ar: string; en: string };
  sessionId?: string;
}
export type CourseOperation =
  "read" | "tutor" | "practice" | "generate" | "write" | "review" | "publish";
export function assertDemoMode(): void {
  if (
    process.env.DEMO_MODE !== "true" ||
    process.env.TILWA_ENV === "production" ||
    (process.env.VERCEL_ENV === "production" && !isInviteOnlyPilot())
  )
    throw new AppError(403, "DEMO_DISABLED");
}
export const SESSION_COOKIE = "tilwa_session";
export const WORKSPACE_COOKIE = "tilwa_workspace";
const ttl = 60 * 60 * 24 * 7;
export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new AppError(503, "SESSION_CONFIG");
  return value;
}
export function cookieValue(
  request: Request,
  name: string,
): string | undefined {
  const pair = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`));
  if (!pair) return;
  try {
    return decodeURIComponent(pair.slice(name.length + 1));
  } catch {
    return;
  }
}
function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}
interface Token {
  tid: string;
  sid: string;
  uid: string;
  exp: number;
}
function decode(token: string): Token {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new AppError(401, "UNAUTHORIZED");
  const expected = sign(payload);
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted))
    throw new AppError(401, "UNAUTHORIZED");
  let data: Token;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new AppError(401, "UNAUTHORIZED");
  }
  if (
    typeof data.tid !== "string" ||
    typeof data.uid !== "string" ||
    typeof data.sid !== "string" ||
    typeof data.exp !== "number" ||
    data.exp < Date.now() / 1000
  )
    throw new AppError(401, "UNAUTHORIZED");
  return data;
}
export function setCookie(
  name: string,
  value: string,
  request: Request,
  maxAge = ttl,
): string {
  const secure =
    process.env.VERCEL || new URL(request.url).protocol === "https:";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export async function createSession(
  tenantId: string,
  userId: string,
): Promise<string> {
  secret();
  const id = randomUUID(),
    exp = Math.floor(Date.now() / 1000) + ttl;
  await db
    .tenant(tenantId)
    .query(
      "INSERT INTO auth_sessions(tenant_id,id,user_id,expires_at) VALUES($1,$2,$3,$4)",
      [tenantId, id, userId, new Date(exp * 1000).toISOString()],
    );
  const payload = Buffer.from(
    JSON.stringify({ tid: tenantId, sid: id, uid: userId, exp }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
export async function requireAuth(
  request: Request,
  roles?: Role[],
): Promise<AuthContext> {
  checkOrigin(request);
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) throw new AppError(401, "UNAUTHORIZED");
  const data = decode(token);
  const { rows } = await db
    .tenant(data.tid)
    .query<{ role: Role; name: { ar: string; en: string } }>(
      `SELECT m.role,u.name FROM auth_sessions s JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id JOIN tenants t ON t.id=s.tenant_id WHERE s.tenant_id=$1 AND s.id=$2 AND s.user_id=$3 AND s.revoked_at IS NULL AND s.expires_at>now() AND m.active=true AND (NOT $4::boolean OR t.synthetic=true)`,
      [data.tid, data.sid, data.uid, isInviteOnlyPilot()],
    );
  if (!rows[0]) throw new AppError(401, "UNAUTHORIZED");
  if (roles && !roles.includes(rows[0].role))
    throw new AppError(403, "FORBIDDEN");
  return {
    tenantId: data.tid,
    userId: data.uid,
    role: rows[0].role,
    name: rows[0].name,
    courseId: "CET351",
    locale: localeFrom(request),
    sessionId: data.sid,
  };
}
export async function authorizeCourse(
  ctx: AuthContext,
  courseId: string,
  operation: CourseOperation = "read",
) {
  return authorizeCourseInTransaction(ctx, courseId, operation, scopedDb(ctx));
}
export async function authorizeCourseInTransaction(
  ctx: AuthContext,
  courseId: string,
  operation: CourseOperation,
  sql: Queryable,
) {
  const { rows } = await sql.query<{
    role: Role;
    can_review: boolean;
    can_publish: boolean;
  }>(
    `SELECT m.role,c.can_review,c.can_publish FROM memberships m JOIN course_access c ON c.tenant_id=m.tenant_id AND c.user_id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND c.course_id=$3 AND m.active AND c.active`,
    [ctx.tenantId, ctx.userId, courseId],
  );
  const access = rows[0];
  if (!access || access.role !== ctx.role)
    throw new AppError(403, "COURSE_FORBIDDEN");
  if (
    ["write", "generate", "review", "publish"].includes(operation) &&
    access.role !== "instructor"
  )
    throw new AppError(403, "FORBIDDEN");
  if (
    (operation === "review" && !access.can_review) ||
    (operation === "publish" && !access.can_publish)
  )
    throw new AppError(403, "FORBIDDEN");
  const { rows: policies } = await sql.query<{ version: string }>(
    "SELECT version FROM policy_versions WHERE active=true",
  );
  if (!policies[0]) throw new AppError(503, "DATABASE_UNAVAILABLE");
  const { rows: exams } = await sql.query(
    "SELECT id FROM exam_sessions WHERE tenant_id=$1 AND user_id=$2 AND course_id=$3 AND protected=true AND status='active' LIMIT 1",
    [ctx.tenantId, ctx.userId, courseId],
  );
  if (exams.length && ["tutor", "practice", "generate"].includes(operation))
    throw new AppError(403, "EXAM_PROTECTED");
  return {
    policyVersion: policies[0].version,
    examMode: exams.length > 0,
    canReview: access.can_review,
    canPublish: access.can_publish,
  };
}
export async function requireAdvisee(
  ctx: AuthContext,
  studentId: string,
): Promise<void> {
  if (ctx.role !== "advisor") throw new AppError(403, "FORBIDDEN");
  const { rows } = await scopedDb(ctx).query(
    "SELECT student_id FROM advisor_assignments WHERE tenant_id=$1 AND advisor_id=$2 AND student_id=$3 AND active",
    [ctx.tenantId, ctx.userId, studentId],
  );
  if (!rows.length) throw new AppError(403, "FORBIDDEN");
}
export async function logout(request: Request): Promise<void> {
  const ctx = await requireAuth(request);
  await scopedDb(ctx).query(
    "UPDATE auth_sessions SET revoked_at=now() WHERE tenant_id=$1 AND id=$2",
    [ctx.tenantId, ctx.sessionId],
  );
}
