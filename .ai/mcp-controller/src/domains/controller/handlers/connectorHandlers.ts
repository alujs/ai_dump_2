import type { VerbResult, SessionState } from "../types";
import type { ConnectorRegistry, ConnectorArtifact } from "../../connectors/connectorRegistry";
import { sliceJiraTicket } from "../../connectors/jiraTicketSlicer";

export async function handleFetchJira(
  args: Record<string, unknown> | undefined,
  session: SessionState,
  connectors: ConnectorRegistry | undefined
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  if (!connectors) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.error = "ConnectorRegistry is not configured. Jira integration requires JIRA_BASE_URL and a PAT token file. Check .ai/config/base.json for connector settings.";
    return { result, denyReasons };
  }

  const issueKey = String(args?.issueKey ?? "");
  if (!issueKey) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error = "args.issueKey is required but was missing or empty. Supply a Jira issue key (e.g., 'PROJ-123').";
    result.missingFields = ["issueKey"];
    return { result, denyReasons };
  }

  try {
    const artifact = await connectors.fetchJiraIssue(issueKey);
    recordArtifact(session, artifact);

    // Slice the Jira ticket into structured fields [REF:CP-SECTIONS]
    const rawPayload = (artifact.metadata?.payload as Record<string, unknown>) ?? artifact.metadata;
    if (rawPayload && typeof rawPayload === "object") {
      const slice = sliceJiraTicket(rawPayload);
      result.jira = artifact;
      result.jiraSlice = {
        issueKey: slice.issueKey || issueKey,
        issueType: slice.issueType,
        priority: slice.priority,
        status: slice.status,
        summary: slice.summary,
        labels: slice.labels,
        components: slice.components,
        acceptanceCriteria: slice.acceptanceCriteria,
        linkedIssueKeys: slice.linkedIssueKeys,
        extractedLexemes: slice.extractedLexemes,
      };
      // Store slice on session for ContextSignature enrichment
      (session as SessionState & { jiraSlice?: unknown }).jiraSlice = slice;
    } else {
      result.jira = artifact;
    }
  } catch (error) {
    denyReasons.push("PLAN_MISSING_CONTRACT_ANCHOR");
    const msg = error instanceof Error ? error.message : "JIRA_FETCH_FAILED";
    result.jiraError = msg;
    result.error = `Jira fetch failed for issue '${issueKey}': ${msg}. Check that the issue key exists, the Jira base URL is correct, and the PAT token has read access. If this is a network error, retry after verifying connectivity.`;
  }

  return { result, denyReasons };
}

export async function handleFetchSwagger(
  args: Record<string, unknown> | undefined,
  session: SessionState,
  connectors: ConnectorRegistry | undefined
): Promise<VerbResult> {
  const denyReasons: string[] = [];
  const result: Record<string, unknown> = {};

  if (!connectors) {
    denyReasons.push("PLAN_SCOPE_VIOLATION");
    result.error = "ConnectorRegistry is not configured. Swagger integration requires connector settings in .ai/config/base.json.";
    return { result, denyReasons };
  }

  const swaggerRef = String(args?.swaggerRef ?? "");
  if (!swaggerRef) {
    denyReasons.push("PLAN_MISSING_REQUIRED_FIELDS");
    result.error = "args.swaggerRef is required but was missing or empty. Supply a Swagger URL (e.g., 'https://api.example.com/swagger.json') or a local file path.";
    result.missingFields = ["swaggerRef"];
    return { result, denyReasons };
  }

  try {
    const artifact = await connectors.registerSwaggerRef(swaggerRef);
    recordArtifact(session, artifact);
    result.swagger = artifact;
  } catch (error) {
    denyReasons.push("PLAN_MISSING_CONTRACT_ANCHOR");
    const msg = error instanceof Error ? error.message : "SWAGGER_FETCH_FAILED";
    result.swaggerError = msg;
    result.error = `Swagger fetch failed for ref '${swaggerRef}': ${msg}. If this is a URL, verify it's reachable. If a local path, verify the file exists relative to the worktree root.`;
  }

  return { result, denyReasons };
}

function recordArtifact(session: SessionState, artifact: ConnectorArtifact): void {
  if (session.artifacts.some((existing) => existing.ref === artifact.ref)) return;
  session.artifacts.push(artifact);
}
