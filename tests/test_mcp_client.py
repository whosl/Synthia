"""Phase 9 — Synthia MCP HTTP client tests."""

from __future__ import annotations

import json

import httpx
import pytest

from edagent_vivado.mcp.client import SynthiaClient, SynthiaError


def _make_client(responses):
    def handler(request: httpx.Request) -> httpx.Response:
        for matcher, resp in responses:
            if matcher(request):
                return resp
        return httpx.Response(404, json={"detail": "no mock matched"})

    transport = httpx.MockTransport(handler)
    client = SynthiaClient("http://localhost:8484", "tok", timeout=5)
    client._client = httpx.Client(
        transport=transport,
        headers={"Authorization": "Bearer tok"},
    )
    return client


def test_list_projects():
    c = _make_client(
        [
            (
                lambda r: r.url.path == "/api/v1/projects" and r.method == "GET",
                httpx.Response(200, json={"projects": [{"id": "p1"}]}),
            ),
        ]
    )
    assert c.list_projects() == [{"id": "p1"}]


def test_create_run_via_vivado_flow():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/projects/p1" and request.method == "GET":
            return httpx.Response(200, json={"project": {"id": "p1", "manifest_path": "/m.yaml"}})
        if request.url.path == "/api/v1/projects/p1/sessions" and request.method == "GET":
            return httpx.Response(200, json={"sessions": [{"id": "s1"}]})
        if request.url.path == "/api/v1/vivado/commands/flow" and request.method == "POST":
            body = json.loads(request.content)
            assert body["manifest_path"] == "/m.yaml"
            assert body["stages"] == ["synth"]
            return httpx.Response(200, json={"run_id": "r1", "state": "queued"})
        return httpx.Response(404, json={"detail": "unmatched"})

    transport = httpx.MockTransport(handler)
    c = SynthiaClient("http://localhost:8484", "tok", timeout=5)
    c._client = httpx.Client(transport=transport, headers={"Authorization": "Bearer tok"})
    r = c.create_run("p1", "vivado_synth_only", inputs={"strategy": "default"})
    assert r["run_id"] == "r1"


def test_403_translates_to_needs_approval():
    c = _make_client([(lambda r: True, httpx.Response(403, json={"detail": "needs reviewer"}))])
    with pytest.raises(SynthiaError) as exc_info:
        c.approve_patch("p1")
    assert exc_info.value.needs_approval


def test_500_no_needs_approval():
    c = _make_client([(lambda r: True, httpx.Response(500, json={"detail": "internal"}))])
    with pytest.raises(SynthiaError) as exc_info:
        c.list_projects()
    assert not exc_info.value.needs_approval


def test_propose_patch_payload():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"patch": {"id": "px"}})

    transport = httpx.MockTransport(handler)
    c = SynthiaClient("http://localhost:8484", "tok", timeout=5)
    c._client = httpx.Client(transport=transport, headers={"Authorization": "Bearer tok"})
    c.propose_patch(
        session_id="s1",
        title="t",
        rationale="r",
        changes=[{"path": "x.xdc", "action": "modify", "before_text": "a", "after_text": "b"}],
        project_id="p1",
    )
    assert captured["body"]["title"] == "t"
    assert captured["body"]["changes"][0]["path"] == "x.xdc"
