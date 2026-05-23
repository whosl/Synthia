"""Interaction tools — allow the agent to request user input or approval."""

from __future__ import annotations

from langchain_core.tools import tool


@tool
def request_user_input(
    title: str,
    message: str,
    fields: list[dict],
) -> str:
    """Request information from the user when you don't have enough context to proceed.

    Use this tool when you need the user to provide:
    - FPGA device/part selection (use field_type="search_select" with options from vivado)
    - Package selection
    - Project configuration parameters
    - Clarification on ambiguous requirements

    IMPORTANT: Provide recommendations but do NOT pre-fill default values.
    The user must explicitly choose.

    Args:
        title: Brief title for the request (e.g. "FPGA Device Selection Required")
        message: Explanation of why this information is needed and what it will be used for.
        fields: List of input fields. Each field is a dict with:
            - id: unique identifier for the field (e.g. "fpga_part")
            - label: display label (e.g. "FPGA Part Number")
            - field_type: "text" | "select" | "search_select"
            - options: list of {value, label} dicts for select/search_select types
            - placeholder: hint text
            - recommendations: list of recommended values (shown as suggestions, not defaults)
            - required: boolean (default true)

    Returns:
        A JSON string with the user's responses, keyed by field id.
        If the user hasn't responded yet, returns "WAITING_FOR_USER_INPUT".
    """
    # This tool's actual execution is handled by the task runner
    # which intercepts it and creates an interaction.
    # The return value here is a placeholder.
    return "WAITING_FOR_USER_INPUT"


@tool
def request_approval(
    title: str,
    message: str,
    files: list[dict],
) -> str:
    """Request user approval before creating or modifying files.

    Use this tool when you need to create or modify files and want explicit user consent.
    The files will NOT be written to disk until the user approves.

    Args:
        title: Brief title (e.g. "Create Project Files")
        message: JSON string (same schema as run_vivado approval_request): reason, action,
            optional files array [{path, action, description}].
        files: List of file operations. Each is a dict with:
            - path: file path
            - content: file content (full content for create, new content for modify)
            - description: brief description of the file
            - action: "create" | "modify" | "delete"

    Returns:
        "APPROVED" if the user approved, "REJECTED" if rejected.
    """
    return "WAITING_FOR_APPROVAL"
