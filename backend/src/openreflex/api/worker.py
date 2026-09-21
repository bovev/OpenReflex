"""Single inference worker with a bounded queue.

One thread runs every model call, so only one copy of the model is ever
active. When ``capacity`` calls are already queued or running, new ones fail
straight away with ``QUEUE_FULL`` (HTTP 429). A caller whose call times out
gets ``TIMEOUT``, but a running model call can't be interrupted: it still
finishes and keeps its queue slot until then.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import TypeVar

from openreflex.domain.errors import AppError, ErrorCode

T = TypeVar("T")


class InferenceQueue:
    def __init__(self, capacity: int) -> None:
        self._capacity = capacity
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="openreflex-infer")
        self._pending = 0
        self._lock = threading.Lock()

    @property
    def depth(self) -> int:
        with self._lock:
            return self._pending

    @property
    def capacity(self) -> int:
        return self._capacity

    def _release(self, _: Future[object]) -> None:
        with self._lock:
            self._pending -= 1

    async def run(self, fn: Callable[[], T], timeout_s: float) -> T:
        with self._lock:
            if self._pending >= self._capacity:
                raise AppError(ErrorCode.QUEUE_FULL, "the decision queue is full; retry shortly")
            self._pending += 1
        try:
            future: Future[T] = self._executor.submit(fn)
        except BaseException:
            with self._lock:
                self._pending -= 1
            raise
        future.add_done_callback(self._release)  # type: ignore[arg-type]
        try:
            return await asyncio.wait_for(asyncio.wrap_future(future), timeout_s)
        except TimeoutError as exc:
            raise AppError(ErrorCode.TIMEOUT, "the decision took too long") from exc

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
