# Third-party notices

OpenReflex is licensed under Apache-2.0 (see `LICENSE`). It depends on the third-party components below. Binary distributions must include each component's license text and any NOTICE content it requires.

This file is an engineering record, not legal advice. Every entry marked `pending` is a release blocker until it has been checked.

## Laya

- Project: Laya — an open-source System 1 decision model
- Author: Convai Innovations
- Source: <https://github.com/NandhaKishorM/laya>
- Package: `laya` on PyPI, pinned version: see `docs/architecture/laya-compatibility.md`
- License: Apache-2.0 (package metadata and repository `LICENSE`)
- Relationship: runtime dependency, used only through `openreflex.laya_adapter`. No Laya source is copied into this repository.

## Laya model checkpoints

- Source: <https://huggingface.co/convaiinnovations/laya>
- Declared license: `apache-2.0` (Hugging Face model card metadata)
- Redistribution / automatic-download terms: **pending independent verification** (release blocker)

## Other dependencies

The full inventory of Python, JavaScript, installer, and native binary dependencies is produced during release hardening (Task 6.2). Status: **pending**.
