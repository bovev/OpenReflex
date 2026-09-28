"""Where model files come from.

``HubSource`` fetches exact file paths at a pinned revision over HTTPS. It is
never given a pattern or a directory, so it can only fetch files the catalog
lists. Tests use an in-memory source, and CI never contacts the hub.
"""

from __future__ import annotations

import urllib.parse
import urllib.request
from collections.abc import Iterator
from typing import Final, Protocol

CHUNK: Final = 1 << 20
HUB_URL: Final = "https://huggingface.co"
TIMEOUT_S: Final = 60


class SourceError(Exception):
    """The file could not be fetched. Messages are safe to show."""


class ArtifactSource(Protocol):
    def fetch(self, repo_id: str, revision: str, path: str, offset: int) -> Iterator[bytes]:
        """Yield the file's bytes starting at ``offset``."""
        ...


class HubSource:
    def __init__(self, base_url: str = HUB_URL) -> None:
        if not base_url.startswith("https://"):
            raise ValueError("model downloads must use HTTPS")
        self._base = base_url.rstrip("/")

    def url(self, repo_id: str, revision: str, path: str) -> str:
        quote = urllib.parse.quote
        return f"{self._base}/{quote(repo_id)}/resolve/{quote(revision)}/{quote(path)}"

    def fetch(self, repo_id: str, revision: str, path: str, offset: int) -> Iterator[bytes]:
        url = self.url(repo_id, revision, path)  # always https (checked in __init__)
        request = urllib.request.Request(url)  # noqa: S310
        request.add_header("User-Agent", "OpenReflex-model-manager")
        if offset:
            request.add_header("Range", f"bytes={offset}-")
        try:
            response = urllib.request.urlopen(request, timeout=TIMEOUT_S)  # noqa: S310
        except OSError as exc:
            raise SourceError(f"could not download {path}: {exc.__class__.__name__}") from exc
        with response:
            if offset and response.status != 206:
                raise SourceError(f"server does not support resuming {path}")
            final_url = str(response.geturl())
            if not final_url.startswith("https://"):
                raise SourceError("download was redirected to a non-HTTPS location")
            while True:
                try:
                    chunk = response.read(CHUNK)
                except OSError as exc:
                    raise SourceError(f"download of {path} was interrupted") from exc
                if not chunk:
                    return
                yield chunk
