"""Phase 5 bitstream detector tests."""

from __future__ import annotations

import hashlib

from edagent_vivado.connectors.vivado.parsers.bitstream import detect_bitstream


def test_detect_bitstream_empty(tmp_path):
    rep = detect_bitstream(str(tmp_path))
    assert rep.data["found"] is False
    assert rep.data["count"] == 0
    assert rep.data["files"] == []
    assert rep.data["primary_bit"] == ""


def test_detect_bitstream_collects_metadata(tmp_path):
    impl_dir = tmp_path / "impl_1"
    impl_dir.mkdir()
    bit_path = impl_dir / "top.bit"
    bit_bytes = b"\x00\x01\x02\x03" * 100
    bit_path.write_bytes(bit_bytes)
    (impl_dir / "top.ltx").write_bytes(b"ltx-content")
    (impl_dir / "top.mcs").write_bytes(b"mcs")

    rep = detect_bitstream(str(tmp_path))
    data = rep.data
    assert data["found"] is True
    assert data["count"] == 3
    primary = data["primary_bit"].lower()
    assert primary.endswith(".bit")
    bit_entry = next(f for f in data["files"] if f["kind"] == "bit")
    assert bit_entry["size_bytes"] == len(bit_bytes)
    assert bit_entry["sha256"] == hashlib.sha256(bit_bytes).hexdigest()


def test_detect_bitstream_missing_root_returns_empty(tmp_path):
    missing = tmp_path / "does_not_exist"
    rep = detect_bitstream(str(missing))
    assert rep.data["found"] is False
    assert rep.data["count"] == 0
