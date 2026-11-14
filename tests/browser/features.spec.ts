import { test, expect, type Page } from "@playwright/test";
// Local PostgreSQL/PGlite and real HTTP/UI. These journeys do not simulate Gemini
// and must not be reported as Neon/Gemini live integration passes.
async function login(
  page: Page,
  role: "student" | "instructor" | "advisor" = "student",
) {
  await page.goto("/");
  const label =
    role === "student"
      ? /طالب.*دخول تجريبي/
      : role === "instructor"
        ? /مدرّس.*دخول تجريبي/
        : /مرشد أكاديمي.*دخول تجريبي/;
  await page.getByRole("button", { name: label }).click();
  await expect(
    page.getByRole("button", { name: "تسجيل الخروج", exact: true }),
  ).toBeVisible();
}
async function changeRole(
  page: Page,
  role: "student" | "instructor" | "advisor",
) {
  await page.getByRole("button", { name: "تسجيل الخروج", exact: true }).click();
  const label =
    role === "student"
      ? /طالب.*دخول تجريبي/
      : role === "instructor"
        ? /مدرّس.*دخول تجريبي/
        : /مرشد أكاديمي.*دخول تجريبي/;
  await page.getByRole("button", { name: label }).click();
  await expect(
    page.getByRole("button", { name: "تسجيل الخروج", exact: true }),
  ).toBeVisible();
}
async function practice(
  page: Page,
  objective: string,
  answer: string,
  explanation?: string,
) {
  await page.getByLabel(/^الهدف التعليمي/).selectOption(objective);
  await page.getByRole("button", { name: "سؤال جديد", exact: true }).click();
  await expect(page.locator(".practice h2")).toBeVisible();
  await page.locator(`input[type=radio][value="${answer}"]`).check();
  if (explanation)
    await page
      .getByLabel("اشرح اختيارك (مطلوب في مراجعة الحل)", { exact: true })
      .fill(explanation);
  await page
    .getByRole("button", { name: "تسجيل الإجابة", exact: true })
    .click();
  await expect(page.locator(".feedback")).toBeVisible();
}
async function snapshot(page: Page) {
  const result = await page.request.get("/api/workspace");
  expect(result.ok()).toBeTruthy();
  return result.json();
}
test("UI: independent calculation and choice evidence, Arabic/English persistence", async ({
  page,
}) => {
  const jsErrors: string[] = [];
  page.on("pageerror", (error) => jsErrors.push(error.message));
  await login(page);
  await page
    .getByRole("button", { name: "الاختبارات والتدريب", exact: true })
    .click();
  await practice(page, "recall.calculate", "a");
  await expect(page.locator(".feedback")).toContainText("80%");
  await practice(page, "recall.calculate", "b");
  await practice(page, "metric.choose", "accuracy");
  const w = await snapshot(page);
  expect(
    w.states.find((r: any) => r.data.objectiveId === "recall.calculate").data
      .status,
  ).toBe("secure");
  expect(
    w.states.find((r: any) => r.data.objectiveId === "metric.choose").data
      .status,
  ).toBe("developing");
  expect(w.attempts).toHaveLength(3);
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(
    page.getByRole("heading", { name: "Practice workspace" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Concept map", exact: true }).click();
  await expect(page.getByText("Secure evidence", { exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByText("Developing", { exact: true })).toHaveCount(1);
  expect(jsErrors).toEqual([]);
});
test("UI: critique captures wrong step and explanation; optional transfer tracks a distinct gap", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", { name: "الاختبارات والتدريب", exact: true })
    .click();
  await practice(
    page,
    "solution.review",
    "2",
    "المقام يجب أن يكون الإيجابيات الفعلية TP + FN، أي 10، فالنتيجة 50%.",
  );
  await expect(page.locator(".feedback")).toContainText("مراجعة المدرّس");
  await practice(page, "gradient.transfer", "up");
  await expect(page.locator(".feedback")).toContainText("وزن أقل");
  const w = await snapshot(page);
  const critique = w.attempts.find(
    (a: any) => a.data.objectiveId === "solution.review",
  );
  expect(critique.data.errorLocation).toBe("2");
  expect(critique.data.moderation).toBe("pending");
  expect(
    w.states.find((s: any) => s.data.objectiveId === "solution.review").data
      .status,
  ).toBe("unassessed");
  expect(
    w.recommendations.find(
      (s: any) => s.data.objectiveId === "gradient.transfer",
    ).data.title.en,
  ).toContain("derivative");
  await changeRole(page, "instructor");
  await page
    .getByRole("button", { name: "المحاضرة القادمة", exact: true })
    .click();
  // Instructor moderation UI is exercised here; student text is not auto-scored as a rubric pass.
  const review = page
    .locator(".proposal-card")
    .filter({ hasText: critique.data.explanation });
  await expect(review).toBeVisible();
  await review
    .getByLabel("ملاحظات المعيار بالعربية")
    .fill("حددت المقام الصحيح وفسّرت التصحيح.");
  await review
    .getByLabel("ملاحظات المعيار بالإنجليزية")
    .fill("Correct denominator and explanation.");
  await review.getByRole("button", { name: "اعتماد مراجعة الإجابة" }).click();
  await expect(review).toHaveCount(0);
  const reviewed = await snapshot(page);
  expect(
    reviewed.attempts.find((a: any) => a.id === critique.id).data.moderation,
  ).toBe("reviewed");
});
test("UI: assignment feedback, selected portfolio and assigned advisor rubric review", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "التكليفات", exact: true }).click();
  await page
    .getByLabel("إجابتك أو رابط التقرير الخاص")
    .fill(
      "قارنت Precision وRecall على نفس بيانات الاختبار، وراجعت تكلفة الحالات الفائتة.",
    );
  await page.getByRole("button", { name: "تسليم الواجب", exact: true }).click();
  await expect(
    page.locator(".notice").filter({ hasText: "قارنت Precision" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "الخطة المهنية", exact: true })
    .click();
  await page.getByRole("button", { name: "ML Engineer", exact: true }).click();
  await page.getByLabel("عنوان العمل").fill("Fraud evaluation notebook");
  await page
    .getByLabel("رابط خاص للتقرير أو Notebook")
    .fill("https://example.com/private/tilwa-notebook");
  await page
    .getByLabel("ما الذي يثبته هذا العمل؟")
    .fill("جدول الحالات ومقارنة تكلفة الخطأ وخطوات إعادة التجربة.");
  await page
    .getByRole("button", { name: "إضافة للملف المختار", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Fraud evaluation notebook" }),
  ).toBeVisible();
  await changeRole(page, "instructor");
  await page.getByRole("button", { name: "التكليفات", exact: true }).click();
  await page
    .getByLabel("تغذية راجعة بالعربية", { exact: true })
    .fill("أضف حجم بيانات الاختبار وتكلفة الإنذارات الخاطئة.");
  await page
    .getByLabel("تغذية راجعة بالإنجليزية", { exact: true })
    .fill("Add test size and false alert cost.");
  await page.getByLabel("درجة التكليف (٠–١٠٠)").fill("82");
  await page.getByRole("button", { name: /حفظ المراجعة/ }).click();
  await expect(
    page.locator(".notice p").filter({ hasText: "أضف حجم بيانات الاختبار" }),
  ).toBeVisible();
  let w = await snapshot(page);
  expect(w.submissions[0].data.status).toBe("reviewed");
  expect(w.submissions[0].data.officialGrade).toBe(false);
  await changeRole(page, "advisor");
  await page
    .getByRole("button", { name: "الخطة المهنية", exact: true })
    .click();
  await page
    .getByLabel("التغذية الراجعة بالعربية")
    .fill("أضف تعليمات تشغيل ونتيجة مستقلة على بيانات جديدة.");
  await page
    .getByLabel("التغذية الراجعة بالإنجليزية")
    .fill("Add reproduction steps and independent evaluation.");
  await page.getByLabel(/^التحليل/).selectOption("3");
  await page.getByLabel(/^قابلية إعادة التنفيذ/).selectOption("2");
  await page.getByRole("button", { name: /حفظ مراجعة/ }).click();
  await expect(
    page.getByText("أضف تعليمات تشغيل ونتيجة مستقلة على بيانات جديدة.", {
      exact: true,
    }),
  ).toBeVisible();
  w = await snapshot(page);
  expect(w.portfolio[0].data.status).toBe("reviewed");
  expect(w.portfolio[0].data.rubric.reproducibility).toBeGreaterThanOrEqual(0);
  expect(w.students).toHaveLength(1);
});
test("UI: bilingual teaching intervention, QMS denominators and small-group privacy", async ({
  page,
}) => {
  await login(page, "instructor");
  await page
    .getByRole("button", { name: "المحاضرة القادمة", exact: true })
    .click();
  await page.getByLabel(/^الهدف/).selectOption("metric.choose");
  await page
    .getByLabel("العنوان بالعربية", { exact: true })
    .fill("اختيار المقياس حسب تكلفة الخطأ");
  await page
    .getByLabel("العنوان بالإنجليزية", { exact: true })
    .fill("Choose a metric by error cost");
  await page
    .getByLabel("النص بالعربية", { exact: true })
    .fill("قارن تكلفة تفويت الحالات وتكلفة الإنذارات الخاطئة.");
  await page
    .getByLabel("النص بالإنجليزية", { exact: true })
    .fill("Compare the cost of missed cases and false alerts.");
  await page
    .getByRole("button", { name: "اعتماد التدخل", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "اختيار المقياس حسب تكلفة الخطأ" }),
  ).toBeVisible();
  const w = await snapshot(page);
  expect(w.interventions[0].data.after.suppressed).toBe(true);
  expect(w.interventions[0].data.freshFamiliesOnly).toBe(true);
  await page
    .getByRole("button", { name: "الجودة التعليمية", exact: true })
    .click();
  await expect(page.locator(".quality-stat").first()).toContainText("75%");
  await expect(page.locator(".quality-stat").first()).toContainText("18 / 24");
  await expect(page.locator(".quality-stat").nth(1)).toContainText("80%");
  await expect(page.locator(".quality-stat").nth(1)).toContainText("24 / 30");
  await expect(page.getByText(/هذه الأعداد اصطناعية/)).toBeVisible();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Educational quality" }),
  ).toBeVisible();
  await expect(
    page.getByText("Synthetic counts: 30 eligible, 24 assessed, 18 attaining."),
  ).toBeVisible();
});
