"""LLM model initialization."""

from __future__ import annotations

import logging
import os
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_anthropic import ChatAnthropic
from langchain_openai import ChatOpenAI

logger = logging.getLogger(__name__)

MODEL_SETTINGS_KEY = "model_config"


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


def _stored_model_settings() -> dict[str, Any]:
    try:
        from edagent_vivado.repository.store import settings_get

        stored = settings_get(MODEL_SETTINGS_KEY, default={})
        return stored if isinstance(stored, dict) else {}
    except Exception as exc:
        logger.debug("model settings unavailable, using environment: %s", exc)
        return {}


def _env_first(*names: str) -> str:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return ""


def _get_openai_llm() -> ChatOpenAI:
    """Create an OpenAI-compatible chat model from saved settings and environment."""
    settings = _stored_model_settings()
    api_key = str(settings.get("api_key") or _env_first("OPENAI_API_KEY", "ANTHROPIC_API_KEY"))
    if not api_key:
        logger.warning("OPENAI_API_KEY/ANTHROPIC_API_KEY not set — agent will fail at runtime")

    base_url = str(settings.get("base_url") or _env_first("OPENAI_BASE_URL", "ANTHROPIC_BASE_URL")) or None
    model_name = str(settings.get("model") or os.environ.get("EDAGENT_MODEL") or "gpt-5.5")
    reasoning_effort = str(
        settings.get("reasoning_effort")
        or _env_first("OPENAI_REASONING_EFFORT", "EDAGENT_REASONING_EFFORT")
    )

    if base_url:
        logger.info("Initializing OpenAI-compatible LLM: %s via %s", model_name, base_url)
    else:
        logger.info("Initializing OpenAI-compatible LLM: %s", model_name)

    kwargs: dict[str, Any] = dict(model=model_name, temperature=0)
    if api_key:
        kwargs["api_key"] = api_key
    if base_url:
        kwargs["base_url"] = base_url
    if reasoning_effort:
        kwargs["reasoning_effort"] = reasoning_effort

    return ChatOpenAI(**kwargs)


def _get_anthropic_llm() -> ChatAnthropic:
    """Create the Claude/Anthropic-compatible LLM instance from environment variables.

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


def get_llm() -> BaseChatModel:
    """Create the configured chat model.

    Set ``EDAGENT_MODEL_PROVIDER=openai`` for OpenAI-compatible gateways. The
    default remains Anthropic-compatible to preserve existing deployments.
    """
    settings = _stored_model_settings()
    provider = str(settings.get("provider") or os.environ.get("EDAGENT_MODEL_PROVIDER", "anthropic")).strip().lower()
    if provider in ("openai", "openai-compatible", "chatopenai"):
        _ensure_langsmith()
        return _get_openai_llm()
    return _get_anthropic_llm()
