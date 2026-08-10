#!/usr/bin/env python3
import argparse
import re
import sys
from pathlib import Path


def parse_bit_range(value):
    value = str(value).strip().strip('"').strip("'")
    if ":" in value:
        hi, lo = value.replace("[", "").replace("]", "").split(":", 1)
        hi, lo = int(hi, 0), int(lo, 0)
    else:
        hi = lo = int(value.replace("[", "").replace("]", ""), 0)
    if hi < lo:
        hi, lo = lo, hi
    return hi, lo


def parse_expected_yaml(path):
    regs = []
    current = None
    current_field = None
    in_fields = False
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if re.match(r"^  - name:", line):
            current = {"fields": []}
            regs.append(current)
            in_fields = False
            current["name"] = stripped.split(":", 1)[1].strip()
            current_field = None
        elif re.match(r"^      - name:", line):
            if current is None:
                continue
            current_field = {}
            current["fields"].append(current_field)
            in_fields = True
            current_field["name"] = stripped.split(":", 1)[1].strip()
        elif current is not None and ":" in stripped:
            key, value = stripped.split(":", 1)
            key = key.strip()
            value = value.strip()
            if in_fields and current_field is not None and raw.startswith("        "):
                current_field[key] = value
            elif raw.startswith("    "):
                if key == "fields":
                    in_fields = True
                    current.setdefault("fields", [])
                else:
                    current[key] = value
    return regs


def validate(regs):
    errors = []
    offsets = {}
    for reg in regs:
        name = reg.get("name", "<unnamed>")
        if "offset" not in reg:
            errors.append(f"{name}: missing offset")
            continue
        try:
            off = int(str(reg["offset"]), 0)
        except ValueError:
            errors.append(f"{name}: invalid offset {reg.get('offset')}")
            continue
        if off % 4 != 0:
            errors.append(f"{name}: offset {off:#x} is not 32-bit aligned")
        if off in offsets:
            errors.append(f"{name}: duplicate offset {off:#x} also used by {offsets[off]}")
        offsets[off] = name
        width = int(str(reg.get("width", "32")), 0)
        used = set()
        for field in reg.get("fields", []):
            fname = field.get("name", "<unnamed-field>")
            if "bit_range" not in field:
                errors.append(f"{name}.{fname}: missing bit_range")
                continue
            try:
                hi, lo = parse_bit_range(field["bit_range"])
            except Exception:
                errors.append(f"{name}.{fname}: invalid bit_range {field.get('bit_range')}")
                continue
            if hi >= width:
                errors.append(f"{name}.{fname}: bit {hi} exceeds register width {width}")
            for bit in range(lo, hi + 1):
                if bit in used:
                    errors.append(f"{name}.{fname}: bit {bit} overlaps another field")
                used.add(bit)
            for req in ("access", "reset"):
                if req not in field:
                    errors.append(f"{name}.{fname}: missing {req}")
        for req in ("reset", "access"):
            if req not in reg:
                errors.append(f"{name}: missing {req}")
    return errors


def main():
    parser = argparse.ArgumentParser(description="Validate the fpga-register-spec YAML subset.")
    parser.add_argument("register_map")
    args = parser.parse_args()
    regs = parse_expected_yaml(args.register_map)
    if not regs:
        print("ERROR: no registers parsed", file=sys.stderr)
        return 2
    errors = validate(regs)
    if errors:
        print("Register map validation failed:")
        for item in errors:
            print(f"- {item}")
        return 1
    print(f"Register map validation passed: {len(regs)} registers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
