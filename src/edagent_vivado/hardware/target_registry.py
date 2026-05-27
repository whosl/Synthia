"""HardwareTarget CRUD — Phase 12."""

from __future__ import annotations

import json
import time

from edagent_vivado.hardware.models import HardwareTarget, TargetState
from edagent_vivado.repository.db import get_db


def target_create(t: HardwareTarget) -> dict:
    db = get_db()
    db.execute(
        "INSERT INTO hardware_targets "
        "(id, name, serial, part, description, host, xvc_url, "
        "capabilities_json, state, last_seen_at, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            t.id,
            t.name,
            t.serial,
            t.part,
            t.description,
            t.host,
            t.xvc_url,
            json.dumps(t.capabilities),
            t.state,
            t.last_seen_at,
            t.created_at,
            t.updated_at,
        ),
    )
    db.commit()
    return t.to_dict()


def target_list(state: str = "") -> list[dict]:
    db = get_db()
    sql = "SELECT * FROM hardware_targets"
    params: list = []
    if state:
        sql += " WHERE state=?"
        params.append(state)
    sql += " ORDER BY name"
    rows = db.execute(sql, params).fetchall()
    return [_row(r) for r in rows]


def target_get(target_id: str) -> dict | None:
    db = get_db()
    r = db.execute("SELECT * FROM hardware_targets WHERE id=?", (target_id,)).fetchone()
    return _row(r) if r else None


def target_get_by_serial(serial: str) -> dict | None:
    db = get_db()
    r = db.execute("SELECT * FROM hardware_targets WHERE serial=?", (serial,)).fetchone()
    return _row(r) if r else None


def target_update(target_id: str, **fields) -> None:
    if not fields:
        return
    fields["updated_at"] = int(time.time() * 1000)
    if "capabilities" in fields and isinstance(fields["capabilities"], dict):
        fields["capabilities_json"] = json.dumps(fields.pop("capabilities"))
    sql = "UPDATE hardware_targets SET " + ", ".join(f"{k}=?" for k in fields) + " WHERE id=?"
    db = get_db()
    db.execute(sql, (*fields.values(), target_id))
    db.commit()


def target_mark_seen(target_id: str) -> None:
    target_update(
        target_id,
        last_seen_at=int(time.time() * 1000),
        state=TargetState.AVAILABLE.value,
    )


def _row(r) -> dict:
    d = dict(r)
    d["capabilities"] = json.loads(d.pop("capabilities_json", None) or "{}")
    return d
