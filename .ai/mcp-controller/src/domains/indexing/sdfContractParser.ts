/**
 * Phase 4: SDF Contract Parser
 *
 * Parses SDF `components.d.ts` declarations into Component + Prop
 * graph node shapes suitable for seed ingestion.
 *
 * The parser extracts:
 *   - Component nodes: tag name, description
 *   - Prop nodes: name, type, required flag, linked to parent component
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createTsMorphProject } from "./astTooling";

export interface SdfComponentContract {
  tag: string;
  description: string;
  props: SdfPropContract[];
}

export interface SdfPropContract {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/**
 * Parse an SDF components.d.ts file into structured component contracts.
 * Falls back gracefully if the file doesn't exist or can't be parsed.
 */
export async function parseSdfContracts(
  contractFilePath: string,
): Promise<SdfComponentContract[]> {
  if (!existsSync(contractFilePath)) {
    return [];
  }

  const contracts: SdfComponentContract[] = [];

  try {
    const source = await readFile(contractFilePath, "utf8");
    contracts.push(...parseContractsFromSource(source, contractFilePath));
  } catch {
    // Parse failures are non-fatal
  }

  return contracts;
}

/**
 * Parse contract source text using ts-morph AST analysis.
 * Looks for interfaces named like `Sdf*Props` or `Sdf*Attributes`
 * and extracts their properties as prop contracts.
 */
export function parseContractsFromSource(
  source: string,
  filePath: string,
): SdfComponentContract[] {
  const contracts: SdfComponentContract[] = [];

  try {
    const project = createTsMorphProject(filePath);
    const sourceFile = project.createSourceFile("__sdf_contracts__.d.ts", source, { overwrite: true });

    for (const iface of sourceFile.getInterfaces()) {
      const name = iface.getName();
      if (!name) continue;

      // Match interfaces like SdfAlertProps, SdfButtonAttributes, etc.
      const tagMatch = name.match(/^Sdf([A-Z][a-zA-Z]*?)(Props|Attributes|Config)$/);
      if (!tagMatch) continue;

      const componentName = tagMatch[1];
      const tag = `sdf-${camelToKebab(componentName)}`;
      const description = extractJsDocDescription(iface.getJsDocs().map((d) => d.getDescription()).join(" "));

      const props: SdfPropContract[] = [];
      for (const prop of iface.getProperties()) {
        const propName = prop.getName();
        const propType = prop.getType().getText() ?? "unknown";
        const required = !prop.hasQuestionToken();
        const propDesc = extractJsDocDescription(
          prop.getJsDocs().map((d) => d.getDescription()).join(" ")
        );

        props.push({
          name: propName,
          type: propType,
          required,
          description: propDesc,
        });
      }

      contracts.push({ tag, description, props });
    }
  } catch {
    // ts-morph failures are non-fatal — fall back to regex parsing
    contracts.push(...parseContractsFromRegex(source));
  }

  // If ts-morph found nothing, try regex
  if (contracts.length === 0) {
    contracts.push(...parseContractsFromRegex(source));
  }

  return contracts;
}

/**
 * Fallback regex-based parser for when ts-morph can't process the file.
 * Extracts interface names and their property declarations.
 */
function parseContractsFromRegex(source: string): SdfComponentContract[] {
  const contracts: SdfComponentContract[] = [];
  const interfacePattern = /interface\s+(Sdf[A-Z][a-zA-Z]*?)(Props|Attributes|Config)\s*\{([^}]*)\}/g;

  let match: RegExpExecArray | null;
  while ((match = interfacePattern.exec(source)) !== null) {
    const componentName = match[1];
    const tag = `sdf-${camelToKebab(componentName)}`;
    const body = match[3];

    const props: SdfPropContract[] = [];
    const propPattern = /(\w+)(\?)?\s*:\s*([^;]+)/g;
    let propMatch: RegExpExecArray | null;
    while ((propMatch = propPattern.exec(body)) !== null) {
      props.push({
        name: propMatch[1],
        type: propMatch[3].trim(),
        required: !propMatch[2],
        description: "",
      });
    }

    contracts.push({ tag, description: "", props });
  }

  return contracts;
}

/**
 * Convert contracts to JSONL seed rows for graph ingestion.
 * Produces Component nodes and Prop nodes with HAS_PROP relationships.
 */
export function contractsToSeedRows(
  contracts: SdfComponentContract[],
): Array<{ kind: string; [key: string]: unknown }> {
  const rows: Array<{ kind: string; [key: string]: unknown }> = [];
  const now = new Date().toISOString();

  for (const contract of contracts) {
    // Component node
    rows.push({
      kind: "node",
      id: `component:${contract.tag}`,
      labels: ["Component"],
      properties: {
        id: `component:${contract.tag}`,
        tag: contract.tag,
        description: contract.description,
        library: "sdf",
        version: 1,
        updated_at: now,
        updated_by: "sdf_contract_parser",
      },
    });

    // Prop nodes + relationships
    for (const prop of contract.props) {
      const propId = `prop:${contract.tag}:${prop.name}`;
      rows.push({
        kind: "node",
        id: propId,
        labels: ["Prop"],
        properties: {
          id: propId,
          name: prop.name,
          type: prop.type,
          required: prop.required,
          description: prop.description,
          componentTag: contract.tag,
        },
      });

      rows.push({
        kind: "relationship",
        from: `component:${contract.tag}`,
        to: propId,
        type: "HAS_PROP",
        properties: {},
      });
    }
  }

  return rows;
}

/* ── Helpers ──────────────────────────────────────────────── */

function camelToKebab(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function extractJsDocDescription(raw: string): string {
  return raw.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}
