# Synthia MCP Server

External agents (Cursor, Claude Code, opencode, custom bots) can drive Synthia via MCP.

## Setup

1. Create a service account on the Synthia server:

```bash
edagent admin create-user synthia-mcp --service-account --role fpga_engineer
# copy the printed API token
```

2. Install Synthia with the MCP extra (on the machine that runs the MCP server):

```bash
pip install -e ".[mcp]"
```

3. Export environment variables:

```bash
export SYNTHIA_BASE_URL=http://127.0.0.1:8484
export SYNTHIA_MCP_TOKEN=<token from step 1>
```

4. Test:

```bash
synthia-mcp   # blocks on stdio (MCP frames on stdout)
```

## Cursor

Copy `apps/mcp/cursor-config.json` to `~/.cursor/mcp.json` and replace the token.

Restart Cursor; tools appear as `synthia_*` in the agent tool list.

## Available tools

| Tool | Description |
|------|-------------|
| `synthia_list_projects` | List projects |
| `synthia_get_project` | Project detail |
| `synthia_import_xpr` | Import `.xpr` |
| `synthia_scan_project` | Re-scan project root |
| `synthia_run_synthesis` | Start synth (`vivado/commands/flow`) |
| `synthia_run_implementation` | Synth + impl |
| `synthia_generate_bitstream` | Full flow incl. bitstream |
| `synthia_get_run` | Run state + steps |
| `synthia_cancel_run` | Stop run |
| `synthia_get_reports` | Parsed reports |
| `synthia_get_artifacts` | Artifact list |
| `synthia_get_run_summary` | Markdown summary |
| `synthia_get_project_trend` | Project metrics trend |
| `synthia_request_patch` | Propose patch |
| `synthia_get_patch` | Patch status + diff |
| `synthia_approve_patch` | Approve (if permitted) |
| `synthia_reject_patch` | Reject |
| `synthia_diagnose_log` | Log diagnosis via KB |

## API mapping notes

The MCP client maps handbook-friendly names to the real Synthia API:

- Runs are created via `POST /api/v1/vivado/commands/flow` (not a per-project `/runs` route).
- Run status uses `GET /api/v1/monitor/runs/{run_id}`.
- Cancel uses `POST /api/v1/runs/{run_id}/stop`.
- Reports use `GET /api/v1/runs/{run_id}/reports`.
- Scan uses `POST /api/v1/projects/scan` with the project's `root_path`.

## Permissions

The MCP server inherits the service-account user's role.

- **fpga_engineer**: run flows, propose patches, approve low-risk
- **reviewer**: approve high-risk patches (not recommended for unattended bots)
- **viewer**: read-only

High-risk operations may return `{needs_approval: true}` — pause and ask the user to approve in the Synthia UI.

## HTTP transport (optional)

```bash
SYNTHIA_MCP_TRANSPORT=http SYNTHIA_MCP_PORT=8485 synthia-mcp
```

## Troubleshooting

- `SYNTHIA_MCP_TOKEN not set` — export the token before launching `synthia-mcp`.
- `{denied: true}` — service account lacks role; ask admin to update membership.
- Tools time out — check `SYNTHIA_BASE_URL` and that `edagent web` is running.
- `Bearer token rejected` — rotate via `edagent admin rotate-token`.
