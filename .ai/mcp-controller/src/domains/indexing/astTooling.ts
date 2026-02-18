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
