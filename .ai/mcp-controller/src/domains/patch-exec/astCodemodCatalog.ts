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

export function isSupportedAstCodemodId(value: string): value is AstCodemodId {
  return AST_CODEMOD_CATALOG.some((item) => item.id === value);
}

export function codemodCitationToken(codemodId: string): string {
  const found = AST_CODEMOD_CATALOG.find((item) => item.id === codemodId);
  if (!found) {
    return `codemod:${codemodId}`;
  }
  return found.citationToken;
}

export function listAstCodemods(): AstCodemodDescriptor[] {
  return AST_CODEMOD_CATALOG.map((item) => ({ ...item, targetFileKinds: [...item.targetFileKinds], requiredParams: [...item.requiredParams] }));
}
