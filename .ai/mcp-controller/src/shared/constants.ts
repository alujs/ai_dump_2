export const TOOL_NAME = "controller_turn";
export const SCHEMA_VERSION = "2.0.0";
export const DEFAULT_DASHBOARD_PORT = 8722;
export const DEFAULT_MAX_TOKENS = 100_000;
export const DEFAULT_BUDGET_THRESHOLD_PERCENT = 0.6;

export const UNINITIALIZED_CAPABILITIES = ["initialize_work"] as const;

export const PRE_PLAN_CAPABILITIES = [
  "read_file_lines",
  "lookup_symbol_definition",
  "trace_symbol_graph",
  "search_codebase_text",
  "write_scratch_file",
  "submit_execution_plan",
  "escalate",
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
