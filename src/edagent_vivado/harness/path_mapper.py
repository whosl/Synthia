"""Map local workspace paths to remote Linux paths — Phase 3A."""

from __future__ import annotations

from pathlib import Path


class PathMapper:
    """Translate paths between a local workspace root and a remote work root."""

    def __init__(self, local_root: str | Path, remote_root: str) -> None:
        self.local_root = Path(local_root).resolve()
        self.remote_root = remote_root.rstrip("/") or "/tmp/edagent_remote"

    def to_remote(self, local_path: str | Path) -> str:
        p = Path(local_path).resolve()
        try:
            rel = p.relative_to(self.local_root)
        except ValueError:
            return f"{self.remote_root}/{p.name}"
        return f"{self.remote_root}/{rel.as_posix()}"

    def to_local(self, remote_path: str) -> Path:
        remote = remote_path.replace("\\", "/")
        prefix = self.remote_root.replace("\\", "/")
        if remote.startswith(prefix):
            suffix = remote[len(prefix) :].lstrip("/")
            return self.local_root / suffix
        return self.local_root / Path(remote).name

    def remote_src_dir(self) -> str:
        return f"{self.remote_root}/src"
