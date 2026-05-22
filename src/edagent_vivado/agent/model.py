"""LLM model initialization."""

from __future__ import annotations

import logging
import os
from typing import Any

from langchain_anthropic import ChatAnthropic

logger = logging.getLogger(__name__)


def _ensure_langsmith() -> None:
    """Enable LangSmith tracing if environment variables are set.

    Must be called *before* any LangChain imports that create runs.
    Safe to call multiple times — only applies settings once.
    """
    if os.environ.get("LANGSMITH_TRACING", "").lower() in ("true", "1"):
        os.environ.setdefault("LANGCHAIN_TRACING_V2", "true")
        if os.environ.get("LANGSMITH_API_KEY") and not os.environ.get("LANGCHAIN_API_KEY"):
            os.environ["LANGCHAIN_API_KEY"] = os.environ["LANGSMITH_API_KEY"]
        if os.environ.get("LANGSMITH_PROJECT") and not os.environ.get("LANGCHAIN_PROJECT"):
            os.environ["LANGCHAIN_PROJECT"] = os.environ["LANGSMITH_PROJECT"]
        logger.info("LangSmith tracing enabled — project: %s", os.environ.get("LANGCHAIN_PROJECT", "default"))
    else:
        logger.debug("LangSmith tracing disabled (set LANGSMITH_TRACING=true to enable)")


def get_llm() -> ChatAnthropic:
    """Create the Claude LLM instance from environment variables.

    Reads:
        - ANTHROPIC_API_KEY
        - ANTHROPIC_BASE_URL  (optional — for GLM / compatible APIs)
        - EDAGENT_MODEL        (default: claude-sonnet-4-20250514)
    """
    _ensure_langsmith()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        logger.warning("ANTHROPIC_API_KEY not set — agent will fail at runtime")

    base_url = os.environ.get("ANTHROPIC_BASE_URL") or None
    model_name = os.environ.get("EDAGENT_MODEL", "claude-sonnet-4-20250514")

    if base_url:
        logger.info("Initializing LLM: %s via %s", model_name, base_url)
    else:
        logger.info("Initializing LLM: %s", model_name)

    kwargs: dict[str, Any] = dict(model=model_name, temperature=0)
    if api_key:
        kwargs["api_key"] = api_key
    if base_url:
        kwargs["base_url"] = base_url

    return ChatAnthropic(**kwargs)
