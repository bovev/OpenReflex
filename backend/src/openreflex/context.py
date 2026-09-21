"""Everything the service owns, wired together once at startup."""

from __future__ import annotations

import contextlib
import threading
from dataclasses import dataclass, field

from openreflex.api.worker import InferenceQueue
from openreflex.decisions import DecisionService
from openreflex.domain.engine import DecisionEngine
from openreflex.domain.errors import AppError, ErrorCode
from openreflex.domain.recipe import ModelProfile
from openreflex.engine.fake import FakeEngine
from openreflex.history.store import HistoryStore
from openreflex.models.manager import ModelManager, ModelStatus
from openreflex.models.source import ArtifactSource, HubSource
from openreflex.recipes.store import RecipeStore
from openreflex.security.tokens import load_or_create_token
from openreflex.settings import Preferences, ServiceSettings, load_preferences, save_preferences


class DownloadCoordinator:
    """Runs at most one background download per profile."""

    def __init__(self, models: ModelManager) -> None:
        self._models = models
        self._threads: dict[ModelProfile, threading.Thread] = {}
        self._cancel: dict[ModelProfile, threading.Event] = {}
        self._lock = threading.Lock()

    def start(self, profile: ModelProfile) -> ModelStatus:
        self._models.checkpoint(profile)
        with self._lock:
            running = self._threads.get(profile)
            if running is None or not running.is_alive():
                cancel = threading.Event()
                thread = threading.Thread(
                    target=self._run,
                    args=(profile, cancel),
                    name=f"download-{profile}",
                    daemon=True,
                )
                self._threads[profile], self._cancel[profile] = thread, cancel
                thread.start()
        return self._models.status(profile)

    def _run(self, profile: ModelProfile, cancel: threading.Event) -> None:
        with contextlib.suppress(AppError):  # recorded in ModelStatus.last_error
            self._models.download(profile, cancel=cancel)

    def running(self, profile: ModelProfile) -> bool:
        with self._lock:
            thread = self._threads.get(profile)
            return thread is not None and thread.is_alive()

    def wait(self, profile: ModelProfile, timeout: float | None = None) -> None:
        with self._lock:
            thread = self._threads.get(profile)
        if thread is not None:
            thread.join(timeout)

    def cancel_all(self) -> None:
        with self._lock:
            for event in self._cancel.values():
                event.set()


@dataclass
class AppContext:
    settings: ServiceSettings
    token: str
    recipes: RecipeStore
    models: ModelManager
    engine: DecisionEngine
    decisions: DecisionService
    history: HistoryStore
    queue: InferenceQueue
    downloads: DownloadCoordinator
    port: int = 0
    _prefs_lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def preferences(self) -> Preferences:
        return load_preferences(self.settings.data_dir)

    def update_preferences(self, prefs: Preferences) -> Preferences:
        with self._prefs_lock:
            save_preferences(self.settings.data_dir, prefs)
        return prefs

    def remove_model(self, profile: ModelProfile) -> ModelStatus:
        if self.downloads.running(profile):
            raise AppError(ErrorCode.MODEL_BUSY, "wait for the download to finish first")
        status = self.engine.status()
        if status.loaded_profile is profile:
            self.engine.unload()
        return self.models.remove(profile)

    def close(self) -> None:
        self.downloads.cancel_all()
        self.queue.shutdown()
        self.engine.unload()


def build_context(
    settings: ServiceSettings,
    *,
    engine: DecisionEngine | None = None,
    source: ArtifactSource | None = None,
) -> AppContext:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    recipes = RecipeStore(settings.recipes_dir)
    recipes.seed_examples()
    models = ModelManager(settings.models_dir, source or HubSource(settings.download_base_url))
    if engine is None:
        if settings.engine == "fake":
            engine = FakeEngine()
        else:
            # Imported lazily: laya/torch are only needed when a model actually runs.
            from openreflex.laya_adapter import LayaAdapter

            engine = LayaAdapter(models)
    return AppContext(
        settings=settings,
        token=load_or_create_token(settings.data_dir),
        recipes=recipes,
        models=models,
        engine=engine,
        decisions=DecisionService(recipes, engine),
        history=HistoryStore(settings.history_db),
        queue=InferenceQueue(settings.queue_size),
        downloads=DownloadCoordinator(models),
        port=settings.port,
    )
