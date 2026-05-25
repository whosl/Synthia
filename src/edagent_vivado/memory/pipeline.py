"""Memory pipeline — N-turn / warmup / idle triggers for L1 extraction."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any

from edagent_vivado.memory.atoms import extract_atoms_from_session
from edagent_vivado.repository.project_scope import project_id_for_session
from edagent_vivado.repository.db import get_db
from edagent_vivado.repository.store import settings_get, settings_set


def _pipeline_key(session_id: str) -> str:
    return f"memory_pipeline:{session_id}"


@dataclass
class MemoryPipelineConfig:
    every_n_conversations: int = 5
    enable_warmup: bool = True
    l1_idle_timeout_seconds: int = 600
    max_atoms_per_pass: int = 20


@dataclass
class MemoryPipeline:
    config: MemoryPipelineConfig = field(default_factory=MemoryPipelineConfig)

    @classmethod
    def from_env(cls) -> MemoryPipeline:
        cfg = MemoryPipelineConfig(
            every_n_conversations=int(os.environ.get("EDAGENT_MEMORY_EVERY_N", "5")),
            enable_warmup=os.environ.get("EDAGENT_MEMORY_WARMUP", "1").lower() not in ("0", "false", "no"),
            l1_idle_timeout_seconds=int(os.environ.get("EDAGENT_MEMORY_IDLE_SEC", "600")),
            max_atoms_per_pass=int(os.environ.get("EDAGENT_MEMORY_MAX_ATOMS", "20")),
        )
        return cls(config=cfg)

    def _load_state(self, session_id: str) -> dict[str, Any]:
        state = settings_get(_pipeline_key(session_id), default=None)
        if not isinstance(state, dict):
            state = {
                "messages_since_extract": 0,
                "warmup_index": 0,
                "warmup_targets": self._warmup_targets(),
                "last_message_at": 0,
                "last_extract_at": 0,
                "total_messages": 0,
            }
        return state

    def _save_state(self, session_id: str, state: dict[str, Any]) -> None:
        settings_set(_pipeline_key(session_id), state)

    def _warmup_targets(self) -> list[int]:
        n = max(1, self.config.every_n_conversations)
        targets: list[int] = []
        v = 1
        while v < n:
            targets.append(v)
            v *= 2
        targets.append(n)
        return targets

    def _should_extract(self, state: dict[str, Any], now: int) -> tuple[bool, str]:
        count = int(state.get("messages_since_extract") or 0)

        if self.config.enable_warmup:
            targets = state.get("warmup_targets") or self._warmup_targets()
            idx = int(state.get("warmup_index") or 0)
            if idx < len(targets) and count >= int(targets[idx]):
                return True, "warmup"

        if count >= self.config.every_n_conversations:
            return True, "every_n"

        return False, ""

    def on_message(
        self,
        session_id: str,
        project_id: str | None = None,
        *,
        role: str = "user",
    ) -> dict[str, Any]:
        """Called after each persisted message. May trigger L1 extraction."""
        if not session_id:
            return {"triggered": False, "reason": "no_session"}

        now = int(time.time())
        state = self._load_state(session_id)
        prev_last_msg = int(state.get("last_message_at") or 0)
        last_extract = int(state.get("last_extract_at") or 0)

        idle_gap = (
            prev_last_msg > 0
            and now - prev_last_msg >= self.config.l1_idle_timeout_seconds
            and last_extract < prev_last_msg
        )

        state["total_messages"] = int(state.get("total_messages") or 0) + 1
        state["messages_since_extract"] = int(state.get("messages_since_extract") or 0) + 1
        state["last_message_at"] = now

        should, reason = self._should_extract(state, now)
        if not should and idle_gap:
            should, reason = True, "idle"

        if not should:
            self._save_state(session_id, state)
            return {
                "triggered": False,
                "reason": "",
                "messages_since_extract": state["messages_since_extract"],
                "role": role,
            }

        pid = project_id or project_id_for_session(get_db(), session_id) or ""
        since = int(state.get("last_extract_at") or 0)
        created = extract_atoms_from_session(
            session_id,
            pid,
            since_created_at=since if since else None,
            max_atoms=self.config.max_atoms_per_pass,
        )

        scenarios_created = 0
        persona_built = False
        if pid:
            from edagent_vivado.memory.scenarios import aggregate_scenarios
            from edagent_vivado.memory.personas import build_project_persona, rebuild_persona_if_dirty

            scen = aggregate_scenarios(pid)
            scenarios_created = len(scen)
            persona_row = build_project_persona(pid)
            dirty_row = rebuild_persona_if_dirty(pid)
            persona_built = dirty_row is not None or persona_row is not None

        state["messages_since_extract"] = 0
        state["last_extract_at"] = now
        if self.config.enable_warmup and reason == "warmup":
            state["warmup_index"] = int(state.get("warmup_index") or 0) + 1
        self._save_state(session_id, state)

        return {
            "triggered": True,
            "reason": reason,
            "atoms_created": len(created),
            "scenarios_updated": scenarios_created,
            "persona_built": persona_built,
            "project_id": pid,
            "role": role,
        }


_default_pipeline: MemoryPipeline | None = None


def get_memory_pipeline() -> MemoryPipeline:
    global _default_pipeline
    if _default_pipeline is None:
        _default_pipeline = MemoryPipeline.from_env()
    return _default_pipeline


def on_message(session_id: str, project_id: str | None = None, *, role: str = "user") -> dict[str, Any]:
    return get_memory_pipeline().on_message(session_id, project_id, role=role)
