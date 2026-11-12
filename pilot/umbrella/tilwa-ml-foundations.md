# Tilwa supplementary foundations for the CET351 pilot
# أساسيات مساندة لتجربة تِلوا في مادة تعلم الآلة

Version 1.0. Original practice material written for this pilot. Source role: supplementary. Local parsing, indexing, display and model-assisted retrieval of this original handout are intended for the Tilwa pilot. This handout is independent of the supplied GeeksforGeeks index and does not claim to be a course lecture or an official assessment.

## U1 — Which group is the denominator? / مين المجموعة اللي بنقسم عليها؟

In a class-conditional fraction, first specify who is eligible to be in the denominator. “Of the events that actually happened, how many did we detect?” and “Of the alerts we raised, how many were real?” start from different groups. Draw the eligible group before calculating.

قبل ما تحسب أي نسبة، حدّد المجموعة اللي السؤال بيتكلم عنها. «من كل الحالات الإيجابية فعلًا، اكتشفنا كام؟» تبدأ بالحالات الإيجابية الفعلية. «من كل التنبيهات اللي طلّعها الموديل، كام تنبيه طلع صحيح؟» تبدأ بالتنبيهات. تغيير مجموعة البداية بيغيّر المقام.

## U2 — Recall and precision / الاستدعاء والإحكام

For a specified positive class, recall uses actual positives: TP / (TP + FN). Precision uses predicted positives: TP / (TP + FP). A denominator of zero means the corresponding ratio needs an explicit convention or an “undefined” label. Report the counts as well as a percentage.

عند تحديد الفئة الإيجابية، يحسب Recall الحالات التي اكتُشفت من جميع الإيجابيات الفعلية. ويحسب Precision التنبيهات الصحيحة من جميع التنبيهات الإيجابية. لو المقام صفر نعرض الوصف المعتمد للحالة؛ ما نستنتجش نسبة من غير بيانات.

Original worked example: a system produced eight alerts. Five were genuine, three were false alerts, and it missed another five genuine cases. Precision = 5/8 = 62.5%. Recall = 5/10 = 50%. In a critique task, a student can locate the first wrong step when a solution uses total alerts as the recall denominator.

مثال مستقل: لو النظام أصدر ٨ تنبيهات، منهم ٥ صح و٣ غلط، وفاته ٥ حالات حقيقية تانية، يبقى Precision بيساوي ٥ من ٨، وRecall بيساوي ٥ من ١٠. تحديد أي مجموعة دخلت المقام يوضح سبب اختلاف النسبتين.

## U3 — Choosing and justifying a metric / اختيار المقياس وتبرير القرار

A model can achieve high overall accuracy by repeatedly choosing a common class while missing a rare class. The choice of metric depends on the decision, the cost of misses and false alerts, prevalence and any review capacity. Compare two models on the same held-out cases. A defensible recommendation explains which error is more consequential in the stated setting, and what the other metric costs.

ارتفاع Accuracy ممكن يخفي مشكلة في فئة نادرة. اسأل عن تكلفة الحالة اللي الموديل فوّتها، وتكلفة الإنذار الغلط، وعدد التنبيهات اللي الفريق يقدر يراجعها. يتغيّر القرار بتغيّر السياق. حساب المقياس واختياره وتبريره أهداف تعليمية منفصلة.

## U4 — Transferring a derivative to an update / استخدام المشتقة في خطوة تحديث

For a scalar differentiable loss and a small positive learning rate, gradient descent updates a weight by subtracting the step size times its local derivative. At a positive derivative a sufficiently small negative change in the weight can reduce loss locally. Computing a derivative and interpreting the direction of a step are separate observable skills.

لو هدفنا نقلّل دالة خسارة قابلة للاشتقاق في متغير واحد، بنطرح حاصل ضرب معدل تعلّم موجب في المشتقة المحلية من الوزن الحالي. لو المشتقة موجبة فالتحرك بمقدار صغير ناحية القيم الأقل قد يقلّل الخسارة محليًا. معرفة اشتقاق الدالة لوحدها لا تثبت إن الطالب بيعرف يختار اتجاه التحديث.

## U5 — Conditional probability in classification / الاحتمال الشرطي في التصنيف

A conditional probability describes an event within a specified reference group. For categorical Naïve Bayes, the likelihood for a feature value within a class is estimated from the training examples in that class, with an explicit smoothing rule where relevant. The usual model factorizes the features conditional on the class. A Python implementation is one practice setting; the objective of interpreting a class-conditional frequency can also be assessed from a small table.

الاحتمال الشرطي بيربط الحدث بمجموعة مرجعية محددة. في Naïve Bayes للفئات الوصفية، بنقدّر احتمال قيمة الخاصية من أمثلة التدريب داخل الفئة، مع تطبيق قاعدة التنعيم المعتمدة عند الحاجة. استقلال الخصائص هنا افتراض مشروط بالفئة. الطالب يقدر يفسّر جدول تكرارات يدويًا حتى لو لسه ماكتبش كود Python.
