import { expect, test } from "@playwright/test";
import { syntheticPdf } from "../fixtures/synthetic-pdf";
import { mkdir } from "node:fs/promises";

for (const lang of ["ar", "en"] as const)
  test(`course upload to review in ${lang}`, async ({ page }) => {
    test.skip(
      !process.env.KM_FIXTURE,
      "Requires isolated knowledge-server and synthetic provider",
    );
    test.setTimeout(100000);
    await page.addInitScript(
      (l) => localStorage.setItem("tilwa_lang", l),
      lang,
    );
    const login = await page.request.post("/api/auth/demo", {
      data: { role: "instructor", locale: lang },
    });
    expect(login.ok()).toBeTruthy();
    await page.goto("/");
    const blocked = await page.request.get("/api/knowledge/jobs", {
      headers: { "X-Notch-Course": "not-enrolled" },
    });
    expect(blocked.status()).toBe(403);
    const open = () =>
      page
        .getByRole("button", {
          name: lang === "ar" ? "ابنِ الشجرة" : "Build the tree",
          exact: true,
        })
        .click();
    await open();
    await page
      .getByLabel(lang === "ar" ? "المقرر المستهدف" : "Target course")
      .selectOption("CET351");
    const pdf = (name: string, text: string) => ({
      name,
      mimeType: "application/pdf",
      buffer: Buffer.from(syntheticPdf(text)),
    });
    await page
      .getByLabel(lang === "ar" ? "محاضرات (PDF)" : "Lectures (PDF)", {
        exact: true,
      })
      .setInputFiles(
        pdf(
          "Derivatives.pdf",
          "The chain rule computes the derivative of a composition of differentiable functions. For example, differentiate the outer function and multiply by the inner derivative.",
        ),
      );
    await page
      .getByLabel(lang === "ar" ? "مراجع (PDF)" : "References (PDF)", {
        exact: true,
      })
      .setInputFiles(
        pdf(
          "Calculus.pdf",
          "Differentiating a composite function requires evaluating the derivative of the outer function at its inner argument and multiplying by the derivative of that argument.",
        ),
      );
    await page
      .getByLabel(
        lang === "ar" ? "تصريح استخدام المراجع" : "Reference usage permission",
      )
      .fill("Original synthetic fixture");
    await page
      .getByRole("checkbox", {
        name: lang === "ar" ? /أوافق على استخدام/ : /I approve readable/,
      })
      .check();
    await page
      .getByRole("button", {
        name: lang === "ar" ? "ارفع وابدأ المعالجة" : "Upload and start build",
      })
      .click();
    const review = page.getByRole("button", {
      name: lang === "ar" ? "مراجعة النتائج" : "Review results",
    });
    await expect(page.locator(".build-job").first()).toBeVisible({
      timeout: 30000,
    });
    await page
      .getByRole("button", {
        name: lang === "ar" ? "الهيكل الأكاديمي" : "Academic structure",
        exact: true,
      })
      .first()
      .click();
    await page.reload();
    await open();
    await review.click();
    await expect(
      page.getByRole("heading", {
        name:
          lang === "ar"
            ? "راجع الشجرة الناتجة"
            : "Review the tree that was produced",
      }),
    ).toBeVisible();
    await mkdir("test-results/km", { recursive: true });
    await page.screenshot({ path: "test-results/km/review-" + lang + ".png" });
    await page
      .getByRole("button", {
        name:
          lang === "ar" ? "اعتمد وانشر الشجرة" : "Approve and publish the tree",
      })
      .click();
    const lecture = page
      .locator("[data-graph-node=lecture]")
      .filter({ hasText: "Derivatives" });
    await lecture.click({ timeout: 20000 });
    const concept = page.locator("[data-graph-node=concept]").first();
    await concept.click();
    await expect(page.locator(".kg-detail-body")).toContainText("Chain rule");
    await page
      .locator(".kg")
      .screenshot({ path: "test-results/km/graph-" + lang + ".png" });
    // Re-upload the lecture with a different filename. The stored original stays canonical.
    const original = pdf(
      "Renamed.pdf",
      "The chain rule computes the derivative of a composition of differentiable functions. For example, differentiate the outer function and multiply by the inner derivative.",
    );
    await page
      .getByRole("button", {
        name: lang === "ar" ? "ارفع محاضرات أخرى" : "Upload more lectures",
      })
      .click();
    await page
      .getByLabel(lang === "ar" ? "محاضرات (PDF)" : "Lectures (PDF)", {
        exact: true,
      })
      .setInputFiles(original);
    await page
      .getByRole("checkbox", {
        name: lang === "ar" ? /أوافق على استخدام/ : /I approve readable/,
      })
      .check();
    await page
      .getByRole("button", {
        name: lang === "ar" ? "ارفع وابدأ المعالجة" : "Upload and start build",
      })
      .click();
    await expect(page.locator(".build-files").first()).toContainText(
      lang === "ar" ? "موجود بالفعل" : "Already uploaded",
    );
  });
