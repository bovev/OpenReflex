"""Real-model Laya compatibility probe (Task 0.2).

Runs inside the Linux compatibility container (see ``run.py``), never in CI
and never in ordinary tests. It:

1. downloads one checkpoint subfolder at a pinned, immutable revision;
2. checks every downloaded file against the hub's recorded size / sha256;
3. loads it with ``laya.load`` from the local directory (no hub access at load);
4. runs one example of each primitive and a deliberately over-long input;
5. writes a normalized fixture with no machine-specific data.

Timings and environment details go to stdout only, for the compatibility doc.
Excluded from pyright: laya/torch are only installed inside the container.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
import time
from pathlib import Path
from typing import Any

REPO_ID = "convaiinnovations/laya"
REVISION = "1c5edc17a7acd8701df6fc341c0d179f1c62c982"
PROFILES: dict[str, str | None] = {
    "english": None,
    "multilingual": "multilingual",
    "typed-decisions": "typed-decisions",
}
MODEL_FILES = ("rl_agent_config.json", "model.safetensors", "encoder/", "tokenizer/")

QUESTIONS: dict[str, dict[str, Any]] = {
    "department": {
        "type": "choice",
        "instructions": "Which department should handle this request?",
        "criteria": {
            "sales": "Pricing, proposals, and new contracts",
            "finance": "Invoices, payments, and refunds",
            "support": "Product problems and technical help",
            "other": "Anything that does not fit the other categories",
        },
    },
    "priority": {
        "type": "score",
        "instructions": "How important is this request?",
        "criteria": ["low", "normal", "high", "critical"],
    },
    "urgent": {"type": "noul", "instructions": "Does this require urgent human attention?"},
}
STATE = {
    "text": "Hi, we were charged twice for invoice 4471 this month. "
    "Please refund the duplicate payment before Friday's close."
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(profile: str) -> tuple[Path, list[dict[str, Any]]]:
    from huggingface_hub import HfApi, snapshot_download

    sub = PROFILES[profile]
    prefix = f"{sub}/" if sub else ""

    info = HfApi().model_info(REPO_ID, revision=REVISION, files_metadata=True)
    expected: dict[str, dict[str, Any]] = {}
    for s in info.siblings or []:
        name = s.rfilename
        rel = name[len(prefix) :] if prefix and name.startswith(prefix) else name
        if prefix and not name.startswith(prefix):
            continue
        if not prefix and "/" in name and not name.startswith(("encoder/", "tokenizer/")):
            continue
        if any(rel == m or (m.endswith("/") and rel.startswith(m)) for m in MODEL_FILES):
            expected[name] = {"size": s.size, "sha256": s.lfs.sha256 if s.lfs else None}

    root = Path(
        snapshot_download(
            REPO_ID,
            revision=REVISION,
            allow_patterns=list(expected),
        )
    )
    records: list[dict[str, Any]] = []
    for name, meta in sorted(expected.items()):
        path = root / name
        actual_size = path.stat().st_size
        actual_sha = sha256(path)
        if actual_size != meta["size"]:
            raise SystemExit(f"size mismatch for {name}: {actual_size} != {meta['size']}")
        if meta["sha256"] and actual_sha != meta["sha256"]:
            raise SystemExit(f"sha256 mismatch for {name}")
        records.append(
            {"path": name, "size": actual_size, "sha256": actual_sha, "lfs": bool(meta["sha256"])}
        )
    model_dir = root / sub if sub else root
    return model_dir, records


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=sorted(PROFILES), default="typed-decisions")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    import laya
    import torch
    import transformers

    model_dir, files = download(args.profile)
    before = {f["path"]: f["sha256"] for f in files}

    cfg = json.loads((model_dir / "rl_agent_config.json").read_text())
    t0 = time.perf_counter()
    agent = laya.load(str(model_dir), device="cpu")
    load_s = time.perf_counter() - t0

    mutated = []
    root = model_dir.parent if PROFILES[args.profile] else model_dir
    for rel, digest in before.items():
        if sha256(root / rel) != digest:
            mutated.append(rel)

    t0 = time.perf_counter()
    result = agent.predict(STATE, QUESTIONS)
    first_ms = (time.perf_counter() - t0) * 1000
    t0 = time.perf_counter()
    agent.predict(STATE, QUESTIONS)
    warm_ms = (time.perf_counter() - t0) * 1000

    long_state = {"text": "Refund request. " * 2000}
    long_result = agent.predict(long_state, {"urgent": QUESTIONS["urgent"]})

    fixture = {
        "laya_version": laya.__version__,
        "repo_id": REPO_ID,
        "revision": REVISION,
        "profile": args.profile,
        "subfolder": PROFILES[args.profile],
        "config": {
            k: cfg.get(k)
            for k in ("max_len", "head_max_len", "encoder", "temperature", "temperature_by_options")
        },
        "files": files,
        "files_mutated_by_load": mutated,
        "request": {"state": STATE, "questions": QUESTIONS},
        "response": result,
        "long_input": {"chars": len(long_state["text"]), "response": long_result},
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(fixture, indent=2, sort_keys=True) + "\n")

    print(
        json.dumps(
            {
                "python": sys.version.split()[0],
                "platform": platform.platform(),
                "cpu_count": os.cpu_count(),
                "torch": torch.__version__,
                "transformers": transformers.__version__,
                "model_load_s": round(load_s, 2),
                "first_decision_ms": round(first_ms, 1),
                "warm_decision_ms": round(warm_ms, 1),
                "download_bytes": sum(f["size"] for f in files),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
