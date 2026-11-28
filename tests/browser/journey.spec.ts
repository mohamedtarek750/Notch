import { test, expect } from "@playwright/test";
test("Arabic student journey, server progress, second browser context and English UI", async ({
  page,
  browser,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("tilwa_lang"))
      localStorage.setItem("tilwa_lang", "ar");
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "نرتقي بالتعليم درجة." }),
  ).toBeVisible();
  await page.getByRole("button", { name: /طالب.*دخول تجريبي/ }).click();
  await page
    .getByRole("checkbox", { name: /أوافق على استخدام المنصة/ })
    .check();
  await page.getByRole("button", { name: "متابعة", exact: true }).click();
  await expect(page.getByRole("heading", { name: "أهلًا بك" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "المحاضرات", exact: true }).click();
  await page.getByRole("button", { name: "فتح الجلسة" }).first().click();
  await expect(
    page.getByRole("heading", { name: /مصفوفة الالتباس/ }).first(),
  ).toBeVisible();
  const state = await page.request.get("/api/workspace");
  expect(state.ok()).toBeTruthy();
  const data = await state.json();
  expect(data.sessions.length).toBeGreaterThan(0);
  const complete = await page.request.post("/api/learning", {
    data: { action: "complete-session", sessionId: data.sessions[0].id },
  });
  expect(complete.ok()).toBeTruthy();
  const attempt = await page.request.post("/api/learning", {
    data: { action: "select-practice", objectiveId: "recall.calculate" },
  });
  expect(attempt.ok()).toBeTruthy();
  const selection = await attempt.json();
  expect(selection.item.data.key).toBeUndefined();
  const body = {
    action: "attempt",
    deliveryId: selection.deliveryId,
    answer: "a",
    idempotencyKey: crypto.randomUUID(),
  };
  const accepted = await page.request.post("/api/learning", { data: body });
  expect(accepted.ok()).toBeTruthy();
  const retry = await page.request.post("/api/learning", { data: body });
  expect(retry.ok()).toBeTruthy();
  expect(await retry.json()).toEqual(await accepted.json());
  const cookies = await page.context().cookies();
  const workspaceCode = cookies.find(
    (c) => c.name === "tilwa_workspace",
  )!.value;
  await page.request.post("/api/auth/logout", { data: {} });
  const newContext = await browser.newContext();
  const next = await newContext.newPage();
  await next.addInitScript(() => {
    if (!localStorage.getItem("tilwa_lang"))
      localStorage.setItem("tilwa_lang", "ar");
  });
  await next.goto("/");
  await newContext.request.post("/api/auth/demo", {
    data: { role: "student", workspaceCode: decodeURIComponent(workspaceCode) },
  });
  const restored = await newContext.request.get("/api/workspace");
  const result = await restored.json();
  expect(result.progress.some((p: any) => p.data.completed)).toBe(true);
  expect(result.attempts).toHaveLength(1);
  await next.reload();
  await next.getByRole("button", { name: "English", exact: true }).click();

  await expect(next.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(next.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await newContext.close();
});
test("Instructor and assigned advisor APIs enforce roles; protected exam applies across contexts", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const login = await context.request.post("/api/auth/demo", {
    data: { role: "instructor" },
  });
  expect(login.ok()).toBeTruthy();
  const { workspaceCode } = await login.json();
  const w = await (await context.request.get("/api/workspace")).json();
  expect(w.qms.attainment).toBe(75);
  expect(w.qms.coverage).toBe(80);
  const student = await browser.newContext();
  await student.request.post("/api/auth/demo", {
    data: { role: "student", workspaceCode },
  });
  const forbidden = await student.request.post("/api/learning", {
    data: {
      action: "announcement",
      title: { ar: "عنوان", en: "Title" },
      body: { ar: "محتوى", en: "Body" },
    },
  });
  expect(forbidden.status()).toBe(403);
  const start = await context.request.post("/api/learning", {
    data: { action: "start-exam", studentId: w.students[0] },
  });
  expect(start.ok()).toBeTruthy();
  const tutor = await student.request.post("/api/tutor", {
    data: { question: "ليه الـRecall هنا 60%؟", language: "ar" },
  });
  const answer = await tutor.json();
  expect(tutor.status() === 403 || answer.disposition === "protected").toBe(
    true,
  );
  const denied = await student.request.post("/api/learning", {
    data: { action: "select-practice" },
  });
  expect(denied.status()).toBe(403);
  await context.request.post("/api/learning", {
    data: { action: "end-exam", studentId: w.students[0] },
  });
  await context.request.post("/api/auth/demo", {
    data: { role: "advisor", workspaceCode },
  });
  const advisor = await (await context.request.get("/api/workspace")).json();
  expect(advisor.students).toEqual(w.students);
  await context.close();
  await student.close();
});
test("Desktop and mobile dashboard evidence with no horizontal overflow", async ({
  page,
}) => {
  await page.request.post("/api/auth/demo", { data: { role: "student" } });
  await page.setViewportSize({ width: 1305, height: 936 });
  await page.addInitScript(() => {
    if (!localStorage.getItem("tilwa_lang"))
      localStorage.setItem("tilwa_lang", "ar");
  });
  await page.goto("/");
  await page
    .getByRole("checkbox", { name: /أوافق على استخدام المنصة/ })
    .check();
  await page.getByRole("button", { name: "متابعة", exact: true }).click();
  await expect(page.getByRole("heading", { name: "أهلًا بك" })).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 1508 });
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "فتح القائمة" }).click();
  await expect(page.getByRole("dialog", { name: "القائمة" })).toBeVisible();
  await page.getByRole("button", { name: "إغلاق القائمة" }).click();
});
