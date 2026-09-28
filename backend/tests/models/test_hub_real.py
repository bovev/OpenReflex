"""Opt-in check of HubSource + verification against the real hub (small files only).

Needs network; runs with ``--real-model`` (inside the compatibility container).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from openreflex.domain.recipe import ModelProfile
from openreflex.models.catalog import CATALOG
from openreflex.models.manager import ModelManager, ModelState
from openreflex.models.source import HubSource

pytestmark = pytest.mark.real_model


@pytest.mark.parametrize("profile", list(CATALOG))
def test_pinned_small_files_download_and_verify(tmp_path: Path, profile: ModelProfile) -> None:
    full = CATALOG[profile]
    small = full.model_copy(update={"files": tuple(f for f in full.files if f.size < 50_000)})
    manager = ModelManager(tmp_path / "models", HubSource(), {profile: small})
    status = manager.download(profile)
    assert status.state is ModelState.INSTALLED
    assert manager.verify(profile).state is ModelState.INSTALLED
