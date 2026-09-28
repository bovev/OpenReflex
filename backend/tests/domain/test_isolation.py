"""Domain modules must stay free of Laya, FastAPI, and I/O frameworks."""

from __future__ import annotations

import ast
from pathlib import Path

import openreflex.domain

DOMAIN = Path(openreflex.domain.__file__).parent
FORBIDDEN = {"laya", "torch", "transformers", "fastapi", "starlette", "uvicorn", "mcp", "yaml"}


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module.split(".")[0])
    return names


def test_domain_imports_no_frameworks() -> None:
    files = sorted(DOMAIN.glob("*.py"))
    assert files
    for path in files:
        assert not (_imports(path) & FORBIDDEN), path.name


def test_only_the_adapter_imports_laya() -> None:
    package = DOMAIN.parent
    offenders = [
        p.relative_to(package).as_posix()
        for p in package.rglob("*.py")
        if "laya" in _imports(p) and "laya_adapter" not in p.parts
    ]
    assert offenders == []
