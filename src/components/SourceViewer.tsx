"use client";
import { useEffect, useState } from "react";
import { request, Button } from "./Workspace";
export function SourceViewer({ id }: { id: string }) {
  const [lang, L] = useState<"ar" | "en">("ar"),
    [data, D] = useState<any>(null),
    [error, E] = useState(""),
    [page, P] = useState("");
  const t = (a: string, b: string) => (lang === "ar" ? a : b);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    P(q.get("page") || q.get("section") || "");
    request(`/api/materials/${id}`, undefined, lang)
      .then(D)
      .catch((e) => E(e.message));
  }, [id]);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);
  return (
    <main className="source-view" dir={lang === "ar" ? "rtl" : "ltr"}>
      <header>
        <a href="/" aria-label="Tilwa | تِلوا">
          <img src="/brand/tilwa.png" width={100} alt="Tilwa | تِلوا" />
        </a>
        <Button onClick={() => L(lang === "ar" ? "en" : "ar")}>
          {lang === "ar" ? "English" : "العربية"}
        </Button>
      </header>
      {error ? (
        <div role="alert" className="error">
          {error}
        </div>
      ) : data ? (
        <>
          <span className="badge lavender">
            {t("مصدر خاص · عرض موثّق", "Private source · cited passage")}
          </span>
          <h1>{data.material.title}</h1>
          <small>
            <bdi>{data.material.source_key}</bdi> · {t("نسخة", "Version")}{" "}
            {data.material.id}
          </small>
          <div className="page-list">
            {data.chunks.map((c: any) => (
              <button
                key={c.id}
                className={
                  String(c.page || c.section) === page ? "selected" : ""
                }
                onClick={() => P(String(c.page || c.section))}
              >
                {c.page || c.section}
              </button>
            ))}
          </div>
          {data.chunks
            .filter((c: any) => !page || String(c.page || c.section) === page)
            .map((c: any) => (
              <section key={c.id}>
                <h2>
                  {t("صفحة / قسم", "Page / section")} {c.page || c.section}
                </h2>
                <blockquote dir="auto">{c.text_content}</blockquote>
                <small>
                  {t(
                    "النص الأصلي المستخرج؛ أي ترجمة في الشرح لا تغيّر الأصل.",
                    "Original extracted passage; lesson translations do not replace the source.",
                  )}
                </small>
              </section>
            ))}
          <footer>
            {t(
              "المصدر متاح فقط بحسب صلاحيات المقرر وحالة الاعتماد.",
              "Source access follows course authorization and approval status.",
            )}
          </footer>
        </>
      ) : (
        <p role="status">{t("جارٍ تحميل المصدر…", "Loading source…")}</p>
      )}
    </main>
  );
}
