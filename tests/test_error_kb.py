"""Tests for the expanded error knowledge base."""

from edagent_vivado.kb.error_case_loader import load_cases, match_cases, ErrorCase


def test_load_cases_returns_list():
    cases = load_cases()
    assert isinstance(cases, list)
    assert len(cases) >= 50, f"Expected 50+ cases, got {len(cases)}"


def test_all_cases_have_required_fields():
    cases = load_cases()
    for case in cases:
        assert isinstance(case, ErrorCase)
        assert case.pattern, f"Missing pattern in {case}"
        assert case.category, f"Missing category in {case}"
        assert isinstance(case.likely_causes, list)
        assert isinstance(case.suggested_actions, list)


def test_match_synth_8_439():
    cases = load_cases()
    matches = match_cases(["ERROR: [Synth 8-439] Module 'echo_handler' not found"], cases)
    assert len(matches) >= 1
    assert matches[0][0].category == "missing_module_or_bad_compile_order"


def test_match_place_30_574():
    cases = load_cases()
    matches = match_cases(["ERROR: [Place 30-574] Poor placement — routing congestion"], cases)
    assert len(matches) >= 1
    assert matches[0][0].category == "placement_congestion"


def test_match_route_35():
    cases = load_cases()
    matches = match_cases(["ERROR: [Route 35-12] Routing failed"], cases)
    assert len(matches) >= 1


def test_match_timing_violation():
    cases = load_cases()
    matches = match_cases(["CRITICAL WARNING: [Timing 38-282] The design failed to meet timing"], cases)
    assert len(matches) >= 1


def test_match_drc_violation():
    cases = load_cases()
    matches = match_cases(["DRC violation — IO standard conflict"], cases)
    assert len(matches) >= 1


def test_match_ip_error():
    cases = load_cases()
    matches = match_cases(["ERROR: [IP_Flow 19-3461] License not found"], cases)
    assert len(matches) >= 1


def test_match_syntax_error():
    cases = load_cases()
    matches = match_cases(["ERROR: [Synth 8-327] Syntax error near 'assign'"], cases)
    assert len(matches) >= 1


def test_no_match_unknown():
    cases = load_cases()
    matches = match_cases(["SOME RANDOM TEXT WITH NO PATTERN"], cases)
    assert len(matches) == 0


def test_kb_categories_coverage():
    """Ensure we cover major error categories."""
    cases = load_cases()
    categories = {c.category for c in cases}
    expected = {
        "missing_module_or_bad_compile_order",
        "placement_congestion",
        "routing_congestion_or_delay",
        "timing_violation",
        "drc_violation",
        "vivado_command_failed",
    }
    for cat in expected:
        assert cat in categories, f"Missing category: {cat}"
