export const TOOL_NAME = "controller_turn";
export const SCHEMA_VERSION = "1.0.0";
export const DEFAULT_DASHBOARD_PORT = 8722;
export const DEFAULT_MAX_TOKENS = 100_000;
export const DEFAULT_BUDGET_THRESHOLD_PERCENT = 0.6;

export const PRE_PLAN_CAPABILITIES = [
  "list_available_verbs",
  "list_scoped_files",
  "list_directory_contents",
  "read_file_lines",
  "lookup_symbol_definition",
  "trace_symbol_graph",
  "search_codebase_text",
  "fetch_jira_ticket",
  "fetch_api_spec",
  "get_original_prompt",
  "write_scratch_file",
  "submit_execution_plan",
  "request_evidence_guidance",
  "signal_task_complete"
] as const;

export const POST_PLAN_CAPABILITIES = [
  ...PRE_PLAN_CAPABILITIES,
  "apply_code_patch",
  "run_sandboxed_code",
  "execute_gated_side_effect",
  "run_automation_recipe"
] as const;

export const PACK_BLOCKED_COMMANDS = ["apply_code_patch", "run_sandboxed_code", "execute_gated_side_effect", "run_automation_recipe"] as const;
