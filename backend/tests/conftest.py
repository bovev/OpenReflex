from __future__ import annotations

import pytest


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--real-model",
        action="store_true",
        default=False,
        help="run tests that need installed Laya and downloaded weights",
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if config.getoption("--real-model"):
        return
    skip = pytest.mark.skip(reason="needs --real-model")
    for item in items:
        if "real_model" in item.keywords:
            item.add_marker(skip)
