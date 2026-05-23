"""Assistant text stream IDs — one stream per speech segment between tools (timeline canonical model)."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class AssistantStreamManager:
    """Manages monotonic stream_id values and per-stream text for a single task run."""

    task_id: str
    _segment: int = 0
    current_stream_id: str = field(init=False)
    stream_texts: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.current_stream_id = self._make_id()
        self.stream_texts[self.current_stream_id] = ""

    def _make_id(self) -> str:
        return f"{self.task_id}-s{self._segment}"

    @property
    def segment_index(self) -> int:
        return self._segment

    def append_delta(self, text: str) -> None:
        sid = self.current_stream_id
        self.stream_texts[sid] = self.stream_texts.get(sid, "") + text

    def text_for(self, stream_id: str) -> str:
        return self.stream_texts.get(stream_id, "")

    def rotate_after_tool(self) -> tuple[str, str]:
        """Close the active stream and open the next. Returns (closed_id, new_id)."""
        closed = self.current_stream_id
        self._segment += 1
        self.current_stream_id = self._make_id()
        self.stream_texts[self.current_stream_id] = ""
        return closed, self.current_stream_id
