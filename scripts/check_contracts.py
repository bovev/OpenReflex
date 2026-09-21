"""Fail when the public JSON contracts drift from the checked-in schemas.

    uv run python scripts/check_contracts.py          # check
    uv run python scripts/check_contracts.py --write  # regenerate after an intended change

A schema change is a contract change. Bump the recipe schema or result
contract version when the change is not backwards compatible.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pydantic import BaseModel

from openreflex.domain.decision import DecisionRequest, DecisionResult
from openreflex.domain.errors import ErrorBody
from openreflex.domain.recipe import Recipe
from openreflex.domain.validation import ValidationReport

ROOT = Path(__file__).resolve().parent.parent
CONTRACTS = ROOT / "contracts"
MODELS: dict[str, type[BaseModel]] = {
    "recipe.v1.schema.json": Recipe,
    "decision-request.v1.schema.json": DecisionRequest,
    "decision-result.v1.schema.json": DecisionResult,
    "validation-report.v1.schema.json": ValidationReport,
    "error.v1.schema.json": ErrorBody,
}


def render(model: type[BaseModel]) -> str:
    mode = "validation" if model in (Recipe, DecisionRequest) else "serialization"
    schema = model.model_json_schema(mode=mode)
    return json.dumps(schema, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    drift: list[str] = []
    for name, model in MODELS.items():
        path = CONTRACTS / name
        expected = render(model)
        if args.write:
            CONTRACTS.mkdir(exist_ok=True)
            path.write_text(expected, encoding="utf-8", newline="\n")
        elif not path.exists() or path.read_text(encoding="utf-8") != expected:
            drift.append(name)
    if drift:
        print("contract drift: " + ", ".join(drift))
        print("run `uv run python scripts/check_contracts.py --write` if the change is intended")
        return 1
    print("contracts: " + ("written" if args.write else "up to date"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
