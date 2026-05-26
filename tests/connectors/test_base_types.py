"""Phase 6A — connector SDK types and registry."""

from __future__ import annotations

import pytest

from edagent_vivado.connectors.base import (
    PolicyResult,
    ToolCapability,
    ToolEnvironment,
    ToolManifest,
    ToolRunRequest,
    ValidationResult,
    clear_registry,
    find_capability,
    get_connector,
    list_connectors,
    new_run_request,
    register_connector,
)
from edagent_vivado.connectors.base.connector import BaseConnector
from edagent_vivado.connectors.base.types import (
    PreparedRun,
    ToolRunResult,
)


class _StubConnector(BaseConnector):
    connector_id = "stub"
    tool_name = "stub_tool"
    supported_versions = ["1.0"]

    def detect_environment(self) -> ToolEnvironment:
        return ToolEnvironment(
            connector_id=self.connector_id,
            tool_name=self.tool_name,
            reachable=True,
            target_type="mock",
        )

    def list_capabilities(self) -> list[ToolCapability]:
        return [
            ToolCapability(
                connector_id=self.connector_id,
                capability_id="echo",
                display_name="Echo",
                stage="test",
                input_schema={"msg": "string"},
                outputs=["echo_out"],
            ),
        ]

    def prepare_run(self, request: ToolRunRequest) -> PreparedRun:
        return PreparedRun(
            request=request,
            workspace_root="/tmp/ws",
            generated_scripts=[],
            command=["echo", "hi"],
        )

    def execute(self, prepared: PreparedRun) -> ToolRunResult:
        return ToolRunResult(
            request_id=prepared.request.request_id,
            success=True,
            exit_code=0,
        )


@pytest.fixture(autouse=True)
def _clean_registry():
    clear_registry()
    yield
    clear_registry()


def test_register_and_find_capability():
    register_connector(_StubConnector())
    assert len(list_connectors()) == 1
    cap = find_capability("stub", "echo")
    assert cap is not None
    assert cap.display_name == "Echo"


def test_duplicate_connector_raises():
    register_connector(_StubConnector())
    with pytest.raises(ValueError, match="duplicate"):
        register_connector(_StubConnector())


def test_new_run_request_fields():
    req = new_run_request(
        run_id="run1",
        step_id="step1",
        connector_id="stub",
        capability_id="echo",
        inputs={"msg": "hello"},
    )
    assert req.run_id == "run1"
    assert req.inputs["msg"] == "hello"
    assert len(req.request_id) == 12


def test_manifest_validate_missing_top():
    conn = _StubConnector()
    result = conn.validate_manifest(
        ToolManifest(
            project={}, tool={}, source={}, design={}, flow={},
        )
    )
    assert result.ok is False
    assert "top" in result.errors[0]


def test_policy_result_defaults():
    p = PolicyResult(verdict="allowed", risk_level="low")
    assert p.reasons == []
    assert p.blocked_tokens == []


def test_classify_error_on_failure():
    conn = _StubConnector()
    err = conn.classify_error(
        ToolRunResult(request_id="r1", success=False, exit_code=1, error="boom")
    )
    assert err is not None
    assert err.severity == "error"
    assert "boom" in err.message


def test_get_connector_missing():
    assert get_connector("nonexistent") is None
