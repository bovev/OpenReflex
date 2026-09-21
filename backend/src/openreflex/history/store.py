"""Opt-in local decision history (SQLite).

Stored per decision: request id, time, recipe id, overall review, the model
that ran, each question's answer (chosen option / level / true-false),
confidence, and review, plus warning codes. **The decision input is never
stored**, and neither are recipe texts or raw probabilities.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import json
import sqlite3
import threading
from collections.abc import Generator
from pathlib import Path
from typing import Any, Final

from pydantic import BaseModel, ConfigDict

from openreflex.domain.decision import ChoiceAnswer, DecisionResult, ScoreAnswer

MAX_LIMIT: Final = 500
_SCHEMA: Final = """
CREATE TABLE IF NOT EXISTS decisions (
    request_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    recipe_id TEXT NOT NULL,
    review TEXT NOT NULL,
    checkpoint TEXT NOT NULL,
    revision TEXT NOT NULL,
    answers TEXT NOT NULL,
    warnings TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_created ON decisions(created_at);
"""

WHAT_IS_STORED: Final = (
    "time, recipe id, overall review status, model name and revision, each question's "
    "answer with its confidence and review status, and warning codes. The text or JSON "
    "you submit is never stored."
)


class HistoryEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    request_id: str
    created_at: str
    recipe_id: str
    review: str
    checkpoint: str
    revision: str
    answers: dict[str, dict[str, Any]]
    warnings: list[str]


def _answer_summary(result: DecisionResult) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for qid, a in result.answers.items():
        if isinstance(a, ChoiceAnswer):
            value: object = a.choice
        elif isinstance(a, ScoreAnswer):
            value = a.label
        else:
            value = a.value
        out[qid] = {
            "type": a.type,
            "answer": value,
            "confidence": a.confidence,
            "review": a.review.value,
        }
    return out


class HistoryStore:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()

    @contextlib.contextmanager
    def _db(self) -> Generator[sqlite3.Connection]:
        # sqlite3's own context manager commits but does not close; an open
        # handle keeps the file locked on Windows (and blocks "clear history").
        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self._path, timeout=5)
        try:
            conn.executescript(_SCHEMA)
            yield conn
            conn.commit()
        finally:
            conn.close()

    def record(self, result: DecisionResult) -> None:
        row = (
            result.request_id,
            dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            result.recipe_id,
            result.review.value,
            result.model.checkpoint,
            result.model.revision,
            json.dumps(_answer_summary(result)),
            json.dumps(sorted({w.code.value for w in result.warnings})),
        )
        with self._lock, self._db() as conn:
            conn.execute("INSERT OR REPLACE INTO decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)", row)

    def list(self, limit: int = 100) -> list[HistoryEntry]:
        limit = max(1, min(limit, MAX_LIMIT))
        if not self._path.exists():
            return []
        with self._lock, self._db() as conn:
            rows = conn.execute(
                "SELECT request_id, created_at, recipe_id, review, checkpoint, revision, "
                "answers, warnings FROM decisions ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            HistoryEntry(
                request_id=r[0],
                created_at=r[1],
                recipe_id=r[2],
                review=r[3],
                checkpoint=r[4],
                revision=r[5],
                answers=json.loads(r[6]),
                warnings=json.loads(r[7]),
            )
            for r in rows
        ]

    def clear(self) -> None:
        with self._lock:
            for suffix in ("", "-journal", "-wal", "-shm"):
                Path(str(self._path) + suffix).unlink(missing_ok=True)
