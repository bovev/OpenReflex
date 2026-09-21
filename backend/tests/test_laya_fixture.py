"""Guards the captured real-model fixture against accidental edits.

The adapter contract tests (Task 2.2) replay this fixture; these checks make
sure it still has the upstream fields documented in
docs/architecture/laya-compatibility.md and no machine-specific data.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FIXTURE = Path(__file__).parent / "fixtures" / "laya" / "typed-decisions.json"
REQUIRED = {
    "choice": {"type", "choice", "probabilities", "confidence"},
    "score": {"type", "score", "probabilities", "confidence"},
    "noul": {"type", "noul", "confidence"},
}


def _load() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_fixture_is_pinned() -> None:
    data = _load()
    assert data["laya_version"] == "0.3.4"
    assert len(data["revision"]) == 40
    assert data["profile"] == "typed-decisions"


def test_fixture_covers_every_primitive_with_required_fields() -> None:
    answers = _load()["response"]["answers"]
    seen = {a["type"] for a in answers.values()}
    assert seen == set(REQUIRED)
    for answer in answers.values():
        assert REQUIRED[answer["type"]] <= set(answer)


def test_fixture_contains_no_machine_specific_paths() -> None:
    text = FIXTURE.read_text(encoding="utf-8")
    for marker in ("/hf-cache", "/root", "C:\\\\", "\\Users", "timing"):
        assert marker not in text
