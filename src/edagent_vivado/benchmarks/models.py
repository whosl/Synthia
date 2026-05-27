"""Benchmark suite/case data models — Phase 10."""

from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class SuiteState(str, Enum):
    DRAFT = "draft"
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    PARTIAL = "partial"
    CANCELLED = "cancelled"


class CaseState(str, Enum):
    PENDING = "pending"
    QUEUED = "queued"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"
    CANCELLED = "cancelled"


@dataclass
class BenchmarkCase:
    id: str
    suite_id: str
    name: str
    description: str
    sequence: int
    flow_name: str
    inputs: dict[str, Any]
    expected: dict[str, Any] = field(default_factory=dict)
    state: str = CaseState.PENDING.value
    run_id: str = ""
    metrics: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    error_category: str = ""
    elapsed_ms: int = 0
    started_at: int | None = None
    completed_at: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SuiteConfig:
    continue_on_failure: bool = True
    parallel: int = 1
    timeout_per_case_s: int = 7200
    abort_on_n_failures: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class BenchmarkSuite:
    id: str
    name: str
    description: str
    project_id: str
    created_by: str = ""
    state: str = SuiteState.DRAFT.value
    total_cases: int = 0
    completed_cases: int = 0
    failed_cases: int = 0
    cancelled_cases: int = 0
    config: SuiteConfig = field(default_factory=SuiteConfig)
    cases: list[BenchmarkCase] = field(default_factory=list)
    created_at: int = 0
    started_at: int | None = None
    completed_at: int | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["config"] = self.config.to_dict() if isinstance(self.config, SuiteConfig) else self.config
        d["cases"] = [c.to_dict() if isinstance(c, BenchmarkCase) else c for c in self.cases]
        return d

    @classmethod
    def new(
        cls,
        *,
        name: str,
        project_id: str,
        description: str = "",
        config: SuiteConfig | None = None,
        created_by: str = "",
    ) -> BenchmarkSuite:
        return cls(
            id=str(uuid.uuid4()),
            name=name,
            description=description,
            project_id=project_id,
            created_by=created_by,
            config=config or SuiteConfig(),
            created_at=int(time.time() * 1000),
        )


def make_case(
    *,
    suite_id: str,
    name: str,
    sequence: int,
    flow_name: str,
    inputs: dict[str, Any],
    description: str = "",
    expected: dict[str, Any] | None = None,
) -> BenchmarkCase:
    return BenchmarkCase(
        id=str(uuid.uuid4()),
        suite_id=suite_id,
        name=name,
        description=description,
        sequence=sequence,
        flow_name=flow_name,
        inputs=inputs,
        expected=expected or {},
    )
