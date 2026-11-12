export type Locale = "ar" | "en";
const messages: Record<string, { ar: string; en: string }> = {
  UNAUTHORIZED: { ar: "سجّل الدخول للمتابعة.", en: "Sign in to continue." },
  FORBIDDEN: {
    ar: "ليس لديك صلاحية لهذا الإجراء.",
    en: "You do not have permission for this action.",
  },
  COURSE_FORBIDDEN: {
    ar: "هذا المقرر غير متاح لحسابك.",
    en: "This course is not available to your account.",
  },
  EXAM_PROTECTED: {
    ar: "المساعد والتدريب غير متاحين أثناء الاختبار المحمي. يمكنك الرجوع لتعليمات الاختبار.",
    en: "Tutoring and practice are unavailable during a protected exam. Refer to the exam instructions.",
  },
  DATABASE_UNAVAILABLE: {
    ar: "قاعدة البيانات غير متاحة الآن. حاول مرة أخرى؛ لن نولّد إجابة دون الأدلة المعتمدة.",
    en: "The database is currently unavailable. Please retry; we cannot generate an answer without approved evidence.",
  },
  DEMO_DISABLED: {
    ar: "حسابات التجربة متاحة في البيئة التجريبية فقط.",
    en: "Demo accounts are available only in a sandbox environment.",
  },
  INVALID_WORKSPACE: {
    ar: "رمز مساحة التجربة غير صحيح.",
    en: "The workspace recovery code is invalid.",
  },
  INVALID_INPUT: {
    ar: "تحقق من البيانات المطلوبة وحاول مرة أخرى.",
    en: "Check the required fields and try again.",
  },
  SESSION_CONFIG: {
    ar: "يلزم إعداد تسجيل الدخول على الخادم.",
    en: "Server sign-in configuration is required.",
  },
  NOT_FOUND: {
    ar: "لم يتم العثور على المحتوى المطلوب.",
    en: "The requested content was not found.",
  },
  PROVIDER_UNAVAILABLE: {
    ar: "خدمة الذكاء الاصطناعي غير متاحة حاليًا. حاول مرة أخرى.",
    en: "The AI provider is currently unavailable. Please retry.",
  },
  RATE_LIMITED: {
    ar: "وصلت للحد المؤقت للطلبات. حاول بعد قليل.",
    en: "The temporary request limit was reached. Please retry shortly.",
  },
  CONCEPT_ALIAS_CONFLICT: {
    ar: "التسمية مستخدمة لمفهوم آخر. استخدم الدمج أو تسمية مختلفة.",
    en: "This label belongs to another concept. Use a reviewed merge or a distinct label.",
  },
  STALE_GRAPH: {
    ar: "تغيّرت نسخة خريطة المفاهيم. راجع اقتراحًا جديدًا على النسخة الحالية.",
    en: "The graph release changed. Propose and review a mapping against the current release.",
  },
  STALE_EVIDENCE: {
    ar: "تغيّر الدليل أو لم يعد معتمدًا. راجع المصادر الحالية أولًا.",
    en: "Evidence changed or is no longer approved. Review the current sources first.",
  },
  GRAPH_RELEASE_REQUIRED: {
    ar: "انشر خريطة مفاهيم معتمدة قبل إنشاء التحويل.",
    en: "Publish an approved concept graph before creating a mapping.",
  },
  INTERNAL: {
    ar: "تعذر إتمام الطلب. حاول مرة أخرى.",
    en: "The request could not be completed. Please retry.",
  },
};
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? messages[code]?.en ?? code);
    this.name = "AppError";
  }
}
export function errorResponse(error: unknown, locale: Locale = "ar"): Response {
  const e =
    error instanceof AppError
      ? error
      : new AppError(
          error && typeof error === "object" && "issues" in error ? 400 : 503,
          error && typeof error === "object" && "issues" in error
            ? "INVALID_INPUT"
            : "DATABASE_UNAVAILABLE",
        );
  const pair = messages[e.code] ?? messages.INTERNAL;
  return Response.json(
    { error: { code: e.code, message: pair[locale], messages: pair } },
    { status: e.status, headers: { "Cache-Control": "no-store" } },
  );
}
export function localeFrom(request: Request): Locale {
  return request.headers.get("x-language") === "en" ||
    request.headers.get("accept-language")?.startsWith("en")
    ? "en"
    : "ar";
}
export function checkOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new AppError(403, "FORBIDDEN");
  if (origin) {
    // Next may expose an internal request.url hostname; Host is the browser's destination.
    const internal = new URL(request.url);
    const host = request.headers.get("host") || internal.host;
    const forwardedProto = process.env.VERCEL
      ? request.headers.get("x-forwarded-proto")
      : null;
    const protocol = forwardedProto === "https" ? "https:" : internal.protocol;
    let expected: string;
    try {
      expected = new URL(`${protocol}//${host}`).origin;
    } catch {
      throw new AppError(403, "FORBIDDEN");
    }
    if (origin !== expected) throw new AppError(403, "FORBIDDEN");
  }
  const type = request.headers.get("content-type") ?? "";
  if (
    !type.startsWith("application/json") &&
    !type.startsWith("multipart/form-data") &&
    !type.startsWith("application/pdf")
  )
    throw new AppError(400, "INVALID_INPUT");
}
