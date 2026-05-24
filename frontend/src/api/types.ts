export type ID = string

export interface Project {
  id: ID
  name: string
  status?: string
  root_path: string
  manifest_path: string
  xpr_path?: string
  part?: string | null
  board_part?: string | null
  top_module?: string | null
  created_at?: number
  updated_at?: number
  last_active_at?: number | null
  session_count?: number
  run_count?: number
  problem_count?: number
  default_vivado_target_id?: string | null
  metadata_json?: string | null
}

export interface Session {
  id: ID
  project_id?: ID
  project_snapshot_json?: string | null
  name: string
  status?: 'idle' | 'running' | 'stopping' | 'stopped' | 'error' | 'archived' | string
  created_at?: number
  updated_at?: number
  archived_at?: number | null
  deleted_at?: number | null
  last_message_preview?: string | null
  message_count?: number
  task_count?: number
  tool_call_count?: number
  problem_count?: number
  token_input?: number
  token_output?: number
  total_cost?: number | null
  metadata_json?: string | null
  migration_candidates?: Pick<Project, 'id' | 'name' | 'root_path' | 'manifest_path'>[]
  migration_hint?: Record<string, string>
}

export interface Message {
  id: ID
  session_id: ID
  task_id?: ID | null
  agent_id?: ID | null
  role: 'user' | 'assistant' | 'system' | string
  content: string
  content_summary?: string | null
  stopped?: number | boolean
  partial?: number | boolean
  created_at?: number
  metadata_json?: string | null
}

export interface Task {
  id: ID
  session_id: ID
  user_message_id?: ID | null
  state: 'created' | 'running' | 'stopping' | 'stopped' | 'done' | 'error' | string
  stop_requested?: number | boolean
  started_at?: number
  updated_at?: number
  finished_at?: number | null
  error?: string | null
  active_run_id?: ID | null
}

export interface SessionEvent {
  id: ID
  session_id: ID
  task_id?: ID | null
  run_id?: ID | null
  parent_run_id?: ID | null
  agent_id?: ID | null
  seq: number
  event_type: string
  created_at: number
  payload_json?: string | null
  payload?: Record<string, unknown>
  artifact_id?: ID | null
  visibility?: string
  /** Event envelope v1 — set by backend enrich_wire_event */
  protocol_version?: number
  canonical_type?: string
}

export interface Run {
  id: ID
  session_id?: ID | null
  task_id?: ID | null
  parent_run_id?: ID | null
  agent_id?: ID | null
  run_type: string
  name: string
  state: string
  started_at?: number
  finished_at?: number | null
  elapsed_ms?: number | null
  error?: string | null
  input_summary?: string | null
  output_summary?: string | null
  artifact_id?: ID | null
  metadata_json?: string | null
}

export interface ToolCall {
  id: ID
  run_id: ID
  session_id?: ID | null
  task_id?: ID | null
  agent_id?: ID | null
  tool_name: string
  state: string
  started_at?: number
  finished_at?: number | null
  elapsed_ms?: number | null
  input_summary?: string | null
  output_summary?: string | null
  input_artifact_id?: ID | null
  output_artifact_id?: ID | null
  error?: string | null
}

export interface Usage {
  id: ID
  run_id: ID
  session_id?: ID | null
  task_id?: ID | null
  provider?: string | null
  model: string
  model_role?: string
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  cost_total?: number | null
  usage_source?: string
  created_at?: number
}

export interface Problem {
  id: ID
  session_id?: ID | null
  task_id?: ID | null
  run_id?: ID | null
  source: string
  severity?: string | null
  category?: string | null
  signature?: string | null
  message: string
  detected_at?: number
}

export interface Artifact {
  id: ID
  session_id?: ID | null
  task_id?: ID | null
  run_id?: ID | null
  artifact_type: string
  path: string
  summary?: string | null
  created_at?: number
}

export interface ContextPackage {
  id: ID
  session_id: ID
  task_id?: ID | null
  run_id?: ID | null
  model?: string | null
  max_context_tokens?: number
  total_tokens?: number
  memory_tokens?: number
  recent_message_tokens?: number
  error_kb_tokens?: number
  semantic_kb_tokens?: number
  tool_summary_tokens?: number
  truncated?: number | boolean
  created_at?: number
}

export interface ContextPackageItem {
  id: ID
  context_package_id: ID
  item_type: string
  title?: string
  content_summary?: string
  token_count?: number
  priority?: number
  included?: number | boolean
  truncation_reason?: string | null
  authority_score?: number | null
  trust_score?: number | null
  relevance_score?: number | null
}

export interface RetrievalAudit {
  id: ID
  session_id?: ID | null
  task_id?: ID | null
  run_id?: ID | null
  query: string
  rewritten_query?: string | null
  candidate_count?: number
  selected_count?: number
  token_budget?: number
  token_used?: number
  created_at?: number
}

export interface RetrievalAuditItem {
  id: ID
  retrieval_audit_id: ID
  source_type: string
  title?: string
  excerpt?: string
  final_score?: number | null
  authority_score?: number | null
  trust_score?: number | null
  selected?: number | boolean
}

export interface VivadoHealth {
  target?: string
  host?: string
  reachable?: boolean
  vivado_path?: string
  version?: string | null
  error?: string
  [key: string]: unknown
}

export interface ApiErrorShape {
  error?: string
  detail?: string
  message?: string
  [key: string]: unknown
}
