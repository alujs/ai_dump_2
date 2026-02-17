export type AstCodemodId =
  | "rename_identifier_in_file"
  | "update_import_specifier"
  | "update_route_path_literal"
  | "rewrite_template_tag";

export interface AstCodemodDescriptor {
  id: AstCodemodId;
  title: string;
  description: string;
  targetFileKinds: Array<"ts" | "js" | "html">;
  requiredParams: string[];
  citationToken: string;
}

export const AST_CODEMOD_CATALOG: AstCodemodDescriptor[] = [
  {
    id: "rename_identifier_in_file",
    title: "Rename Identifier In File",
    description: "Renames identifier tokens in a single TS/JS file from one exact symbol to another.",
    targetFileKinds: ["ts", "js"],
    requiredParams: ["from", "to"],
    citationToken: "codemod:rename_identifier_in_file"
  },
  {
    id: "update_import_specifier",
    title: "Update Import Specifier",
    description: "Renames named imports for a specific module specifier in a TS/JS file.",
    targetFileKinds: ["ts", "js"],
    requiredParams: ["moduleSpecifier", "from", "to"],
    citationToken: "codemod:update_import_specifier"
  },
  {
    id: "update_route_path_literal",
    title: "Update Route Path Literal",
    description: "Rewrites Angular route object path literals from one path string to another.",
    targetFileKinds: ["ts", "js"],
    requiredParams: ["fromPath", "toPath"],
    citationToken: "codemod:update_route_path_literal"
  },
  {
    id: "rewrite_template_tag",
    title: "Rewrite Template Tag",
    description: "Renames HTML tag names inside Angular templates with parse validation before/after.",
    targetFileKinds: ["html"],
    requiredParams: ["fromTag", "toTag"],
    citationToken: "codemod:rewrite_template_tag"
  }
];

/* ── Runtime registry for custom codemods ─────────────────── */

const customCodemods = new Map<string, AstCodemodDescriptor>();

/**
 * Register a custom codemod at runtime.
 * Custom codemods go through the same sandbox verification as built-in ones
 * but are not hardcoded — they can be added by memory records, seed data,
 * or future agent-authored transforms.
 */
export function registerCustomCodemod(descriptor: AstCodemodDescriptor): void {
  customCodemods.set(descriptor.id, descriptor);
}

export function isSupportedAstCodemodId(value: string): value is AstCodemodId {
  return AST_CODEMOD_CATALOG.some((item) => item.id === value) || customCodemods.has(value);
}

export function codemodCitationToken(codemodId: string): string {
  const found = AST_CODEMOD_CATALOG.find((item) => item.id === codemodId)
    ?? customCodemods.get(codemodId);
  if (!found) {
    return `codemod:${codemodId}`;
  }
  return found.citationToken;
}

export function resolveCodemodDescriptor(codemodId: string): AstCodemodDescriptor | undefined {
  return AST_CODEMOD_CATALOG.find((item) => item.id === codemodId)
    ?? customCodemods.get(codemodId);
}

export function listAstCodemods(): AstCodemodDescriptor[] {
  const builtIn = AST_CODEMOD_CATALOG.map((item) => ({ ...item, targetFileKinds: [...item.targetFileKinds], requiredParams: [...item.requiredParams] }));
  const custom = [...customCodemods.values()].map((item) => ({ ...item, targetFileKinds: [...item.targetFileKinds], requiredParams: [...item.requiredParams] }));
  return [...builtIn, ...custom];
}

export function listCustomCodemods(): AstCodemodDescriptor[] {
  return [...customCodemods.values()];
}

export function clearCustomCodemods(): void {
  customCodemods.clear();
}
