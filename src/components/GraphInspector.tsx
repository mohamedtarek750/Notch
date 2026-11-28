import { ArrowUpRight, FileText, Network } from "lucide-react";
import type { KGDetail, KGNode } from "@/lib/knowledge-graph";
import { kindNames, levelNames, relationStyles } from "./graph-layout";
import { nodeIcons } from "./GraphCanvas";
import type { Translate } from "./Workspace";

export function GraphInspector({
  node,
  detail,
  status,
  lang,
  t,
  open,
  recheck,
  rechecking,
}: {
  node: KGNode | undefined;
  detail: KGDetail | null;
  status: string;
  lang: "ar" | "en";
  t: Translate;
  open: (item: KGNode) => void;
  recheck: () => void;
  rechecking: boolean;
}) {
  if (!node)
    return (
      <aside className="kg-inspector kg-inspector-empty">
        <Network size={26} />
        <h2>{t("تفاصيل العنصر", "Node details")}</h2>
        <p>
          {t(
            "اختر عنصرًا من الرسم لعرض مصادره وعلاقاته.",
            "Select a node to explore its sources and connections.",
          )}
        </p>
      </aside>
    );
  const kind = node.external ? "external" : node.kind,
    Icon = nodeIcons[kind];
  const otherLang = lang === "ar" ? "en" : "ar";
  const nodeList = (title: string, nodes: KGNode[]) =>
    nodes.length > 0 && (
      <section className="kg-detail-group">
        <h3>
          {title} <span>{nodes.length}</span>
        </h3>
        <ul>
          {nodes.map((n) => {
            const NodeIcon = nodeIcons[n.kind];
            return (
              <li key={[n.kind, n.courseId, n.id].join("|")}>
                <button className="kg-inspect-link" onClick={() => open(n)}>
                  <NodeIcon size={15} />
                  <span>{n.label[lang] || n.label[otherLang]}</span>
                  <ArrowUpRight size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    );
  const parents = detail?.parents ?? [];
  const children = detail?.children ?? [];
  return (
    <aside
      className="kg-inspector"
      aria-label={t("تفاصيل العنصر", "Node details")}
    >
      <header className={"kg-inspector-head kg-" + kind}>
        <span className="kg-inspector-icon">
          <Icon size={21} />
        </span>
        <div>
          <small>
            {t(kindNames[kind][0], kindNames[kind][1])}
            {node.code && (
              <>
                {" "}
                · <bdi>{node.code}</bdi>
              </>
            )}
          </small>
          <h2 dir="auto">{node.label[lang] || node.label[otherLang]}</h2>
        </div>
      </header>
      {status && (
        <p role="status" className="kg-detail-status">
          {status}
        </p>
      )}
      {detail && (
        <div className="kg-detail-body">
          {node.kind === "lecture" && (
            <section className="kg-detail-group">
              <h3>{t("المعرفة المطلوبة", "Knowledge Required")}</h3>
              {detail.requirements?.length ? (
                <ul>
                  {detail.requirements.map(
                    ({ concept, target, course, evidence }) => (
                      <li key={[concept.id, target.id].join("|")}>
                        <button
                          className="kg-inspect-link"
                          onClick={() => open(concept)}
                        >
                          <span dir="auto">{concept.label[lang]}</span>
                          <ArrowUpRight size={13} />
                        </button>
                        {course && (
                          <small dir="auto">
                            {t("من مقرر", "From")} {course.label[lang]}
                            {course.code && (
                              <>
                                {" "}
                                · <bdi>{course.code}</bdi>
                              </>
                            )}
                          </small>
                        )}
                        <div>
                          <small dir="auto">
                            {t("مطلوب لفهم", "Needed for")} {target.label[lang]}
                          </small>
                        </div>
                        <a
                          href={`/sources/${encodeURIComponent(evidence.id)}?${new URLSearchParams({ courseId: evidence.courseId, lang, ...(evidence.page !== null && { page: String(evidence.page) }) })}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {evidence.title}
                          {evidence.page !== null && (
                            <>
                              {" "}
                              · {t("ص", "p.")} {evidence.page}
                            </>
                          )}
                        </a>
                      </li>
                    ),
                  )}
                </ul>
              ) : (
                <p>
                  {t(
                    "لا توجد متطلبات منشورة لهذه المحاضرة بعد.",
                    "This lecture has no published prerequisites yet.",
                  )}
                </p>
              )}
              {children.length > 0 && (
                <button
                  className="kg-action"
                  disabled={rechecking}
                  onClick={recheck}
                >
                  {rechecking
                    ? t("جارٍ بدء الفحص…", "Starting check…")
                    : t(
                        "افحص متطلبات من مقررات أخرى",
                        "Check other courses for prerequisites",
                      )}
                </button>
              )}
            </section>
          )}
          {node.kind === "concept" && (
            <section className="kg-detail-group">
              <h3>{t("المصطلحات", "Terminology")}</h3>
              <dl className="kg-terms">
                <dt>العربية</dt>
                <dd lang="ar" dir="auto">
                  {detail.node.label.ar || "—"}
                </dd>
                <dt>English</dt>
                <dd lang="en" dir="auto">
                  {detail.node.label.en || "—"}
                </dd>
              </dl>
              {Boolean(detail.aliases.length) && (
                <div
                  className="kg-aliases"
                  aria-label={t("أسماء بديلة", "Aliases")}
                >
                  {detail.aliases.map((alias) => (
                    <span dir="auto" key={alias}>
                      {alias}
                    </span>
                  ))}
                </div>
              )}
            </section>
          )}
          {detail.definition && (
            <section className="kg-detail-group">
              <h3>{t("التعريف", "Definition")}</h3>
              <p dir="auto">
                {detail.definition[lang] || detail.definition[otherLang]}
              </p>
            </section>
          )}
          {(["major", "course", "lecture", "concept"] as const).map((k) => (
            <div key={k}>
              {nodeList(
                t(levelNames[k][0], levelNames[k][1]),
                [...parents, ...children].filter((n) => n.kind === k),
              )}
            </div>
          ))}
          {detail.relations.length > 0 && (
            <section className="kg-detail-group">
              <h3>
                {t("العلاقات", "Connections")}{" "}
                <span>{detail.relations.length}</span>
              </h3>
              <ul>
                {detail.relations.map((r) => {
                  const style = relationStyles[r.type];
                  const label =
                    r.type === "PREREQUISITE_OF"
                      ? r.direction === "in"
                        ? t("متطلب سابق", "Prerequisite")
                        : t("يعتمد عليه", "Dependent")
                      : t(style.label[0], style.label[1]);
                  return (
                    <li
                      key={[
                        r.direction,
                        r.type,
                        r.node.courseId,
                        r.node.id,
                      ].join("|")}
                    >
                      <button
                        className="kg-relation-link"
                        onClick={() => open(r.node)}
                      >
                        <small>
                          <i style={{ background: style.color }} />
                          {label}
                        </small>
                        <span dir="auto">
                          {r.node.label[lang] || r.node.label[otherLang]}
                        </span>
                        {r.type !== "PREREQUISITE_OF" && (
                          <small dir="auto">
                            {
                              (r.direction === "out" ? node : r.node).label[
                                lang
                              ]
                            }{" "}
                            →{" "}
                            {
                              (r.direction === "out" ? r.node : node).label[
                                lang
                              ]
                            }
                          </small>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {detail.resources.length > 0 && (
            <section className="kg-detail-group">
              <h3>
                {t("المصادر والأدلة", "Sources and evidence")}{" "}
                <span>{detail.resources.length}</span>
              </h3>
              <ul>
                {detail.resources.map((r, i) => {
                  const query = new URLSearchParams({
                    courseId: r.courseId,
                    lang,
                  });
                  if (r.page !== null) query.set("page", String(r.page));
                  else if (r.section) query.set("section", r.section);
                  return (
                    <li key={[r.id, r.page, r.section, i].join("|")}>
                      <a
                        className="kg-inspect-link"
                        href={`/sources/${encodeURIComponent(r.id)}?${query}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <FileText size={15} />
                        <span>
                          {r.title}
                          {r.page !== null && (
                            <>
                              {" "}
                              · {t("ص", "p.")} {r.page}
                            </>
                          )}
                          {r.section && <> · {r.section}</>}
                        </span>
                        <ArrowUpRight size={13} />
                      </a>
                      {r.excerpt && (
                        <blockquote dir="auto">{r.excerpt}</blockquote>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {!parents.length &&
            !children.length &&
            !detail.relations.length &&
            !detail.resources.length && (
              <p className="kg-detail-status">
                {t(
                  "لا توجد روابط أو مصادر منشورة لهذا العنصر.",
                  "No published connections or sources for this node.",
                )}
              </p>
            )}
        </div>
      )}
    </aside>
  );
}
