/**
 * Jira Ticket Slicer — parses a raw Jira API response into structured fields
 * that feed ContextSignature, strategy selection, and the context pack TaskSpec.
 *
 * [REF:CP-SECTIONS] TaskSpec requires: quoted constraints + normalized AC + conflicts
 * [REF:CONTEXTSIGNATURE] requires: jiraFields for feature detection
 */

export interface JiraTicketSlice {
  /** Issue key (e.g. "PROJ-123") */
  issueKey: string;
  /** Issue type (Bug, Story, Task, etc.) */
  issueType: string;
  /** Priority */
  priority: string;
  /** Status */
  status: string;
  /** Summary line */
  summary: string;
  /** Full description (may be Atlassian wiki markup) */
  description: string;
  /** Labels */
  labels: string[];
  /** Component names */
  components: string[];
  /** Acceptance criteria extracted from description */
  acceptanceCriteria: string[];
  /** Linked issue keys */
  linkedIssueKeys: string[];
  /** Extracted lexemes from the ticket text */
  extractedLexemes: string[];
  /** Raw fields for full preservation */
  rawFields: Record<string, unknown>;
}

/**
 * Slice a raw Jira API response (from /rest/api/2/issue/) into structured fields.
 */
export function sliceJiraTicket(raw: Record<string, unknown>): JiraTicketSlice {
  const fields = asRecord(raw.fields) ?? asRecord(raw);
  const key = String(raw.key ?? raw.issueKey ?? fields.key ?? "");

  const issueType = extractNestedName(fields.issuetype) ?? extractNestedName(fields.issueType) ?? "";
  const priority = extractNestedName(fields.priority) ?? "";
  const status = extractNestedName(fields.status) ?? "";
  const summary = String(fields.summary ?? "");
  const description = String(fields.description ?? "");
  const labels = asStringArray(fields.labels) ?? [];
  const components = extractComponentNames(fields.components);
  const linkedIssueKeys = extractLinkedIssueKeys(fields.issuelinks ?? fields.issueLinks);
  const acceptanceCriteria = extractAcceptanceCriteria(description);
  const extractedLexemes = extractLexemesFromTicket(summary, description, labels, components);

  return {
    issueKey: key,
    issueType,
    priority,
    status,
    summary,
    description,
    labels,
    components,
    acceptanceCriteria,
    linkedIssueKeys,
    extractedLexemes,
    rawFields: fields,
  };
}

/**
 * Convert a JiraTicketSlice into fields suitable for ContextSignatureInput.jiraFields
 */
export function toContextSignatureFields(slice: JiraTicketSlice): {
  issueType: string;
  labels: string[];
  components: string[];
  summary: string;
  description: string;
} {
  return {
    issueType: slice.issueType,
    labels: slice.labels,
    components: slice.components,
    summary: slice.summary,
    description: slice.description,
  };
}

/* ── Internal helpers ────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item));
}

function extractNestedName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return undefined;
  return String(rec.name ?? rec.value ?? rec.displayName ?? "");
}

function extractComponentNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      const rec = asRecord(item);
      return rec ? String(rec.name ?? "") : "";
    })
    .filter((name) => name.length > 0);
}

function extractLinkedIssueKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const link of value) {
    const rec = asRecord(link);
    if (!rec) continue;
    const inward = asRecord(rec.inwardIssue);
    const outward = asRecord(rec.outwardIssue);
    if (inward?.key) keys.push(String(inward.key));
    if (outward?.key) keys.push(String(outward.key));
  }
  return keys;
}

/**
 * Extract acceptance criteria from Jira description text.
 * Looks for common patterns: "AC:", "Acceptance Criteria:", numbered lists after AC headers.
 */
function extractAcceptanceCriteria(description: string): string[] {
  if (!description) return [];
  const criteria: string[] = [];

  // Pattern 1: "Acceptance Criteria" or "AC" section header
  const acPattern = /(?:acceptance\s+criteria|^ac)\s*:?/im;
  const match = acPattern.exec(description);
  if (match) {
    const afterAc = description.slice(match.index + match[0].length);
    // Collect bullet/numbered items, skipping leading blank lines
    const lines = afterAc.split("\n");
    let foundContent = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        if (foundContent) break; // blank line AFTER content ends AC section
        continue; // skip leading blank lines
      }
      if (/^(?:#{1,3}\s|[A-Z][a-z]+:)/.test(trimmed) && foundContent) break; // new section header
      // Remove bullet/number prefix
      const cleaned = trimmed.replace(/^[-*•]\s*|^\d+[.)]\s*/, "").trim();
      if (cleaned.length > 0) {
        criteria.push(cleaned);
        foundContent = true;
      }
    }
  }

  // Pattern 2: "Given/When/Then" BDD style
  const gwtPattern = /(?:given|when|then)\s+.+/gi;
  let gwtMatch;
  while ((gwtMatch = gwtPattern.exec(description)) !== null) {
    const cleaned = gwtMatch[0].trim();
    if (!criteria.includes(cleaned)) {
      criteria.push(cleaned);
    }
  }

  return criteria;
}

/**
 * Extract meaningful lexemes from ticket text for retrieval lane seeding.
 * Focuses on: code identifiers, file paths, route segments, component names.
 */
function extractLexemesFromTicket(
  summary: string,
  description: string,
  labels: string[],
  components: string[],
): string[] {
  const text = `${summary}\n${description}\n${labels.join(" ")}\n${components.join(" ")}`;
  const lexemes = new Set<string>();

  // Pattern: backtick-quoted identifiers (code references in tickets)
  const codeRefs = text.matchAll(/`([^`]+)`/g);
  for (const match of codeRefs) {
    lexemes.add(match[1].trim().toLowerCase());
  }

  // Pattern: file paths (src/foo/bar.ts, apps/dashboard/etc)
  const filePaths = text.matchAll(/(?:src|apps|libs|projects|packages)\/[\w/.-]+/g);
  for (const match of filePaths) {
    lexemes.add(match[0].toLowerCase());
  }

  // Pattern: route segments (/foo/bar, /dashboard/detail)
  const routes = text.matchAll(/\/[a-z][a-z0-9/-]{2,}/gi);
  for (const match of routes) {
    lexemes.add(match[0].toLowerCase());
  }

  // Pattern: Angular selectors (app-foo, sdf-bar, adp-baz)
  const selectors = text.matchAll(/(?:app|sdf|adp)-[a-z][a-z0-9-]+/gi);
  for (const match of selectors) {
    lexemes.add(match[0].toLowerCase());
  }

  // Pattern: PascalCase identifiers (component/class names)
  const pascal = text.matchAll(/\b[A-Z][a-z]+(?:[A-Z][a-z]+){1,}\b/g);
  for (const match of pascal) {
    lexemes.add(match[0].toLowerCase());
  }

  // Labels and components as-is
  for (const label of labels) {
    lexemes.add(label.toLowerCase());
  }
  for (const comp of components) {
    lexemes.add(comp.toLowerCase());
  }

  return [...lexemes].filter((l) => l.length > 2);
}
