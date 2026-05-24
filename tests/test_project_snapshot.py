import json

from edagent_vivado.projects.snapshot import parse_snapshot, snapshot_context_lines, snapshot_manifest_path


def test_parse_snapshot_from_session_row():
    snap = {"manifest_path": "/tmp/eda.yaml", "part": "xc7a35t"}
    row = {"project_snapshot_json": json.dumps(snap)}
    assert parse_snapshot(row)["manifest_path"] == "/tmp/eda.yaml"


def test_snapshot_manifest_prefers_request():
    row = {"project_snapshot_json": json.dumps({"manifest_path": "/a.yaml"})}
    assert snapshot_manifest_path(row, "/override.yaml") == "/override.yaml"
    assert snapshot_manifest_path(row) == "/a.yaml"


def test_snapshot_context_lines():
    text = snapshot_context_lines({"name": "uart", "manifest_path": "/x/eda.yaml", "part": "xc7"})
    assert "uart" in text
    assert "eda.yaml" in text
