"""Typed view of the pinned Laya API. The sole ``import laya`` lives here."""

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Final, Protocol

SUPPORTED_VERSION: Final = "0.3.4"


class Tokenizer(Protocol):
    mask_token: str

    def __call__(self, text: str, *, add_special_tokens: bool = ...) -> Mapping[str, Any]: ...


class Agent(Protocol):
    tok: Tokenizer
    cfg: Mapping[str, Any]
    device: Any

    def predict(self, state: Any, questions: Mapping[str, Any]) -> Mapping[str, Any]: ...


class Upstream(Protocol):
    """The subset of Laya the adapter uses, so tests can substitute it."""

    version: str

    def load(self, path: str, device: str) -> Agent: ...

    def route(self, state: Any, questions: Mapping[str, Any]) -> str: ...

    def build_sequence(
        self, tok: Tokenizer, state: Any, q: Mapping[str, Any], max_len: int, head_max_len: int
    ) -> tuple[list[int], list[int]]: ...

    def render_options(self, q: Mapping[str, Any]) -> list[str]: ...

    def serialize_state(self, state: Any) -> str: ...

    def to_internal(self, question: Mapping[str, Any]) -> Mapping[str, Any]: ...


class _Laya:
    def __init__(self) -> None:
        import laya
        import laya.common

        self._laya: Any = laya
        self._common: Any = laya.common
        self.version: str = str(laya.__version__)
        self._router: Any = laya.Router()  # routing only; never loads a model

    def load(self, path: str, device: str) -> Agent:
        return self._laya.load(path, device=device)

    def route(self, state: Any, questions: Mapping[str, Any]) -> str:
        return str(self._router.route(state, dict(questions))["model"])

    def build_sequence(
        self, tok: Tokenizer, state: Any, q: Mapping[str, Any], max_len: int, head_max_len: int
    ) -> tuple[list[int], list[int]]:
        ids, markers = self._common.build_sequence(tok, state, dict(q), max_len, head_max_len)
        return list(ids), list(markers)

    def render_options(self, q: Mapping[str, Any]) -> list[str]:
        return list(self._common.render_options(dict(q)))

    def serialize_state(self, state: Any) -> str:
        return str(self._common.serialize_state(state))

    def to_internal(self, question: Mapping[str, Any]) -> Mapping[str, Any]:
        # Private upstream helper; pinned by the compatibility tests.
        return dict(self._laya.Agent._to_internal(dict(question)))


def import_upstream() -> Upstream:
    return _Laya()


UpstreamFactory = Callable[[], Upstream]
