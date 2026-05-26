"""Base connector mixin — optional helpers for concrete connectors."""

from __future__ import annotations

from abc import ABC, abstractmethod

from edagent_vivado.connectors.base.types import (
    Artifact,
    ParsedReportBundle,
    PreparedRun,
    ToolCapability,
    ToolConnector,
    ToolEnvironment,
    ToolErrorSummary,
    ToolManifest,
    ToolRunRequest,
    ToolRunResult,
    ValidationResult,
)


class BaseConnector(ABC):
    """Abstract base implementing ToolConnector with sensible defaults."""

    connector_id: str
    tool_name: str
    supported_versions: list[str]

    @abstractmethod
    def detect_environment(self) -> ToolEnvironment: ...

    @abstractmethod
    def list_capabilities(self) -> list[ToolCapability]: ...

    def validate_manifest(self, manifest: ToolManifest) -> ValidationResult:
        if not manifest.design.get("top"):
            return ValidationResult(ok=False, errors=["missing design.top"])
        return ValidationResult(ok=True)

    @abstractmethod
    def prepare_run(self, request: ToolRunRequest) -> PreparedRun: ...

    @abstractmethod
    def execute(self, prepared: PreparedRun) -> ToolRunResult: ...

    def collect_artifacts(self, result: ToolRunResult) -> list[Artifact]:
        return list(result.artifacts)

    def parse_artifacts(self, result: ToolRunResult) -> ParsedReportBundle:
        return ParsedReportBundle()

    def classify_error(self, result: ToolRunResult) -> ToolErrorSummary | None:
        if result.success:
            return None
        return ToolErrorSummary(
            signature=result.error[:120] if result.error else "execution_failed",
            severity="error",
            stage="unknown",
            message=result.error or "execution failed",
        )


# Runtime check: BaseConnector satisfies ToolConnector protocol
def _assert_protocol(obj: ToolConnector) -> ToolConnector:
    return obj
