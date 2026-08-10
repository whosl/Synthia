#!/usr/bin/env python3
import argparse
from pathlib import Path
from regmap_validate import parse_expected_yaml


def main():
    parser = argparse.ArgumentParser(description="Render Markdown from the fpga-register-spec YAML subset.")
    parser.add_argument("register_map")
    parser.add_argument("--out", default="-")
    args = parser.parse_args()
    regs = parse_expected_yaml(args.register_map)
    lines = ["# Register Map", "", "| Offset | Register | Access | Reset | Description |", "| --- | --- | --- | --- | --- |"]
    for reg in regs:
        lines.append(f"| `{reg.get('offset','')}` | `{reg.get('name','')}` | {reg.get('access','')} | `{reg.get('reset','')}` | {reg.get('description','')} |")
    lines += ["", "## Field Details", "", "| Register | Bits | Field | Access | Reset | Side effect |", "| --- | --- | --- | --- | --- | --- |"]
    for reg in regs:
        for field in reg.get("fields", []):
            lines.append(
                f"| `{reg.get('name','')}` | `{field.get('bit_range','')}` | `{field.get('name','')}` | "
                f"{field.get('access','')} | {field.get('reset','')} | {field.get('side_effect','')} |"
            )
    text = "\n".join(lines) + "\n"
    if args.out == "-":
        print(text, end="")
    else:
        Path(args.out).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
