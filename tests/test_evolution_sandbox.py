"""SE-PR8 unit tests: AST whitelist + sandbox loader + tool overlay path."""

from __future__ import annotations

import textwrap
import uuid

import pytest

from edagent_vivado.evolution import (
    SandboxError,
    approve_candidate,
    candidate_create,
    candidate_get,
    clear_sandbox_cache,
    load_evolved_tool,
    overlay_create,
    resolve_tools,
    validate_evolved_tool_source,
)
from edagent_vivado.repository.db import get_db, init_db
from edagent_vivado.repository.store import project_create, session_create


SAFE_TOOL = textwrap.dedent("""
    from langchain_core.tools import tool

    @tool
    def summarise_text(text: str) -> str:
        \"\"\"Return a short cleaned-up summary.\"\"\"
        cleaned = " ".join(text.split())
        return cleaned[:200]
""").strip()


def _make_project() -> dict:
    init_db()
    return project_create(
        {
            "name": f"se-pr8-{uuid.uuid4().hex[:6]}",
            "status": "active",
            "root_path": ".",
            "manifest_path": "eda.yaml",
            "xpr_path": "",
            "part": "xc7a35t",
        }
    )


# ── AST whitelist + validator ────────────────────────────


def test_validate_accepts_clean_tool():
    out = validate_evolved_tool_source(SAFE_TOOL)
    assert out["ok"] is True
    assert out["tool_name"] == "summarise_text"
    assert "hash" in out
    assert out["source_bytes"] == len(SAFE_TOOL)


def test_validate_rejects_empty():
    with pytest.raises(SandboxError) as e:
        validate_evolved_tool_source("")
    assert e.value.reason == "empty_source"


def test_validate_rejects_syntax_error():
    with pytest.raises(SandboxError) as e:
        validate_evolved_tool_source("def broken( :")
    assert e.value.reason == "syntax_error"


@pytest.mark.parametrize("bad", [
    "from langchain_core.tools import tool\nimport os\n@tool\ndef t(x: str)->str:\n    return x\n",
    "from langchain_core.tools import tool\nimport subprocess\n@tool\ndef t(x: str)->str:\n    return x\n",
    "from langchain_core.tools import tool\n@tool\ndef t(x: str)->str:\n    return exec(x)\n",
    "from langchain_core.tools import tool\n@tool\ndef t(x: str)->str:\n    return eval(x)\n",
    "from langchain_core.tools import tool\n@tool\ndef t(x: str)->str:\n    return open(x).read()\n",
    "from langchain_core.tools import tool\n@tool\ndef t(x: str)->str:\n    return __import__('os').system(x)\n",
    "from langchain_core.tools import tool\n@tool\ndef t(x: str)->str:\n    return getattr(x, 'lower')()\n",
    "from langchain_core.tools import tool\n@tool\ndef t(x: str)->str:\n    yield x\n",
    "from langchain_core.tools import tool\n@tool\nasync def t(x: str)->str:\n    return x\n",
    "from langchain_core.tools import tool\nclass Sneaky:\n    pass\n@tool\ndef t(x: str)->str:\n    return x\n",
])
def test_validate_rejects_dangerous_source(bad):
    with pytest.raises(SandboxError):
        validate_evolved_tool_source(bad)


def test_validate_rejects_dunder_attribute():
    src = textwrap.dedent("""
        from langchain_core.tools import tool

        @tool
        def t(x: str) -> str:
            return x.__class__.__name__
    """).strip()
    with pytest.raises(SandboxError):
        validate_evolved_tool_source(src)


def test_validate_requires_tool_decorator():
    src = textwrap.dedent("""
        def plain(x: str) -> str:
            return x
    """).strip()
    with pytest.raises(SandboxError) as e:
        validate_evolved_tool_source(src)
    assert e.value.reason == "no_tool_decorator"


def test_validate_rejects_multiple_tool_decorators():
    src = textwrap.dedent("""
        from langchain_core.tools import tool

        @tool
        def t1(x: str) -> str: return x
        @tool
        def t2(x: str) -> str: return x
    """).strip()
    with pytest.raises(SandboxError) as e:
        validate_evolved_tool_source(src)
    assert e.value.reason == "multiple_tool_decorators"


def test_validate_rejects_too_large_source():
    huge = "from langchain_core.tools import tool\n@tool\ndef big(x: str) -> str:\n    return x + '" + "A" * 25000 + "'\n"
    with pytest.raises(SandboxError) as e:
        validate_evolved_tool_source(huge)
    assert e.value.reason == "source_too_large"


# ── loader -----------------------------------------------


def test_loader_returns_invokable_tool():
    clear_sandbox_cache()
    fn = load_evolved_tool(SAFE_TOOL)
    assert hasattr(fn, "invoke")
    # LangChain tool invoke takes a single string + returns its result.
    out = fn.invoke({"text": "hello   world  "})
    assert out.strip() == "hello world"


def test_loader_caches_by_hash():
    clear_sandbox_cache()
    fn1 = load_evolved_tool(SAFE_TOOL)
    fn2 = load_evolved_tool(SAFE_TOOL)
    assert fn1 is fn2


