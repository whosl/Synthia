"""File read/grep tools for the agent."""

from __future__ import annotations

from pathlib import Path

from langchain_core.tools import tool


@tool
def read_file_tool(path: str) -> str:
    """Read the contents of a file. Use this to inspect logs, reports, manifests, or source code.

    Args:
        path: Absolute or relative path to the file.
    """
    try:
        p = Path(path)
        if not p.exists():
            return f"ERROR: File not found: {path}"
        content = p.read_text(errors="replace")
        # truncate to avoid blowing the context
        if len(content) > 50_000:
            content = content[:50_000] + f"\n... [TRUNCATED at 50000 chars]"
        return content
    except Exception as e:
        return f"ERROR reading {path}: {e}"


@tool
def grep_tool(pattern: str, root: str = ".") -> str:
    """Search for a pattern in files under a directory. Uses a simple line-by-line search.

    Args:
        pattern: The regex or literal string to search for.
        root: Root directory to search in (default: current directory).
    """
    import re

    root_path = Path(root).resolve()
    if not root_path.exists():
        return f"ERROR: Directory not found: {root}"

    results: list[str] = []
    extensions = {".v", ".sv", ".vhd", ".xdc", ".tcl", ".yaml", ".yml", ".rpt", ".log", ".py"}

    for f in root_path.rglob("*"):
        if f.suffix not in extensions or f.is_dir():
            continue
        try:
            text = f.read_text(errors="replace")
            for lineno, line in enumerate(text.splitlines(), 1):
                if re.search(pattern, line):
                    rel = f.relative_to(root_path)
                    results.append(f"{rel}:{lineno}: {line.strip()[:200]}")
                    if len(results) >= 50:
                        break
            if len(results) >= 50:
                results.append("... [TRUNCATED at 50 matches]")
                break
        except Exception:
            continue

    if not results:
        return f"No matches found for {pattern!r} in {root}"
    return "\n".join(results)
