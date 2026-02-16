export interface BrowserAutomationTask {
  id: string;
  url: string;
  action: "inspect" | "click" | "type" | "snapshot";
  selectors?: string[];
  payload?: Record<string, unknown>;
}

export interface BrowserAutomationResult {
  taskId: string;
  ok: boolean;
  artifactRefs: string[];
  notes: string[];
}

export function ensureBrowserAutomationEnabled(enabled: boolean): void {
  if (!enabled) {
    throw new Error("BROWSER_AUTOMATION_DISABLED");
  }
}
