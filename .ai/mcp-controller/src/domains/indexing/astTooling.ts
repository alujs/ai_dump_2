import { Project } from "ts-morph";
import { parseTemplate, type TmplAstElement } from "@angular/compiler";

export interface TemplateParseSummary {
  nodes: number;
  errors: string[];
}

/** Component tag usage fact extracted from an Angular template */
export interface TemplateTagUsage {
  tag: string;
  line: number;
  attributes: string[];
  isAdp: boolean;
  isSdf: boolean;
}

/** RouterLink reference extracted from an Angular template */
export interface TemplateRouterLink {
  /** The literal route path value (e.g. "/login", "/profile/{{username}}") */
  routePath: string;
  /** Line number (0-based) */
  line: number;
  /** The host element tag (e.g. "a", "button", "adp-link") */
  hostTag: string;
  /** Whether the value was from a static attribute vs a bound [routerLink] */
  isBound: boolean;
}

/** Template-level navigation facts: routerLink values + router-outlet presence */
export interface TemplateNavFacts {
  routerLinks: TemplateRouterLink[];
  hasRouterOutlet: boolean;
}

export function createTsMorphProject(tsConfigFilePath: string): Project {
  return new Project({
    tsConfigFilePath
  });
}

export function parseAngularTemplate(templateSource: string): TemplateParseSummary {
  const result = parseTemplate(templateSource, "inline-template");
  const errors = result.errors ?? [];
  return {
    nodes: result.nodes.length,
    errors: errors.map((error) => error.toString())
  };
}

/**
 * Phase 4: Parse an Angular template and extract component tag usage facts.
 * Focuses on adp-* and sdf-* tags but captures all custom element tags.
 */
export function parseAngularTemplateUsage(
  templateSource: string,
  filePath: string,
): Array<{ tag: string; filePath: string; line: number; attributes: string[]; isAdp: boolean; isSdf: boolean }> {
  const facts: Array<{ tag: string; filePath: string; line: number; attributes: string[]; isAdp: boolean; isSdf: boolean }> = [];

  try {
    const result = parseTemplate(templateSource, filePath);
    collectElementUsage(result.nodes, filePath, facts);
  } catch {
    // Template parse failures are non-fatal — return empty
  }

  return facts;
}

function collectElementUsage(
  nodes: unknown[],
  filePath: string,
  facts: Array<{ tag: string; filePath: string; line: number; attributes: string[]; isAdp: boolean; isSdf: boolean }>,
): void {
  for (const node of nodes) {
    if (isTemplateElement(node)) {
      const tag = node.name;
      // Only capture custom elements (contain a hyphen) to filter out native HTML
      if (tag.includes("-")) {
        const attrs = (node.attributes ?? []).map((a: { name: string }) => a.name);
        facts.push({
          tag,
          filePath,
          line: node.sourceSpan?.start?.line ?? 0,
          attributes: attrs,
          isAdp: tag.startsWith("adp-"),
          isSdf: tag.startsWith("sdf-"),
        });
      }
      // Recurse into children
      if (Array.isArray(node.children)) {
        collectElementUsage(node.children, filePath, facts);
      }
    }
    // Handle template nodes (ng-template, ng-container, etc.) that might have children
    if (node && typeof node === "object" && "children" in node && Array.isArray((node as { children: unknown[] }).children)) {
      if (!isTemplateElement(node)) {
        collectElementUsage((node as { children: unknown[] }).children, filePath, facts);
      }
    }
  }
}

function isTemplateElement(node: unknown): node is TmplAstElement {
  return node !== null
    && typeof node === "object"
    && "name" in node
    && typeof (node as TmplAstElement).name === "string"
    && "attributes" in node;
}

/* ── Phase 5: Template navigation fact extraction ────────── */

/**
 * Parse an Angular template and extract navigation-related facts:
 * - routerLink / [routerLink] attribute values → route path references
 * - <router-outlet> presence → marks component as a route host
 */
