"""Command-line entry point for the OpenReflex service executable."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from collections.abc import Sequence
from typing import Any

from openreflex import __version__
from openreflex.decisions import DecisionService
from openreflex.engine.fake import FakeEngine
from openreflex.identity import PRODUCT_NAME, SERVICE_EXECUTABLE
from openreflex.paths import data_dir, install_dir
from openreflex.recipes.store import RecipeStore


def smoke() -> dict[str, Any]:
    """Self-check used by packaging tests. Uses the fake engine, never a real model."""
    target = data_dir()
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target, prefix=".smoke-", delete=True) as probe:
        probe.write(b"ok")
        probe.flush()
    store = RecipeStore(target / "recipes")
    seeded = store.seed_examples()
    result = DecisionService(store, FakeEngine()).run(
        "email-triage", "We were charged twice for invoice 4471. Please refund."
    )
    return {
        "product": PRODUCT_NAME,
        "version": __version__,
        "frozen": bool(getattr(sys, "frozen", False)),
        "install_dir": str(install_dir()),
        "data_dir": str(target),
        "data_dir_writable": True,
        "examples_seeded": sorted(seeded),
        "decision": {
            "engine": "fake",
            "status": result.status.value,
            "questions": sorted(result.answers),
        },
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog=SERVICE_EXECUTABLE)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("version", help="print the version")
    sub.add_parser("smoke", help="run a packaging self-check with the fake engine")
    args = parser.parse_args(argv)

    if args.command == "version":
        print(__version__)
        return 0
    print(json.dumps(smoke(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
