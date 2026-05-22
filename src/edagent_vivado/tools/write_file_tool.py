"""Write-file tool with user-approval guard for the agent."""

from __future__ import annotations

from pathlib import Path

from langchain_core.tools import tool


@tool
def write_file_tool(path: str, content: str) -> str:
    """Write content to a file. Use this to apply patches or save analysis results.

    IMPORTANT: This tool requires user approval before writing. The agent should
    describe what will be written and ask for confirmation before calling this tool.

    Args:
        path: Absolute or relative path to the file.
        content: Full content to write to the file.
    """
    try:
        p = Path(path).resolve()
        p.parent.mkdir(parents=True, exist_ok=True)

        if p.exists():
            backup = p.with_suffix(p.suffix + ".bak")
            backup.write_text(p.read_text(errors="replace"), errors="replace")
            p.write_text(content, encoding="utf-8")
            return (
                f"OK: Updated {path} (backup saved to {backup})\n"
                f"Wrote {len(content)} chars."
            )
        else:
            p.write_text(content, encoding="utf-8")
            return f"OK: Created {path} ({len(content)} chars)"

    except Exception as e:
        return f"ERROR writing {path}: {e}"


@tool
def patch_file_tool(path: str, old_lines: str, new_lines: str) -> str:
    """Apply a targeted text replacement in a file. Safer than write_file for small changes.

    Args:
        path: Path to the file to patch.
        old_lines: The exact lines to replace (must match exactly, including whitespace).
        new_lines: The replacement lines.
    """
    try:
        p = Path(path).resolve()
        if not p.exists():
            return f"ERROR: File not found: {path}"

        original = p.read_text()
        if old_lines not in original:
            return f"ERROR: Could not find the specified text in {path}. File unchanged."

        backup = p.with_suffix(p.suffix + ".bak")
        backup.write_text(original, errors="replace")

        patched = original.replace(old_lines, new_lines, 1)
        p.write_text(patched, encoding="utf-8")

        return (
            f"OK: Patched {path} (backup at {backup})\n"
            f"Replaced {len(old_lines)} chars with {len(new_lines)} chars."
        )
    except Exception as e:
        return f"ERROR patching {path}: {e}"