export function parseAngularTemplateNav(
  templateSource: string,
  filePath: string,
): TemplateNavFacts {
  const result: TemplateNavFacts = {
    routerLinks: [],
    hasRouterOutlet: false,
  };

  try {
    const parsed = parseTemplate(templateSource, filePath);
    collectNavFacts(parsed.nodes, result);
  } catch {
    // Template parse failures are non-fatal
  }

  return result;
}

function collectNavFacts(nodes: unknown[], result: TemplateNavFacts): void {
  for (const node of nodes) {
    if (isTemplateElement(node)) {
      const tag = node.name;

      // Detect <router-outlet>
      if (tag === "router-outlet") {
        result.hasRouterOutlet = true;
      }

      // Check static attributes for routerLink="..."
      for (const attr of (node.attributes ?? [])) {
        if (attr && typeof attr === "object" && "name" in attr && "value" in attr) {
          const attrName = (attr as { name: string }).name;
          const attrValue = (attr as { value: string }).value;
          if (attrName === "routerLink" && attrValue) {
            result.routerLinks.push({
              routePath: attrValue,
              line: node.sourceSpan?.start?.line ?? 0,
              hostTag: tag,
              isBound: false,
            });
          }
        }
      }

      // Check bound attributes / inputs for [routerLink]="..."
      // In @angular/compiler AST, bound attributes are in node.inputs
      if ("inputs" in node && Array.isArray((node as { inputs: unknown[] }).inputs)) {
        for (const input of (node as { inputs: unknown[] }).inputs) {
          if (input && typeof input === "object" && "name" in input) {
            const inputName = (input as { name: string }).name;
            if (inputName === "routerLink") {
              // Try to extract the literal value from the bound expression
              const rawValue = extractBoundRouterLinkValue(input);
              if (rawValue) {
                result.routerLinks.push({
                  routePath: rawValue,
                  line: node.sourceSpan?.start?.line ?? 0,
                  hostTag: tag,
                  isBound: true,
                });
              }
            }
          }
        }
      }

      // Recurse into children
      if (Array.isArray(node.children)) {
        collectNavFacts(node.children, result);
      }
    }
    // Handle template nodes (ng-template, ng-container, etc.)
    if (node && typeof node === "object" && "children" in node && Array.isArray((node as { children: unknown[] }).children)) {
      if (!isTemplateElement(node)) {
        collectNavFacts((node as { children: unknown[] }).children, result);
      }
    }
  }
}

/**
 * Attempt to extract a literal string value from a [routerLink] binding.
 * Handles: `[routerLink]="'/login'"` or `[routerLink]="['/profile', username]"`.
 * For array forms, extracts only the first literal segment.
 * Returns null for fully dynamic expressions.
 */
function extractBoundRouterLinkValue(input: unknown): string | null {
  // The @angular/compiler AST stores the expression source in `value.source`
  // or the AST expression in `value.ast`
  if (!input || typeof input !== "object") return null;

  // Try to get the raw expression source text
  const inputObj = input as Record<string, unknown>;
  const value = inputObj.value;
  if (!value || typeof value !== "object") return null;

  const valueObj = value as Record<string, unknown>;
  const source = valueObj.source;
  if (typeof source === "string") {
    return parseRouterLinkExpression(source);
  }

  return null;
}

/**
 * Parse a routerLink expression string to extract the route path.
 * Examples:
 *   `'/login'` → "/login"
 *   `['/profile', username]` → "/profile"
 *   `variable` → null (too dynamic)
 */
function parseRouterLinkExpression(expr: string): string | null {
  const trimmed = expr.trim();

  // Simple string literal: '/login' or "/login"
  const stringMatch = trimmed.match(/^['"](.+?)['"]$/);
  if (stringMatch) {
    return stringMatch[1];
  }

  // Array literal: ['/profile', ...] — extract first string element
  const arrayMatch = trimmed.match(/^\[['"](.+?)['"]/);
  if (arrayMatch) {
    return arrayMatch[1];
  }

  return null;
}

