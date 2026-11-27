"use client";
import { useEffect, useRef, useState } from "react";
import { Box, Button, request, type Translate } from "./Workspace";
import { uploadLargePdf } from "./sources";
import type { BuildJob } from "@/server/build-job-types";

type Role = "lecture" | "umbrella";
type FileRow = {
  id: string;
  file: File;
  role: Role;
  state:
    "ready" | "uploading" | "uploaded" | "duplicate" | "error" | "revision";
  message?: string;
  versionIds?: string[];
  conflict?: { page: number; id: string };
  revisions?: Record<number, string>;
};

export function KnowledgeBuildBatch({
  courseId,
  lang,
  t,
  onBusy,
  onNotice,
  onReview,
}: {
  courseId: string;
  lang: "en" | "ar";
  t: Translate;
  onBusy: (busy: boolean) => void;
  onNotice: (value: string) => void;
  onReview: (job: BuildJob) => Promise<void>;
}) {
  const [rows, setRows] = useState<FileRow[]>([]);
  const [rights, setRights] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<BuildJob[]>([]);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const sending = useRef(false);
  const previous = useRef(new Map<string, BuildJob["status"]>());
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      let delay = 12000;
      try {
        const result: { jobs: BuildJob[] } = await request(
          "/api/knowledge/jobs",
          undefined,
          lang,
          courseId,
        );
        if (!active) return;
        setJobs(result.jobs);
        setPollError("");
        for (const job of result.jobs) {
          const old = previous.current.get(job.id);
          if (
            old &&
            old !== job.status &&
            (job.status === "completed" || job.status === "failed")
          ) {
            onNotice(
              job.status === "completed"
                ? t(
                    "اكتملت معالجة ملفات المقرر.",
                    "Your course files have finished processing.",
                  )
                : t(
                    "تحتاج معالجة ملفات المقرر إلى مراجعتك.",
                    "A course build needs your attention.",
                  ),
            );
          }
          previous.current.set(job.id, job.status);
        }
        if (
          result.jobs.some(
            (j) => j.status === "processing" || j.status === "queued",
          )
        )
          delay = 2500;
      } catch (e) {
        if (active) setPollError((e as Error).message);
      } finally {
        if (active) timer = setTimeout(load, delay);
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [courseId, lang, refresh, onNotice]); // translations follow lang

  const labels = {
    queued: t("في قائمة الانتظار", "Queued"),
    processing: t("قيد المعالجة", "Processing"),
    completed: t("اكتمل", "Completed"),
    failed: t("تعذرت المعالجة", "Failed"),
    cancelled: t("ألغي", "Cancelled"),
    ready: t("جاهز للرفع", "Ready to upload"),
    uploading: t("جارٍ الرفع", "Uploading"),
    uploaded: t("تم الرفع", "Uploaded"),
    duplicate: t("موجود بالفعل", "Already uploaded"),
    error: t("تعذّر الرفع", "Upload failed"),
    revision: t("يتطلب تأكيد إصدار جديد", "Revision confirmation required"),
  };
  const update = (id: string, change: Partial<FileRow>) =>
    setRows((list) => list.map((r) => (r.id === id ? { ...r, ...change } : r)));
  const addFiles = (files: FileList | null, role: Role) => {
    const additions = Array.from(files ?? []).map((file) => ({
      id: crypto.randomUUID(),
      file,
      role,
      state: "ready" as const,
    }));
    setRows((list) => [...(submitted ? [] : list), ...additions]);
    setSubmitted(false);
  };
  const submit = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const ids = new Set<string>();
      let failed = false;
      // Finish references first so the worker sees their approved evidence.
      for (const row of [...rows].sort(
        (a, b) => Number(b.role === "umbrella") - Number(a.role === "umbrella"),
      )) {
        if (row.versionIds) {
          row.versionIds.forEach((id) => ids.add(id));
          continue;
        }
        update(row.id, { state: "uploading", message: "" });
        try {
          const progress = (n: number, total: number) =>
            update(row.id, {
              message: t("صفحة", "Page") + " " + n + " / " + total,
            });
          const result = await uploadLargePdf(row.file, {
            mode: row.role,
            courseId,
            rejectDuplicate: true,
            revisions: row.revisions,
            title: row.file.name.replace(/\.pdf$/i, "").trim() || row.file.name,
            rights,
            confirmed,
            lang,
            progress,
            slides: progress,
          });
          if (!result.versionIds.length)
            throw new Error(
              t(
                "تعذّر تحديد نسخة الملف.",
                "The uploaded version could not be identified.",
              ),
            );
          for (const id of result.versionIds) {
            await request(
              "/api/materials/" + encodeURIComponent(id),
              { action: "approve-pending" },
              lang,
              courseId,
            );
            ids.add(id);
          }
          update(row.id, {
            versionIds: result.versionIds,
            state:
              result.parts === result.duplicates ? "duplicate" : "uploaded",
            message: result.stopped,
          });
        } catch (e) {
          failed = true;
          const issue = e as Error & {
            currentVersionId?: string;
            firstPage?: number;
          };
          update(
            row.id,
            issue.currentVersionId
              ? {
                  state: "revision",
                  message: "",
                  conflict: {
                    id: issue.currentVersionId,
                    page: issue.firstPage ?? 1,
                  },
                }
              : { state: "error", message: issue.message },
          );
        }
      }
      if (failed || !ids.size) return;
      const { job } = await request(
        "/api/knowledge/jobs",
        { action: "create", documentIds: [...ids] },
        lang,
        courseId,
      );
      previous.current.set(job.id, job.status);
      setSubmitted(true);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      sending.current = false;
      setBusy(false);
      onBusy(false);
    }
  };
  const act = async (job: BuildJob, action: "cancel" | "retry" | "review") => {
    setBusy(true);
    setError("");
    try {
      if (action === "review") await onReview(job);
      else
        await request(
          "/api/knowledge/jobs",
          { action, id: job.id },
          lang,
          courseId,
        );
      setRefresh((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Box>
        <div className="two-columns">
          {(["lecture", "umbrella"] as const).map((role) => (
            <label key={role}>
              {role === "lecture"
                ? t("محاضرات (PDF)", "Lectures (PDF)")
                : t("مراجع (PDF)", "References (PDF)")}
              <input
                type="file"
                multiple
                accept=".pdf,application/pdf"
                disabled={busy}
                onChange={(e) => {
                  addFiles(e.target.files, role);
                  e.target.value = "";
                }}
              />
            </label>
          ))}
        </div>
        {rows.length > 0 && (
          <ul className="build-files">
            {rows.map((row) => (
              <li key={row.id}>
                <span>
                  <bdi>{row.file.name}</bdi>
                  <small>
                    {row.role === "lecture"
                      ? t("محاضرة", "Lecture")
                      : t("مرجع", "Reference")}{" "}
                    · {labels[row.state]} {row.message}
                  </small>
                </span>
                {!submitted && (
                  <button
                    type="button"
                    className="textbtn"
                    disabled={busy}
                    onClick={() =>
                      setRows((list) => list.filter((r) => r.id !== row.id))
                    }
                  >
                    {t("إزالة", "Remove")}
                  </button>
                )}
                {row.conflict && row.state === "revision" && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      update(row.id, {
                        state: "ready",
                        revisions: {
                          ...row.revisions,
                          [row.conflict!.page]: row.conflict!.id,
                        },
                        conflict: undefined,
                      })
                    }
                  >
                    {t("احفظ كنسخة جديدة", "Save as a new revision")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!submitted && rows.length > 0 && (
          <>
            {rows.some((r) => r.role === "umbrella") && (
              <label>
                {t("تصريح استخدام المراجع", "Reference usage permission")}
                <input
                  value={rights}
                  disabled={busy}
                  maxLength={200}
                  onChange={(e) => setRights(e.target.value)}
                />
              </label>
            )}
            <label className="checklabel">
              <input
                type="checkbox"
                disabled={busy}
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {t(
                "أوافق على استخدام الصفحات المقروءة في الاستخراج ولدي إذن باستخدام هذه الملفات.",
                "I approve readable pages for extraction and have permission to use these files.",
              )}
            </label>
            <Button
              primary
              disabled={
                busy ||
                !confirmed ||
                rows.some((r) => r.state === "revision") ||
                (rows.some((r) => r.role === "umbrella") &&
                  rights.trim().length < 5)
              }
              onClick={submit}
            >
              {rows.some((r) => r.state === "error")
                ? t("أعد محاولة الرفع", "Retry upload")
                : t("ارفع وابدأ المعالجة", "Upload and start build")}
            </Button>
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </Box>
      {pollError && <p role="alert">{pollError}</p>}
      {jobs.length > 0 && (
        <Box>
          <h2>{t("عمليات بناء المقرر", "Course build history")}</h2>
          {jobs.map((job) => (
            <article className="build-job" key={job.id}>
              <div className="row">
                <strong>{labels[job.status]}</strong>
                <time dateTime={job.createdAt}>
                  {new Date(job.createdAt).toLocaleString(lang)}
                </time>
              </div>
              <progress
                aria-label={t("معالجة الملفات", "Document processing")}
                max={job.documents.length || 1}
                value={
                  job.documents.filter((d) => d.status === "completed").length
                }
              />
              <ul className="build-files">
                {job.documents.map((d) => (
                  <li key={d.versionId}>
                    <span>
                      <bdi>{d.title}</bdi>
                      <small>
                        {d.role === "instructor"
                          ? t("محاضرة", "Lecture")
                          : t("مرجع", "Reference")}{" "}
                        · {labels[d.status]}{" "}
                        {d.completedSteps > 0 &&
                          " · " +
                            t("خطوات", "Steps") +
                            " " +
                            d.completedSteps}{" "}
                        {d.error}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
              {["queued", "processing"].includes(job.status) && (
                <Button disabled={busy} onClick={() => act(job, "cancel")}>
                  {t("إلغاء المعالجة", "Cancel build")}
                </Button>
              )}
              {["cancelled", "failed"].includes(job.status) && (
                <Button disabled={busy} onClick={() => act(job, "retry")}>
                  {t("إعادة المحاولة", "Retry build")}
                </Button>
              )}
              {job.documents.some((d) => d.proposalId) && (
                <Button disabled={busy} onClick={() => act(job, "review")}>
                  {t("مراجعة النتائج", "Review results")}
                </Button>
              )}
            </article>
          ))}
        </Box>
      )}
    </>
  );
}
