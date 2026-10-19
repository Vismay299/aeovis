# Measurement metrics and qualification

> <!-- doc-status -->
> **Status: LIVE.** Runtime formulas and proposed qualification policy, 20 October 2026.

A question panel, its scoring purpose and equal question weights are frozen before answers are collected. Branded diagnostic questions are counted separately. Recommendation questions are selected by their pre-observation purpose; brand-free answers remain in the declared mention/exposure panel. Customer scans require an approved panel. Legacy/generated unreviewed panels retain exploratory counts but cannot acquire a qualified headline through aggregation.

| Reading | Numerator | Denominator | Example |
|---|---|---|---|
| Mention | Answers naming the brand | Eligible observed answer texts | 6 of 30 = 20% |
| Citation | Observed citation lists citing the owned domain | Eligible observed citation lists | 1 of 30 = 3.333…%, displayed 3.3% |
| Exposure | Brand mentioned or owned domain cited | Eligible observed answers | Citation-only appearances count here even with zero text mentions |
| Recommendation | Positive recommendation judgments | Preselected recommendation questions with an observed judgment | 1 of 1 remains exploratory; it cannot qualify through 29 informational answers |
| Collection | Answered + valid no-AIO observations | Every planned question/surface pair | 29 of 30 = 96.666…%; 28 of 30 = 93.333…% |
| AIO trigger | Valid SERPs with an Overview | All valid SERPs | 0 of 30 valid no-AIO SERPs = 0% trigger and 100% valid collection |

A missing citation list is unknown, not a measured uncited list. A fully observed 30-question panel with zero brand appearances has measured exposure zero. A missing denominator has no percentage. Stored integer counts survive API/JSON export; rounded display values do not replace them.

The proposed v1 headline gate requires at least 20 distinct eligible prompts and at least 95% valid collection over all offered surfaces. Replicating one question 30 times yields one independent prompt. A failed surface remains in the collection denominator; its failure cannot silently improve the blended score by disappearing.

Self mention, citation and exposure do not depend on the tracked rival roster. Conditional vendor share does depend on that roster and carries its version. Comparisons require compatible panel, surface, full market/language/device/session context, model policy, metric/policy versions and engine cohort. A boundary suppresses a delta rather than masquerading as a performance change.

Rate uncertainty uses a deterministic prompt-cluster bootstrap with seed 1 and 2,000 resamples. Repeated observations within each prompt are averaged before resampling prompts. The exported interval includes method, seed, cluster count and replicate count. It is sampling uncertainty within the observed instrument; it does not establish population demand, judge accuracy, representativeness or causal effect. Calibration and release acceptance require their separate evidence.

Model APIs, Google SERPs and consumer browser captures are distinct instruments. Requested location is unverified unless observed evidence attests it. A source citation does not prove retrieval, and a verified publication does not prove indexing, crawling or later AI citation. Publication comparisons are anchored to the recorded publication, use compatible observations and withhold qualified deltas for small/incomplete target panels.
