# Eval set fixtures

Static regression cases the upcoming `edagent eval` runner will replay against the
agent to detect quality drift. **SE-PR6 ships the schema, the loader, and the CLI
wrapper only — the runner that actually executes the cases lands in a later PR.**
For now `edagent eval` and `POST /api/v1/evolution/eval/run` insert a row into
`eval_runs` with `state='placeholder'` and emit `evolution.eval.queued`; nothing
runs against the LLM.

## File layout

```
tests/eval_set/
  README.md           ← this file
  smoke.yaml          ← minimal sanity cases
  vivado_synth.yaml   ← synthesis-error diagnosis cases
```

Each YAML file is one *eval set*. The loader picks the file's basename (without
extension) as the eval-set name; `smoke.yaml` → `smoke`. Filenames must be
lowercase ASCII + `[a-z0-9_-]`.

## Schema

```yaml
name: smoke              # required, must match the filename stem
description: short text  # optional
cases:
  - id: kb-recurrence-uart       # required, unique within file
    question: |
      ...natural-language question the agent receives...
    project_id: optional          # if set, the runner uses this project's overlays
    expected:                     # optional, runner uses for pass/fail scoring
      contains: ["WNS", "timing"] # all of these substrings must appear in the answer
      not_contains: ["TODO"]      # none of these may appear
      tool_calls_any:             # any one of these tools must have been called
        - parse_timing_tool
      tool_calls_all: []          # if set, every listed tool must have been called
      max_task_tokens: 8000       # composite_score penalised when exceeded
      min_first_run_success: null # leave null when not a Vivado run case
    metadata: {}                  # free-form (tags, owner, related candidate id)
```

Fields the runner will read once it exists are listed for forward compatibility;
the SE-PR6 loader only enforces `name`, `cases`, `cases[].id`, `cases[].question`
plus the lowercase/unique constraints.

## CLI usage

```
edagent eval                 # list available eval sets
edagent eval smoke           # queue a placeholder run (no LLM call)
edagent eval smoke --project-id <id>   # tag the queued run with a project
edagent eval --status running  # filter the list view by state
```

## API usage

```
GET    /api/v1/evolution/eval/sets               -> available eval sets + case counts
GET    /api/v1/evolution/eval/sets/{name}        -> single eval set with cases
GET    /api/v1/evolution/eval/runs?eval_set=&state=&limit=
GET    /api/v1/evolution/eval/runs/{id}
POST   /api/v1/evolution/eval/run                -> queue a placeholder eval_run
```

`POST /eval/run` accepts:

```json
{
  "eval_set": "smoke",
  "project_id": "optional-project-id",
  "overlay_id": "optional-overlay-id",
  "note": "free-form audit string"
}
```

It returns 200 with `state="placeholder"` and `runner_implemented=false`. When
the real runner ships, the same endpoint will transition rows from
`placeholder` → `queued` → `running` → `completed|error` and stream
`evolution.eval.*` events.
