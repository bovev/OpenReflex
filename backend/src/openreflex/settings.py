"""Service configuration and user preferences.

``ServiceSettings`` is fixed at startup. It can't be pointed at a
non-loopback interface: V1 has no remote mode. ``Preferences`` are the
user-changeable options, stored in ``<data>/preferences.json``.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from openreflex.models.source import HUB_URL
from openreflex.paths import data_dir

LOOPBACK: Final = "127.0.0.1"
DEFAULT_PORT: Final = 47821
MAX_REQUEST_BYTES: Final = 256 * 1024
ENGINE_ENV: Final = "OPENREFLEX_ENGINE"
PREFERENCES_FILE: Final = "preferences.json"


class ServiceSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    data_dir: Path
    host: str = LOOPBACK
    port: int = Field(default=0, ge=0, le=65535, description="0 = pick a stable port")
    engine: Literal["laya", "fake"] = "laya"
    openapi: bool = False
    max_request_bytes: int = Field(default=MAX_REQUEST_BYTES, gt=0)
    queue_size: int = Field(default=4, ge=1, le=64)
    inference_timeout_s: float = Field(default=120.0, gt=0)
    download_base_url: str = HUB_URL

    @field_validator("host")
    @classmethod
    def _loopback_only(cls, value: str) -> str:
        if value != LOOPBACK:
            raise ValueError(f"the service only listens on {LOOPBACK} in this version")
        return value

    @property
    def recipes_dir(self) -> Path:
        return self.data_dir / "recipes"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def history_db(self) -> Path:
        return self.data_dir / "history.sqlite3"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"


def default_settings(**overrides: object) -> ServiceSettings:
    values: dict[str, object] = {"data_dir": data_dir()}
    engine = os.environ.get(ENGINE_ENV)
    if engine:
        values["engine"] = engine
    values.update(overrides)
    return ServiceSettings.model_validate(values)


class Preferences(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    history_enabled: bool = False


def load_preferences(root: Path) -> Preferences:
    try:
        return Preferences.model_validate_json((root / PREFERENCES_FILE).read_bytes())
    except (FileNotFoundError, ValidationError, ValueError):
        return Preferences()


def save_preferences(root: Path, prefs: Preferences) -> None:
    root.mkdir(parents=True, exist_ok=True)
    path = root / PREFERENCES_FILE
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(prefs.model_dump_json(indent=2), encoding="utf-8")
    os.replace(tmp, path)
