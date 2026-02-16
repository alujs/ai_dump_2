import { Project } from "ts-morph";
import { parseTemplate } from "@angular/compiler";

export interface TemplateParseSummary {
  nodes: number;
  errors: string[];
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
