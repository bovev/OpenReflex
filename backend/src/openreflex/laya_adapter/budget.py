"""Detect what Laya would silently truncate.

Laya builds one token sequence per question:
``[CLS] <head> [SEP] ([MASK] option)* [SEP] <state> [SEP]``, capped at
``max_len``. The head and options share ``head_max_len``. Nothing in the
response reports truncation, so this compares upstream's own sequence
(``build_sequence``) against untruncated token counts.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from openreflex.domain.decision import DecisionWarning, WarningCode
from openreflex.laya_adapter._upstream import Tokenizer, Upstream


def _count(tok: Tokenizer, text: str) -> int:
    ids = tok(text.replace(tok.mask_token, " "), add_special_tokens=False)["input_ids"]
    return len(ids)


def budget_warnings(
    upstream: Upstream,
    tok: Tokenizer,
    state: Any,
    questions: Mapping[str, Mapping[str, Any]],
    max_len: int,
    head_max_len: int,
) -> list[DecisionWarning]:
    warnings: list[DecisionWarning] = []
    state_tokens = _count(tok, upstream.serialize_state(state))
    input_cut = False
    for qid, qdef in questions.items():
        q = upstream.to_internal(qdef)
        _, markers = upstream.build_sequence(tok, state, q, max_len, head_max_len)
        empty_ids, _ = upstream.build_sequence(tok, "", q, max_len, head_max_len)
        prefix = len(empty_ids) - 1  # everything before the state, minus the final [SEP]
        room = max(0, max_len - prefix - 1)
        if state_tokens > room:
            input_cut = True

        options = upstream.render_options(q)
        if len(markers) < len(options):
            # Upstream refuses to predict in this case; the adapter reports it as an error.
            continue
        # The last option ends at the [SEP] that precedes the (empty) state.
        seg_ends = [*markers[1:], len(empty_ids) - 2]
        full = [1 + _count(tok, " " + opt) for opt in options]
        actual = [end - start for start, end in zip(markers, seg_ends, strict=True)]
        if any(a < f for a, f in zip(actual, full, strict=True)):
            warnings.append(
                DecisionWarning(
                    code=WarningCode.OPTIONS_TRUNCATED,
                    question_id=qid,
                    message="Some option descriptions were shortened to fit the model's "
                    "option budget; shorter descriptions or fewer options will help.",
                )
            )
        head_actual = markers[0] - 2 if markers else 0
        # Mirrors upstream's head text; pinned by the real-model compatibility tests.
        head_full = _count(tok, f"{q['t']} question: {q['ins']}")
        if head_actual < head_full:
            warnings.append(
                DecisionWarning(
                    code=WarningCode.INSTRUCTIONS_TRUNCATED,
                    question_id=qid,
                    message="The instructions were shortened to fit the model's budget.",
                )
            )
    if input_cut:
        warnings.insert(
            0,
            DecisionWarning(
                code=WarningCode.INPUT_TRUNCATED,
                message="The input is longer than the model can read; only the first part "
                "was used.",
            ),
        )
    return warnings
