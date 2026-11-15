import type { Queryable } from "./db";
export type Bilingual = { ar: string; en: string };
export type DemoUsers = {
  student: string;
  instructor: string;
  advisor: string;
};
const bi = (ar: string, en: string): Bilingual => ({ ar, en });
export async function seedDomain(
  tx: Queryable,
  tenantId: string,
  users: DemoUsers,
) {
  const records: Array<{
    id: string;
    kind: string;
    owner?: string;
    data: unknown;
  }> = [];
  const add = (id: string, kind: string, data: unknown, owner?: string) =>
    records.push({ id, kind, data, owner });
  add("course:CET351", "course", {
    code: "CET351",
    openEnrollment: true,
    title: bi("تعلّم الآلة", "Machine Learning"),
    semester: bi("الفصل الدراسي الأول ٢٠٢٦", "Fall 2026"),
    institution: bi("جامعة تِلوا التجريبية", "Tilwa Demo University"),
    fixture: true,
  });
  const objectives = [
    ["recall.calculate", "حساب الاستدعاء", "Calculate recall"],
    ["metric.choose", "اختيار المقياس", "Choose a metric"],
    ["metric.justify", "تبرير الاختيار", "Justify the metric"],
    ["solution.review", "مراجعة خطوات الحل", "Review a solution"],
    ["gradient.transfer", "نقل فهم المشتقة", "Transfer derivative knowledge"],
  ];
  for (const [id, ar, en] of objectives)
    add(`objective:${id}`, "objective", {
      objectiveId: id,
      title: bi(ar, en),
      conceptId: id === "gradient.transfer" ? "gradient" : "recall",
      fixture: true,
    });
  add("session:foundations", "session", {
    title: bi(
      "مصفوفة الالتباس وPrecision وRecall",
      "Confusion Matrix, Precision and Recall",
    ),
    body: bi(
      "ابدأ بتحديد الفئة الإيجابية. Recall = TP / (TP + FN)، بينما Precision = TP / (TP + FP). في المثال الأصلي للملحق: ٥ تنبيهات صحيحة، ٣ تنبيهات خاطئة و٥ حالات فائتة؛ إذن Recall = 50% وPrecision = 62.5%. حساب النسبة واختيار المقياس وتبريره أهداف منفصلة. هذا الملحق مساند وليس نص محاضرة CET351.",
      "First specify the positive class. Recall = TP / (TP + FN), whereas Precision = TP / (TP + FP). The original supplement uses 5 true alerts, 3 false alerts and 5 missed cases: recall is 50% and precision is 62.5%. Calculation, metric choice and justification are separate objectives. This is supplemental material, not a CET351 lecture extract.",
    ),
    lecture: 4,
    module: "evaluation",
    durationMinutes: 12,
    approved: true,
    approvalKind: "fixture-review",
    sourceLabel: bi(
      "ملحق تِلوا الأصلي · U2 وU3 · اعتماد تجريبي",
      "Tilwa original supplement · U2 and U3 · fixture approval",
    ),
    objectiveIds: ["recall.calculate", "metric.choose", "metric.justify"],
    fixture: true,
    version: "supplement-1",
  });
  const base = {
    approved: true,
    protected: false,
    version: 1,
    graphVersion: "fixture-1",
    policyVersion: "tilwa-policy-1",
    fixture: true,
    review: { languageEquivalent: true, kind: "fixture-review" },
    sourceKey: "TILWA-PILOT-FOUNDATIONS",
  };
  const option = (id: string, ar: string, en: string) => ({
    id,
    label: bi(ar, en),
  });
  add("item:recall-a", "item", {
    ...base,
    kind: "choice",
    objectiveId: "recall.calculate",
    familyId: "recall-a",
    stem: bi(
      "مثال تدريبي جديد: اكتشفنا ٨ حالات إيجابية وفاتتنا حالتان. ما Recall؟",
      "Original practice: 8 positive cases detected and 2 missed. What is recall?",
    ),
    options: [
      option("a", "٨٠٪", "80%"),
      option("b", "٢٠٪", "20%"),
      option("c", "٢٥٪", "25%"),
    ],
    key: "a",
    feedback: bi(
      "المقام هو كل الإيجابيات الفعلية: 8 / (8 + 2) = 80%.",
      "The denominator is all actual positives: 8 / (8 + 2) = 80%.",
    ),
    locator: "U2",
  });
  add("item:recall-b", "item", {
    ...base,
    kind: "choice",
    objectiveId: "recall.calculate",
    familyId: "recall-b",
    stem: bi(
      "في نظام جديد: TP = 9 وFN = 3 وFP = 6. ما Recall؟",
      "In a new system: TP = 9, FN = 3 and FP = 6. What is recall?",
    ),
    options: [
      option("a", "٦٠٪", "60%"),
      option("b", "٧٥٪", "75%"),
      option("c", "٥٠٪", "50%"),
    ],
    key: "b",
    feedback: bi(
      "Recall = 9 / (9 + 3) = 75%. الإنذارات الخاطئة تدخل Precision.",
      "Recall = 9 / (9 + 3) = 75%. False alerts belong in the precision denominator.",
    ),
    locator: "U2",
  });
  add("item:choose-a", "item", {
    ...base,
    kind: "choice",
    objectiveId: "metric.choose",
    familyId: "choose-a",
    stem: bi(
      "في فحص أولي يمكن مراجعة الإنذارات، لكن تفويت حالة خطيرة مكلف جدًا. أي مقياس نركز عليه مع متابعة تكلفة الإنذارات؟",
      "In screening, alerts can be reviewed but missing a serious case is very costly. Which metric should receive emphasis while monitoring alert costs?",
    ),
    options: [
      option("accuracy", "Accuracy فقط", "Accuracy alone"),
      option(
        "recall",
        "Recall مع مراقبة Precision",
        "Recall while monitoring precision",
      ),
      option("speed", "سرعة النموذج فقط", "Model speed alone"),
    ],
    key: "recall",
    feedback: bi(
      "Recall يقيس الحالات الإيجابية التي اكتُشفت. راقب أيضًا Precision وقدرة المراجعة.",
      "Recall measures detected actual positives. Also monitor precision and review capacity.",
    ),
    locator: "U3",
  });
  add("item:choose-b", "item", {
    ...base,
    kind: "choice",
    objectiveId: "metric.choose",
    familyId: "choose-b",
    stem: bi(
      "فريق مراجعة صغير يضيع وقته في تنبيهات خاطئة. ما المقياس الذي يوضح جودة التنبيهات؟",
      "A small review team spends most of its time on false alerts. Which metric describes alert quality?",
    ),
    options: [
      option("precision", "Precision", "Precision"),
      option("recall", "Recall فقط", "Recall alone"),
      option("accuracy", "Accuracy فقط", "Accuracy alone"),
    ],
    key: "precision",
    feedback: bi(
      "Precision هو نسبة التنبيهات الصحيحة من كل التنبيهات.",
      "Precision is the fraction of all alerts that are genuine.",
    ),
    locator: "U3",
  });
  add("item:justify-a", "item", {
    ...base,
    kind: "open",
    objectiveId: "metric.justify",
    familyId: "justify-a",
    stem: bi(
      "برّر اختيار Recall في الفحص الأولي، واذكر تكلفة محتملة لهذا الاختيار.",
      "Justify emphasizing recall in screening and explain one possible cost.",
    ),
    options: [],
    key: "moderation",
    rubric: bi(
      "يربط تفويت الحالة بالتكلفة؛ يذكر الإنذارات الخاطئة وقدرة المراجعة. اعتماد المدرّس مطلوب.",
      "Connect missed cases to cost; discuss false alerts and review capacity. Instructor moderation required.",
    ),
    locator: "U3",
  });
  add("item:critique-a", "item", {
    ...base,
    kind: "critique",
    objectiveId: "solution.review",
    familyId: "critique-a",
    stem: bi(
      "راجع الحل: حدّد أول خطوة خاطئة واشرح التصحيح.",
      "Review the solution: identify the first wrong step and explain the correction.",
    ),
    steps: [
      bi("١. TP = 5 وFN = 5 وFP = 3.", "1. TP = 5, FN = 5, FP = 3."),
      bi(
        "٢. مقام Recall يساوي TP + FP = 8.",
        "2. The recall denominator is TP + FP = 8.",
      ),
      bi("٣. إذن Recall = 62.5%.", "3. Therefore recall is 62.5%."),
    ],
    options: [
      option("1", "الخطوة ١", "Step 1"),
      option("2", "الخطوة ٢", "Step 2"),
      option("3", "الخطوة ٣", "Step 3"),
    ],
    key: "2",
    rubric: bi(
      "تحديد الخطوة ٢؛ شرح أن المقام إيجابيات فعلية؛ تصحيح Recall إلى 50%.",
      "Locate step 2; explain actual-positive denominator; correct recall to 50%.",
    ),
    feedback: bi(
      "أول خطأ في الخطوة ٢. المقام TP + FN، والنتيجة 50%. شرحك ينتظر مراجعة المدرّس.",
      "The first error is step 2. Use TP + FN, giving 50%. Your explanation awaits instructor review.",
    ),
    locator: "U2",
  });
  add("item:transfer-a", "item", {
    ...base,
    kind: "transfer",
    objectiveId: "gradient.transfer",
    familyId: "transfer-a",
    stem: bi(
      "مهمة انتقال اختيارية مساندة: المشتقة المحلية للخسارة موجبة. مع خطوة تعلّم صغيرة موجبة، هل نزيد الوزن أم نقلله لتقليل الخسارة؟",
      "Optional supplemental bridge: the local loss derivative is positive. With a small positive learning rate, should the weight increase or decrease to reduce loss?",
    ),
    options: [
      option("up", "نزيد الوزن", "Increase"),
      option("down", "نقلّل الوزن", "Decrease"),
    ],
    key: "down",
    feedback: bi(
      "w الجديد = w − η × المشتقة. عند مشتقة موجبة نتحرك قليلًا ناحية وزن أقل. حساب مشتقة x² وحده لا يثبت فهم الاتجاه.",
      "New w = w − η × derivative. A positive derivative calls for a small move toward lower weight. Differentiating x² alone does not prove update-direction knowledge.",
    ),
    locator: "U4",
    supplemental: true,
  });
  add("assignment:evaluation", "assignment", {
    title: bi("تقرير تقييم نموذج", "Model evaluation report"),
    body: bi(
      "قارن Recall وPrecision على نفس بيانات الاختبار. اشرح تكلفة الخطأ وقدّم جدول الحالات.",
      "Compare recall and precision on the same held-out cases. Explain error costs and include a count table.",
    ),
    due: "2026-11-15T20:00:00Z",
    objectiveIds: ["recall.calculate", "metric.choose", "metric.justify"],
    fixture: true,
  });
  add("announcement:welcome", "announcement", {
    title: bi("أهلًا بك في تجربة CET351", "Welcome to the CET351 pilot"),
    body: bi(
      "السجلات الطلابية والمواعيد تجريبية. المحاضرات الأصلية تُستورد وتُراجع من مساحة المدرّس.",
      "Student records and dates are synthetic. Original lectures are imported and reviewed in the instructor workspace.",
    ),
    fixture: true,
  });
  add("calendar:assignment", "calendar", {
    title: bi("واجب تقييم النماذج", "Model evaluation assignment"),
    date: "2026-11-15T20:00:00Z",
    type: "assignment",
    fixture: true,
  });
  add("calendar:quiz", "calendar", {
    title: bi("اختبار قصير", "Short quiz"),
    date: "2026-11-17T10:00:00Z",
    type: "quiz",
    fixture: true,
  });
  add("quality:baseline", "quality", {
    eligible: 30,
    assessed: 24,
    attaining: 18,
    fixture: true,
    notes: bi(
      "أعداد مؤسسية تجريبية؛ وصف للنتائج وليس تقديرًا سببيًا.",
      "Synthetic institutional counts; descriptive results, not causal estimates.",
    ),
    groups: [
      { objectiveId: "recall.calculate", assessed: 24, attaining: 18 },
      { objectiveId: "metric.choose", assessed: 24, attaining: 10 },
    ],
    languageChecks: bi(
      "تمت مراجعة تكافؤ نسخ AR/EN التجريبية.",
      "Fixture AR/EN equivalence reviewed.",
    ),
  });
  add(
    `preferences:${users.student}`,
    "preferences",
    {
      lessonLanguage: "mixed",
      presentation: "steps",
      uiLanguage: "ar",
      careerTarget: "ML Engineer",
    },
    users.student,
  );
  add(
    `history:${users.student}:calculus`,
    "event",
    {
      type: "historical-evidence",
      objectiveId: "calculus.differentiate",
      semester: "2025-spring",
      source: "synthetic-history",
      correct: true,
      assisted: false,
      at: "2025-04-15T10:00:00Z",
      title: bi("دليل سابق: اشتقاق x²", "Prior evidence: differentiating x²"),
      fixture: true,
    },
    users.student,
  );
  add(
    `history:${users.student}:classification`,
    "event",
    {
      type: "historical-evidence",
      objectiveId: "classification.describe",
      semester: "2025-fall",
      source: "synthetic-history",
      correct: true,
      assisted: false,
      at: "2025-11-15T10:00:00Z",
      title: bi(
        "دليل سابق: أساسيات التصنيف",
        "Prior evidence: classification foundations",
      ),
      fixture: true,
    },
    users.student,
  );
  for (const r of records)
    await tx.query(
      "INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT ON CONSTRAINT records_pkey DO NOTHING",
      [
        tenantId,
        r.id,
        r.kind,
        "CET351",
        r.owner ?? null,
        JSON.stringify(r.data),
      ],
    );
}
