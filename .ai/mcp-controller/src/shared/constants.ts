export const TOOL_NAME = "controller.turn";
export const SCHEMA_VERSION = "1.0.0";
export const DEFAULT_DASHBOARD_PORT = 8722;
export const DEFAULT_MAX_TOKENS = 100_000;
export const DEFAULT_BUDGET_THRESHOLD_PERCENT = 0.6;

export const PRE_PLAN_CAPABILITIES = [
  "list",
  "list_allowed_files",
  "read_range",
  "read_symbol",
  "read_neighbors",
  "grep_lexeme",
  "fetch_jira",
  "fetch_swagger",
  "original_prompt",
  "write_tmp",
  "submit_plan",
  "escalate"
] as const;

export const POST_PLAN_CAPABILITIES = [
  ...PRE_PLAN_CAPABILITIES,
  "patch_apply",
  "code_run",
  "side_effect",
  "run_recipe"
] as const;

export const PACK_BLOCKED_COMMANDS = ["patch_apply", "code_run", "side_effect", "run_recipe"] as const;
