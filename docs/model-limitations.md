# Model limitations and confidence guidance

OpenReflex runs [Laya](https://github.com/NandhaKishorM/laya) checkpoints locally. The limits below come from Laya's own documentation. OpenReflex shows them to users rather than hiding them.

## Known limitations

| Limitation | What OpenReflex does |
| --- | --- |
| The base checkpoints score poorly on some typed-decision zero-shot tests. | Recipes default to the `typed-decisions` profile. |
| Shipped confidence can be over-confident without domain calibration. | Confidence thresholds are review policies. A result under the threshold is `needs_review`. A result over it is not a claim of correctness. |
| Inputs are truncated to a finite context (512 tokens for English, 1024 for the multilingual and typed-decisions checkpoints). | A truncation warning is shown when upstream reports truncation, or when the input probably exceeds the profile's budget. |
| Large choice sets compete for a limited option-prompt budget, and accuracy drops sharply. | Recipes allow 2–20 options normally. 21–50 options produce a warning, and more than 50 are rejected. |
| Ordinal `score` questions are weaker than `choice` and `noul`. | Every `score` answer carries a warning. |
| The English and multilingual checkpoints have different strengths. | Both are "advanced" profiles. Every result reports the checkpoint and revision that produced it. |

## Using confidence

- Treat `needs_review` as a signal that a person should look at the result.
- Never wire a result directly to an automated action without your own domain evaluation.
- Calibrate thresholds on your own labelled examples before relying on them.
