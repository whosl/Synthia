from __future__ import annotations

import importlib

from fastapi.testclient import TestClient

from edagent_vivado.repository import db as db_mod
from edagent_vivado.repository import store as store_mod


def _client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "settings.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "runtime"))
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    import edagent_vivado.web.api_v1 as api_v1
    import edagent_vivado.web.app as app_mod

    importlib.reload(api_v1)
    importlib.reload(app_mod)
    db_mod.init_db()
    store_mod.settings_set(api_v1.MODEL_SETTINGS_KEY, {})
    return TestClient(app_mod.create_app())


def test_model_settings_default_and_env_key_masking(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-secret-123456")
    client = _client(tmp_path, monkeypatch)

    resp = client.get("/api/v1/settings/model")
    assert resp.status_code == 200
    body = resp.json()

    assert body["provider"] == "openai-compatible"
    assert body["base_url"] == "https://api-slb.krill-ai.com/codex/v1"
    assert body["model"] == "gpt-5.5"
    assert body["reasoning_effort"] == "medium"
    assert body["has_api_key"] is True
    assert body["masked_api_key"] == "sk-t...3456"
    assert "sk-test-secret" not in resp.text


def test_model_settings_save_preserves_and_masks_stored_key(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    client = _client(tmp_path, monkeypatch)

    resp = client.post(
        "/api/v1/settings/model",
        json={
            "provider": "openai-compatible",
            "base_url": "https://example.test/v1",
            "model": "custom-gpt",
            "api_key": "secret-key-987654321",
            "reasoning_effort": "high",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["base_url"] == "https://example.test/v1"
    assert body["model"] == "custom-gpt"
    assert body["reasoning_effort"] == "high"
    assert body["has_api_key"] is True
    assert body["masked_api_key"] == "secr...4321"
    assert "secret-key" not in resp.text

    resp2 = client.post(
        "/api/v1/settings/model",
        json={
            "provider": "openai-compatible",
            "base_url": "https://example.test/v2",
            "model": "custom-gpt-2",
            "reasoning_effort": "low",
        },
    )
    assert resp2.status_code == 200
    body2 = resp2.json()
    assert body2["masked_api_key"] == "secr...4321"


def test_model_settings_select_preset_preserves_key(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    client.post(
        "/api/v1/settings/model",
        json={
            "provider": "openai-compatible",
            "base_url": "https://example.test/v1",
            "model": "custom-gpt",
            "api_key": "secret-key-00009999",
            "reasoning_effort": "medium",
        },
    )

    resp = client.post("/api/v1/settings/model/preset", json={"preset_id": "gpt-5.4-mini"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["base_url"] == "https://api-slb.krill-ai.com/codex/v1"
    assert body["model"] == "gpt-5.4-mini"
    assert body["selected_preset"] == "gpt-5.4-mini"
    assert body["masked_api_key"] == "secr...9999"


def test_saved_model_settings_drive_llm_factory(tmp_path, monkeypatch):
    monkeypatch.setenv("EDAGENT_DB_PATH", str(tmp_path / "settings.db"))
    monkeypatch.setenv("EDAGENT_RUNTIME_DIR", str(tmp_path / "runtime"))
    monkeypatch.setenv("EDAGENT_MODEL_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "env-key")
    importlib.reload(db_mod)
    importlib.reload(store_mod)
    import edagent_vivado.agent.model as model_mod

    importlib.reload(model_mod)
    db_mod.init_db()
    store_mod.settings_set(
        "model_config",
        {
            "provider": "openai-compatible",
            "base_url": "https://example.test/v1",
            "model": "custom-gpt",
            "api_key": "stored-key",
            "reasoning_effort": "high",
        },
    )

    llm = model_mod.get_llm()

    assert getattr(llm, "model_name", None) == "custom-gpt"
    assert getattr(llm, "openai_api_base", None) == "https://example.test/v1"
    assert getattr(llm, "reasoning_effort", None) == "high"
