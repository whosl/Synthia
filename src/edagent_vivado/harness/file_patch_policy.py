"""File patch approval eligibility and safe apply helpers."""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any

from edagent_vivado.tools.patch_tools import apply_text_patch, parse_modify_payload

__all__ = [
    "is_file_patch_tool",
    "is_file_tool_queued_for_approval",
    "is_interaction_tool",
    "normalize_tool_output",
    "apply_approved_file_item",
]

_TOOL_MESSAGE_REPR_RE = re.compile(
    r"^content=(.+?)(?:\s+name=|\s*$)",
    re.DOTALL,
)


def normalize_tool_output(raw: Any) -> str:
    """Extract plain tool text from LangChain ToolMessage objects or their str() repr."""
    if raw is None:
        return ""
    content = getattr(raw, "content", None)
    if content is not None and not isinstance(raw, str):
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                elif isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text", "")))
            return "".join(parts)
    if isinstance(raw, dict):
        nested = raw.get("content")
        if nested is not None:
            return normalize_tool_output(nested)
    text = str(raw)
    match = _TOOL_MESSAGE_REPR_RE.match(text)
    if match:
        try:
            return ast.literal_eval(match.group(1))
        except (SyntaxError, ValueError):
            pass
    return text


def is_file_patch_tool(tool_name: str) -> bool:
    return tool_name in ("create_file_tool", "propose_patch_tool")


def is_interaction_tool(tool_name: str) -> bool:
    return tool_name in ("request_approval", "request_user_input")


def is_file_tool_queued_for_approval(tool_name: str, output: str | Any) -> bool:
    """Only successful PROPOSED outputs may enter the human approval queue."""
    text = normalize_tool_output(output).strip()
    if tool_name == "create_file_tool":
        return text.startswith("FILE PROPOSED")
    if tool_name == "propose_patch_tool":
        return text.startswith("PATCH PROPOSED")
    return False


def apply_approved_file_item(fi) -> tuple[bool, str]:
    """Apply one approved FileItem. Returns (ok, detail)."""
    fp = Path(fi.path)
    if fi.action == "create":
        if fp.exists():
            return False, f"refused: file already exists: {fi.path}"
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(fi.content)
        return True, "created"

    if fi.action == "modify":
        if not fp.exists():
            return False, f"refused: file not found: {fi.path}"
        parsed = parse_modify_payload(fi.content)
        if not parsed:
            return False, "refused: invalid modify payload (expected --- OLD --- / --- NEW ---)"
        old_text, new_text = parsed
        ok, msg = apply_text_patch(fp, old_text, new_text)
        return ok, msg

    if fi.action == "delete":
        if fp.exists():
            fp.unlink()
        return True, "deleted"

    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(fi.content)
    return True, "written"
