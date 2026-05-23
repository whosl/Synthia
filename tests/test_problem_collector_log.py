"""ProblemCollector parses referenced Vivado log files."""

from pathlib import Path

from edagent_vivado.harness.problem_collector import collect_from_tool_output


def test_collect_from_log_path_in_output(tmp_path: Path):
    log = tmp_path / "vivado.log"
    log.write_text("ERROR: [Synth 8-439] module foo not found\n")
    output = f"Synthesis failed. See log: {log}"
    problems = collect_from_tool_output("run_vivado_synth_tool", output, source="tool")
    assert problems
    assert any("Synth 8-439" in p["message"] or "8-439" in p["message"] for p in problems)
