# Laya compatibility matrix

Release-critical. The adapter (`openreflex.laya_adapter`) and this document must change together.

- **Date last verified:** 2026-09-21
- **Verified with:** `py scripts/laya_compat/run.py probe --profile typed-decisions` (Linux container, CPU)
- **Native Windows real-model verification:** **not done — release blocker.** Windows Application Control blocks torch's native DLLs on the development machine (see Task 0.3b–d in `progress.md`).

## Product ↔ upstream

| Product version | Laya package | Model repo | Pinned revision |
| --- | --- | --- | --- |
| 0.1.0.dev0 | `laya==0.3.4` (PyPI, Apache-2.0) | `convaiinnovations/laya` | `1c5edc17a7acd8701df6fc341c0d179f1c62c982` |

Verified runtime set (`docker/laya-compat/constraints.txt`): torch 2.8.0 (CPU), transformers 5.17.0, huggingface_hub 1.32.0, safetensors 0.8.0, tokenizers 0.23.2, numpy 2.5.3. Laya's own metadata only sets lower bounds, so these pins are ours.

## Model profiles

All three checkpoints are subfolders of one hub repo at the pinned revision.

| Profile | Subfolder | Base encoder | `max_len` | `head_max_len` | Download | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `typed-decisions` (default) | `typed-decisions` | answerdotai/ModernBERT-large | 1024 | 256 | 846,195,716 B | real-model verified (Linux) |
| `english` | *(repo root)* | answerdotai/ModernBERT-large | 512 | 192 | ≈846.2 MB | metadata only |
| `multilingual` | `multilingual` | jhu-clsp/mmBERT-base | 1024 | 256 | ≈678.2 MB | metadata only |
| `auto` | — (Laya `Router`) | — | — | — | all of the above | not yet verified |

The files needed per profile are `rl_agent_config.json`, `model.safetensors`, `encoder/config.json`, and `tokenizer/{tokenizer.json,tokenizer_config.json}`. The repo root also contains Python files (`rl_agent_api.py`, `rl_common.py`, `email_utils.py`). **They must never be downloaded or executed.** Download with an explicit allow-list.

Recorded sha256 values for `typed-decisions` are in `backend/tests/fixtures/laya/typed-decisions.json` (`files`). Every file matched the hub's recorded size, and every LFS file matched the hub's sha256.

## Upstream API facts the adapter relies on

- Load: `laya.load(path_or_repo, device=None, token=None, subfolder=None)`. **There's no `revision` parameter.** If the argument isn't an existing path, Laya calls `snapshot_download` on the default branch. So the model manager downloads the pinned revision itself and always passes an existing **local directory**, and the adapter never lets Laya reach the hub.
- Loading doesn't use `trust_remote_code`. It builds the encoder with `AutoConfig.from_pretrained(<local encoder dir>)` + `AutoModel.from_config` and loads `model.safetensors` with `safetensors` (no pickle).
- `_fix_tokenizer_config` may **rewrite** `tokenizer/tokenizer_config.json` in place on load. It didn't change the typed-decisions file at this revision. Integrity checks must still tolerate that file changing, or fix it up before hashing.
- Laya **prints warnings to stdout** (device fallback). The adapter must redirect stdout while loading and predicting.
- Predict: `agent.predict(state, questions)`, where `state` is `str | dict | list` (non-strings are serialized with `json.dumps`). Question schema is `{"type", "instructions", "criteria"}`, matching the product recipe once translated.
- Exceeding the option budget raises `ValueError("question %r options exceed head_max_len=%d")`.

## Output fields per primitive

Top level: `{"model": "laya-rl-agent", "answers": {...}, "usage": {"input_tokens": int, "output_tokens": 0}}`. `input_tokens` is summed over all questions (one sequence per question).

| Primitive | Required fields | Optional / ignored |
| --- | --- | --- |
| `choice` | `type`, `choice` (key), `probabilities` (key → p), `confidence` | `action.act_probability` (ignored) |
| `score` | `type`, `score` (expected level, float), `probabilities` (`"0"`… → p), `confidence` | `legend`, `action` |
| `noul` | `type`, `noul` (P(true)), `confidence` (= max(p, 1-p)) | `action` |

## Behaviour findings

1. **`confidence` isn't top-class probability.** For `choice` and `score` it's normalized entropy, `1 - H(p)/log k`. In the probe, `department=finance` had p=0.718 but confidence 0.351. A 0.80 policy threshold on this value is much stricter than 0.80 probability. The product result shows both, and the review policy compares against Laya's `confidence`. That's the conservative choice, and the UI must explain it.
2. **Truncation is silent.** The state is cut to `max_len - len(prefix) - 1` tokens. Options are cut to 48 tokens each and then shrunk to fit `head_max_len`. Instructions are cut to what's left. Laya returns no truncation flag. A 32,000-character input came back with `input_tokens == max_len` (1024) and no warning. The adapter detects truncation by re-tokenizing with the agent's tokenizer.
3. **Temperature is per (type, option-count bucket).** For example, `choice:11+` uses T≈0.10, which sharpens distributions a lot for 11+ options. That's another reason high-cardinality results get a warning.
4. **Performance (Linux container, 12 vCPU, CPU only):** model load 4.6 s (cached weights), first decision with 3 questions 497 ms, warm decision 468 ms. That's far from upstream's GPU figures. Native Windows numbers are pending.

## Known limitations (from upstream documentation)

See `docs/model-limitations.md`. In short: weak zero-shot on some typed-decision tests for base checkpoints, over-confidence without domain calibration, finite context, degradation with large choice sets, and weaker ordinal `score`.

## License status

| Item | Declared | Status |
| --- | --- | --- |
| `laya` 0.3.4 package | Apache-2.0 | verified from package metadata and repo LICENSE |
| Checkpoints at pinned revision | `apache-2.0` (model card metadata) | **release blocker: pending independent verification** of redistribution and automatic-download terms, including base-encoder terms (ModernBERT-large, mmBERT-base) |
| torch 2.8.0 | BSD-3-Clause | recorded, full inventory pending (Task 6.2) |
| transformers 5.17.0 | Apache-2.0 | recorded, full inventory pending (Task 6.2) |
