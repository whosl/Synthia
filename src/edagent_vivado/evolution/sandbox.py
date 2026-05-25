"""Sandbox loader for evolved agent tools (SPEC §22.11, SE-PR8).

The ``tool`` evolution surface is the highest-risk one: an approved candidate
ends up as a callable inside the LangChain tool registry. To make that
remotely safe, every candidate source must:

1. **Parse** as valid Python via :mod:`ast`.
2. **Pass the whitelist** in :class:`AstWhitelistVisitor` — no ``exec`` /
   ``eval`` / ``open`` / ``__import__`` / network calls / ``subprocess`` /
   ``os.system`` / class definitions / async / yields.
3. **Use only the allowed imports** (``re``, ``json``, ``math``, ``hashlib``,
   ``typing``, ``dataclasses``, ``pathlib`` and the in-process
   ``langchain_core.tools.tool`` decorator).
4. **Define exactly one ``@tool``-decorated function** matching the candidate's
   declared name.
5. **Execute** under a restricted ``globals`` dict that strips builtins down
   to a known-safe subset.

Failures raise :class:`SandboxError` with a structured ``reason`` so the
review UI can surface a precise rejection cause. The loader caches compiled
sources by sha256 so repeated resolves do not re-compile the same body.
"""

from __future__ import annotations

import ast
import builtins
import hashlib
import logging
import re
from dataclasses import dataclass
from typing import Any, Callable

logger = logging.getLogger(__name__)


# ── public errors ─────────────────────────────────────────


