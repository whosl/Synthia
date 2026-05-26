"""Connector SDK core types — SPEC §9B.3–9B.10."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

RiskLevel = Literal["low", "medium", "high", "critical"]
PolicyVerdict = Literal["allowed", "needs_approval", "denied"]
EdagentOutcome = Literal[
    "execution_succeeded",
    "execution_failed",
    "user_rejected",
    "policy_denied",
    "needs_approval",
]
ReportType = Literal[
    "timing_summary",
    "utilization",
    "drc",
    "methodology",
    "power",
    "simulation",
    "log_summary",
]
TargetType = Literal["local", "remote_ssh", "mock"]
ErrorSeverity = Literal["info", "warning", "error", "critical"]


@dataclass
class ToolEnvironment:
    connector_id: str
    tool_name: str
    version: str = ""
    executable_path: str = ""
    target_id: str = ""
    target_type: TargetType = "mock"
    reachable: bool = False
    license_ok: bool = True
    remote_workdir: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolCapability:
    connector_id: str
    capability_id: str
    display_name: str
    stage: str
    input_schema: dict[str, Any]
    outputs: list[str]
    risk_level: RiskLevel = "low"
    requires_approval: bool = False
    supports_stop: bool = True
    supports_mock: bool = True
    produces_reports: bool = False
    produces_patch: bool = False


@dataclass
class ToolManifest:
    project: dict[str, Any]
    tool: dict[str, Any]
    source: dict[str, Any]
    design: dict[str, Any]
    flow: dict[str, Any]
    raw: dict[str, Any] = field(default_factory=dict)
    extensions: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolRunRequest:
    request_id: str
    run_id: str
    step_id: str
    connector_id: str
    capability_id: str
    inputs: dict[str, Any]
    manifest_path: str = ""
    target_id: str = ""
    auto_approved: bool = False


@dataclass
class PolicyResult:
    verdict: PolicyVerdict
    risk_level: RiskLevel
    reasons: list[str] = field(default_factory=list)
    blocked_tokens: list[str] = field(default_factory=list)


@dataclass
class PreparedRun:
    request: ToolRunRequest
    workspace_root: str
    generated_scripts: list[str]
    command: list[str]
    env_profile: str = ""
    allowed_paths: list[str] = field(default_factory=list)
    timeout_sec: int = 3600
    policy: PolicyResult | None = None


@dataclass
class Artifact:
    artifact_id: str
    artifact_type: str
    path: str
    mime_type: str = ""
    size_bytes: int = 0
    sha256: str = ""


@dataclass
class ToolRunResult:
    request_id: str
    success: bool
    exit_code: int
    stdout_path: str = ""
    stderr_path: str = ""
    log_paths: list[str] = field(default_factory=list)
    artifacts: list[Artifact] = field(default_factory=list)
    elapsed_ms: int = 0
    target_id: str = ""
    edagent_outcome: EdagentOutcome = "execution_succeeded"
    error: str = ""


@dataclass
class ParsedReport:
    type: ReportType
    tool: str
    stage: str
    data: dict[str, Any]
    source_artifact_id: str = ""


@dataclass
class ParsedReportBundle:
    reports: list[ParsedReport] = field(default_factory=list)


@dataclass
class ToolErrorSummary:
    signature: str
    severity: ErrorSeverity
    stage: str
    message: str
    likely_causes: list[str] = field(default_factory=list)
    suggested_actions: list[str] = field(default_factory=list)
    related_artifacts: list[str] = field(default_factory=list)


@dataclass
class ValidationResult:
    ok: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class ToolConnector(Protocol):
    connector_id: str
    tool_name: str
    supported_versions: list[str]

    def detect_environment(self) -> ToolEnvironment: ...

    def list_capabilities(self) -> list[ToolCapability]: ...

    def validate_manifest(self, manifest: ToolManifest) -> ValidationResult: ...

    def prepare_run(self, request: ToolRunRequest) -> PreparedRun: ...

    def execute(self, prepared: PreparedRun) -> ToolRunResult: ...

    def collect_artifacts(self, result: ToolRunResult) -> list[Artifact]: ...

    def parse_artifacts(self, result: ToolRunResult) -> ParsedReportBundle: ...

    def classify_error(self, result: ToolRunResult) -> ToolErrorSummary | None: ...