def test_loader_name_mismatch_raises():
    with pytest.raises(SandboxError) as e:
        load_evolved_tool(SAFE_TOOL, declared_name="something_else")
    assert e.value.reason == "name_mismatch"


# ── resolve_tools integration ----------------------------


class _BaseTool:
    def __init__(self, name: str) -> None:
        self.name = name


def test_resolve_tools_loads_overlay_additional_tool():
    pid = _make_project()
    overlay_create(
        surface="tool",
        scope="project",
        project_id=pid["id"],
        payload={
            "disabled": [],
            "additional_tools": [
                {"name": "summarise_text", "source": SAFE_TOOL, "description": "test"},
            ],
        },
    )
    base = [_BaseTool("read_file_tool"), _BaseTool("grep_tool")]
    out = resolve_tools(base, project_id=pid["id"])
    names = [getattr(t, "name", None) or getattr(t, "__name__", None) for t in out]
    assert "read_file_tool" in names
    assert "summarise_text" in names


def test_resolve_tools_skips_invalid_source_without_breaking_agent():
    pid = _make_project()
    overlay_create(
        surface="tool",
        scope="project",
        project_id=pid["id"],
        payload={
            "disabled": [],
            "additional_tools": [
                {"name": "danger", "source": "import os\n@tool\ndef danger(x:str)->str:\n    return os.popen(x).read()\n"},
            ],
        },
    )
    base = [_BaseTool("read_file_tool")]
    out = resolve_tools(base, project_id=pid["id"])
    names = [getattr(t, "name", None) or getattr(t, "__name__", None) for t in out]
    # Bad source is skipped; baseline tools remain unchanged.
    assert names == ["read_file_tool"]


def test_resolve_tools_combines_disabled_and_additional():
    pid = _make_project()
    overlay_create(
        surface="tool",
        scope="project",
        project_id=pid["id"],
        payload={
            "disabled": ["grep_tool"],
            "additional_tools": [
                {"name": "summarise_text", "source": SAFE_TOOL},
            ],
        },
    )
    base = [_BaseTool("read_file_tool"), _BaseTool("grep_tool")]
    out = resolve_tools(base, project_id=pid["id"])
    names = [getattr(t, "name", None) or getattr(t, "__name__", None) for t in out]
    assert "read_file_tool" in names
    assert "grep_tool" not in names
    assert "summarise_text" in names


# ── approve gate -----------------------------------------


def _tool_candidate(pid: str, payload: dict) -> dict:
    return candidate_create(
        surface="tool",
        title="evolved tool",
        rationale="r",
        project_id=pid,
        signal_source={
            "signal": "manual",
            "signal_key": f"manual-tool-{uuid.uuid4().hex[:6]}",
            "suggested_payload": payload,
        },
        created_by="test",
    )


def test_approve_tool_requires_confirm_flag():
    pid = _make_project()
    cand = _tool_candidate(pid["id"], {
        "additional_tools": [{"name": "summarise_text", "source": SAFE_TOOL}],
    })
    with pytest.raises(PermissionError):
        approve_candidate(cand["id"])


def test_approve_tool_with_confirm_writes_overlay():
    pid = _make_project()
    cand = _tool_candidate(pid["id"], {
        "additional_tools": [{"name": "summarise_text", "source": SAFE_TOOL}],
    })
    updated = approve_candidate(cand["id"], confirm_source_reviewed=True)
    assert updated["status"] == "approved"

    base = [_BaseTool("read_file_tool")]
    out = resolve_tools(base, project_id=pid["id"])
    names = [getattr(t, "name", None) or getattr(t, "__name__", None) for t in out]
    assert "summarise_text" in names


def test_approve_tool_refuses_unsafe_source_even_with_confirm():
    pid = _make_project()
    bad_src = textwrap.dedent("""
        from langchain_core.tools import tool
        import subprocess

        @tool
        def danger(x: str) -> str:
            return subprocess.check_output(x, shell=True).decode()
    """).strip()
    cand = _tool_candidate(pid["id"], {
        "additional_tools": [{"name": "danger", "source": bad_src}],
    })
    with pytest.raises(SandboxError):
        approve_candidate(cand["id"], confirm_source_reviewed=True)
    # Candidate stays pending after a sandbox refusal.
    assert candidate_get(cand["id"])["status"] == "pending"


def test_approve_tool_with_payload_override():
    pid = _make_project()
    cand = _tool_candidate(pid["id"], {})  # generator left payload empty
    updated = approve_candidate(
        cand["id"],
        confirm_source_reviewed=True,
        payload_override={
            "disabled": ["grep_tool"],
            "additional_tools": [{"name": "summarise_text", "source": SAFE_TOOL}],
        },
    )
    assert updated["status"] == "approved"
    base = [_BaseTool("grep_tool")]
    out = resolve_tools(base, project_id=pid["id"])
    names = [getattr(t, "name", None) or getattr(t, "__name__", None) for t in out]
    assert "grep_tool" not in names
    assert "summarise_text" in names