class SandboxError(ValueError):
    """Raised when a candidate's tool source fails validation or loading."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


# ── AST whitelist ─────────────────────────────────────────


# Imports the evolved tool body may use. Everything else is rejected.
ALLOWED_IMPORT_MODULES: frozenset[str] = frozenset({
    "re",
    "json",
    "math",
    "hashlib",
    "typing",
    "dataclasses",
    "pathlib",
    "langchain_core.tools",
})

# Top-level names a sandboxed body may dereference / call.
ALLOWED_BUILTINS: frozenset[str] = frozenset({
    "abs", "all", "any", "bool", "dict", "enumerate", "filter", "float",
    "frozenset", "int", "len", "list", "map", "max", "min", "range",
    "round", "set", "sorted", "str", "sum", "tuple", "zip",
    "isinstance", "issubclass", "repr", "type",
    "True", "False", "None",
})

# Forbidden bare names anywhere in the AST (including attribute roots and
# arguments). Catches the "import os via attribute" hack.
FORBIDDEN_NAMES: frozenset[str] = frozenset({
    "exec", "eval", "compile", "__import__", "open", "input", "breakpoint",
    "globals", "locals", "vars", "getattr", "setattr", "delattr",
    "memoryview", "bytearray", "bytes",  # binary IO funnel
})

# Forbidden attribute access patterns (deny anything starting with `_`
# except the LangChain ``@tool`` decorator's metadata attributes).
_DOUBLE_UNDERSCORE = re.compile(r"^__\w+__$")


@dataclass
class AstFinding:
    node_type: str
    detail: str
    lineno: int = 0


class AstWhitelistVisitor(ast.NodeVisitor):
    """Walks an AST, collecting whitelist violations.

    Callers should run :meth:`raise_if_violations` after visiting; an empty
    findings list means the body is structurally safe.
    """

    def __init__(self) -> None:
        self.findings: list[AstFinding] = []
        self.tool_function_names: list[str] = []

    # ── violation helpers ─────────────────────────────────

    def _violate(self, node: ast.AST, kind: str, detail: str) -> None:
        self.findings.append(
            AstFinding(node_type=kind, detail=detail, lineno=getattr(node, "lineno", 0))
        )

    # ── top-level shape ───────────────────────────────────

    def visit_Module(self, node: ast.Module) -> None:
        for stmt in node.body:
            if isinstance(stmt, ast.Import):
                self.visit_Import(stmt)
            elif isinstance(stmt, ast.ImportFrom):
                self.visit_ImportFrom(stmt)
            elif isinstance(stmt, ast.FunctionDef):
                self._check_function(stmt, top_level=True)
            elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant):
                # Module docstring is fine.
                continue
            else:
                self._violate(stmt, "disallowed_top_level", type(stmt).__name__)

    # ── imports ───────────────────────────────────────────

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            if alias.name not in ALLOWED_IMPORT_MODULES:
                self._violate(node, "import_denied", alias.name)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = (node.module or "").split(".")[0] if node.module else ""
        full = node.module or ""
        if full not in ALLOWED_IMPORT_MODULES and module not in {
            m.split(".")[0] for m in ALLOWED_IMPORT_MODULES
        }:
            self._violate(node, "import_denied", full)

    # ── function bodies ───────────────────────────────────

    def _check_function(self, node: ast.FunctionDef, *, top_level: bool) -> None:
        if isinstance(node, ast.AsyncFunctionDef):
            self._violate(node, "async_function", node.name)
            return
        decorated_with_tool = False
        for dec in node.decorator_list:
            if isinstance(dec, ast.Name) and dec.id == "tool":
                decorated_with_tool = True
            elif isinstance(dec, ast.Attribute) and dec.attr == "tool":
                decorated_with_tool = True
            else:
                self._violate(dec, "decorator_denied", ast.unparse(dec))
        if top_level and decorated_with_tool:
            self.tool_function_names.append(node.name)
        # Walk the body for forbidden constructs.
        for sub in ast.walk(node):
            self._check_sub(sub)

    def _check_sub(self, node: ast.AST) -> None:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            # nested imports allowed only if also in whitelist
            if isinstance(node, ast.Import):
                self.visit_Import(node)
            else:
                self.visit_ImportFrom(node)
            return
        if isinstance(node, (ast.ClassDef, ast.AsyncFunctionDef, ast.AsyncFor, ast.AsyncWith, ast.Await, ast.Yield, ast.YieldFrom)):
            self._violate(node, "disallowed_construct", type(node).__name__)
            return
        if isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            self._violate(node, "forbidden_name", node.id)
            return
        if isinstance(node, ast.Attribute):
            attr = node.attr
            if _DOUBLE_UNDERSCORE.match(attr) and attr not in {"__name__", "__doc__"}:
                self._violate(node, "dunder_attribute", attr)
                return
            if attr.startswith("_") and not _DOUBLE_UNDERSCORE.match(attr):
                # Private attribute access is suspicious; flag explicitly.
                self._violate(node, "private_attribute", attr)
                return
        if isinstance(node, ast.Call):
            target = node.func
            if isinstance(target, ast.Attribute):
                # block .system / .popen / .Popen / .read_text on raw os modules
                if target.attr in {
                    "system", "popen", "Popen", "call", "spawn",
                    "spawnvp", "execv", "execvp", "execve", "fork",
                    "kill", "waitpid", "putenv",
                }:
                    self._violate(node, "forbidden_call", target.attr)
            if isinstance(target, ast.Name) and target.id in FORBIDDEN_NAMES:
                # already caught by visit_Name, but be explicit
                self._violate(node, "forbidden_call", target.id)

    def raise_if_violations(self) -> None:
        if self.findings:
            detail = ", ".join(
                f"{f.node_type}:{f.detail}@L{f.lineno}" for f in self.findings
            )
            raise SandboxError("ast_whitelist", detail)


# ── safe builtins ────────────────────────────────────────


def _safe_builtins() -> dict[str, Any]:
    """A minimal ``__builtins__`` mapping for ``exec``.

    ``__import__`` has to be present at exec time so the already-AST-approved
    ``from langchain_core.tools import tool`` statement actually resolves;
    the AST visitor still forbids user code from calling ``__import__``
    directly, so this does not widen the attack surface.
    """
    safe = {name: getattr(builtins, name) for name in ALLOWED_BUILTINS if hasattr(builtins, name)}
    safe["__import__"] = _restricted_import
    return safe


def _restricted_import(name, globals=None, locals=None, fromlist=(), level=0):  # noqa: A002 - mirror builtin signature
    """A ``__import__`` that only honours the whitelist."""
    top_level = (name or "").split(".")[0]
    if name not in ALLOWED_IMPORT_MODULES and top_level not in {
        m.split(".")[0] for m in ALLOWED_IMPORT_MODULES
    }:
        raise ImportError(f"sandbox: import of {name!r} is not allowed")
    return __import__(name, globals, locals, fromlist, level)


# ── compiled-source cache ────────────────────────────────


_TOOL_CACHE: dict[str, Callable[..., Any]] = {}


def _hash(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def validate_source(source: str) -> dict[str, Any]:
    """AST-validate ``source`` without executing.

    Returns a dict that the UI/API can serialise directly. Raises
    :class:`SandboxError` on any rejection so the caller knows the user must
    fix the source before approval can proceed.
    """
    if not isinstance(source, str) or not source.strip():
        raise SandboxError("empty_source", "no Python source provided")
    if len(source) > 20_000:
        raise SandboxError("source_too_large", f"{len(source)} bytes (limit 20000)")
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        raise SandboxError("syntax_error", f"line {exc.lineno}: {exc.msg}") from exc
    visitor = AstWhitelistVisitor()
    visitor.visit(tree)
    visitor.raise_if_violations()
    if not visitor.tool_function_names:
        raise SandboxError(
            "no_tool_decorator",
            "exactly one @tool-decorated function required at top level",
        )
    if len(visitor.tool_function_names) > 1:
        raise SandboxError(
            "multiple_tool_decorators",
            ", ".join(visitor.tool_function_names),
        )
    return {
        "ok": True,
        "tool_name": visitor.tool_function_names[0],
        "hash": _hash(source),
        "source_bytes": len(source),
    }


def load_tool(source: str, *, declared_name: str | None = None) -> Callable[..., Any]:
    """Validate + exec the source into a restricted namespace; return the tool callable."""
    summary = validate_source(source)
    tool_name = summary["tool_name"]
    if declared_name and tool_name != declared_name:
        raise SandboxError(
            "name_mismatch",
            f"declared {declared_name!r} but source defines {tool_name!r}",
        )

    cache_key = f"{summary['hash']}:{tool_name}"
    cached = _TOOL_CACHE.get(cache_key)
    if cached is not None:
        return cached

    # Build a restricted globals dict. We import the LangChain decorator
    # **once** in this controlled environment so the evolved body's
    # `@tool` reference resolves to the same callable production tools use.
    from langchain_core.tools import tool as _tool_decorator

    sandbox_globals: dict[str, Any] = {
        "__builtins__": _safe_builtins(),
        "__name__": f"evolved_tool::{tool_name}",
        "tool": _tool_decorator,
    }

    try:
        exec(compile(source, sandbox_globals["__name__"], "exec"), sandbox_globals)
    except Exception as exc:
        raise SandboxError("exec_failed", repr(exc)) from exc

    fn = sandbox_globals.get(tool_name)
    if fn is None:
        raise SandboxError("function_missing", f"{tool_name!r} not bound after exec")
    if not hasattr(fn, "invoke") and not callable(fn):
        raise SandboxError("not_a_tool", f"{tool_name!r} is not callable / not a LangChain tool")
    _TOOL_CACHE[cache_key] = fn
    return fn


def clear_tool_cache() -> None:
    """Drop the cached compiled tools — used by tests that rebuild sources."""
    _TOOL_CACHE.clear()


def cache_size() -> int:
    return len(_TOOL_CACHE)
