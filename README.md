# OpenReflex

Run a fast "System 1" decision model on your own computer and use it from the tools you already work in.

OpenReflex is a Windows desktop app. It installs and runs a local decision model, lets you define reusable **decision recipes** (for example "which department should handle this email, and is it urgent?"), lets you try them in a small local web UI, and exposes them to MCP-capable AI tools such as Claude Code, OpenCode, and VS Code / GitHub Copilot.

> **Status:** early development. Nothing here is ready for production use yet.

Powered by [Laya](https://github.com/NandhaKishorM/laya), an open-source System 1 decision model developed by Convai Innovations.

OpenReflex is an independent project. It is not a fork of Laya, does not contain Laya's source code, and is not affiliated with or endorsed by Convai Innovations. Laya is used as an ordinary, version-pinned Python dependency.

## What runs where

- Laya inference and your recipes stay on your computer. No hosted inference API is needed.
- After the model has been downloaded, OpenReflex works offline.
- If you call OpenReflex from a cloud AI tool (Claude, Copilot, …), that tool sees what you send it and may process it under its own terms. The workflow as a whole is only as local as the tool you use.

## Model limitations

Laya is fast, but it's a specialized model with real limits. Among them: confidence can be over-confident without domain calibration, long inputs get truncated, large choice sets lose accuracy, and ordinal `score` questions are weaker than `choice` and `noul`. OpenReflex shows these as warnings and `needs_review` results. It never treats raw confidence as proof of correctness. See [docs/model-limitations.md](docs/model-limitations.md).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
