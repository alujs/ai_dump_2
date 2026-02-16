import path from "node:path";
import { Project, ScriptKind, SyntaxKind } from "ts-morph";
import { parseAngularTemplate } from "../indexing/astTooling";
import { readText, writeText } from "../../shared/fileStore";
import { normalizeSafePath } from "../../shared/fsPaths";
import { replaceWithGuard } from "../../shared/replaceGuard";
import type { ChangePlanNode } from "../../contracts/planGraph";
import {
  AST_CODEMOD_CATALOG,
  type AstCodemodId,
  isSupportedAstCodemodId,
  listAstCodemods
} from "./astCodemodCatalog";

export interface ReplaceTextPatchApplyRequest {
  nodeId: string;
  targetFile: string;
  targetSymbols: string[];
  operation: "replace_text";
  find: string;
  replace: string;
}

export interface AstCodemodPatchApplyRequest {
  nodeId: string;
  targetFile: string;
  targetSymbols: string[];
  operation: "ast_codemod";
  codemodId: string;
  codemodParams: Record<string, unknown>;
}

export type PatchApplyRequest = ReplaceTextPatchApplyRequest | AstCodemodPatchApplyRequest;

export interface PatchApplyResult {
  changed: boolean;
  targetFile: string;
  replacements: number;
  bytesBefore: number;
  bytesAfter: number;
  lineDelta: number;
  operation: "replace_text" | "ast_codemod";
  codemodId?: string;
}

export function listPatchApplyOptions(): {
  replaceText: {
    operation: "replace_text";
    requiredFields: string[];
  };
  astCodemods: ReturnType<typeof listAstCodemods>;
  customCodemodsAllowed: false;
  citationRule: string;
} {
  return {
    replaceText: {
      operation: "replace_text",
      requiredFields: ["nodeId", "targetFile", "targetSymbols", "find", "replace"]
    },
    astCodemods: listAstCodemods(),
    customCodemodsAllowed: false,
    citationRule: "When operation=ast_codemod, change-node citations must include codemod:<codemodId>."
  };
}

export async function applyStructuredPatch(input: {
  worktreeRoot: string;
  request: PatchApplyRequest;
  approvedNode: ChangePlanNode;
}): Promise<PatchApplyResult> {
  validatePatchRequest(input.request, input.approvedNode);

  const safePath = normalizeSafePath(input.worktreeRoot, input.request.targetFile);
  const before = await readText(safePath);

  let after = before;
  let replacements = 0;

  if (input.request.operation === "replace_text") {
    replacements = countOccurrences(before, input.request.find);
    after = replacements > 0 ? before.split(input.request.find).join(input.request.replace) : before;
  } else {
    if (!isSupportedAstCodemodId(input.request.codemodId)) {
      throw new Error("PLAN_POLICY_VIOLATION");
    }
    const codemodResult = applyAstCodemod({
      safePath,
      before,
      codemodId: input.request.codemodId,
      params: input.request.codemodParams
    });
    after = codemodResult.after;
    replacements = codemodResult.replacements;
  }

  if (after !== before) {
    await writeText(safePath, after);
  }

  return {
    changed: after !== before,
    targetFile: safePath,
    replacements,
    bytesBefore: Buffer.byteLength(before, "utf8"),
    bytesAfter: Buffer.byteLength(after, "utf8"),
    lineDelta: lineCount(after) - lineCount(before),
    operation: input.request.operation,
    codemodId: input.request.operation === "ast_codemod" ? input.request.codemodId : undefined
  };
}

function validatePatchRequest(request: PatchApplyRequest, node: ChangePlanNode): void {
  if (request.targetFile !== node.targetFile) {
    throw new Error("PLAN_SCOPE_VIOLATION");
  }
  if (request.targetSymbols.some((symbol) => symbol === "*" || symbol.trim().length === 0)) {
    throw new Error("PLAN_SCOPE_VIOLATION");
  }
  if (request.targetSymbols.some((symbol) => !node.targetSymbols.includes(symbol))) {
    throw new Error("PLAN_SCOPE_VIOLATION");
  }

  if (request.operation === "replace_text") {
    if (request.find.trim().length === 0) {
      throw new Error("PLAN_MISSING_REQUIRED_FIELDS");
    }
    return;
  }

  if (!isSupportedAstCodemodId(request.codemodId)) {
    throw new Error("PLAN_POLICY_VIOLATION");
  }
  const descriptor = AST_CODEMOD_CATALOG.find((item) => item.id === request.codemodId);
  if (!descriptor) {
    throw new Error("PLAN_POLICY_VIOLATION");
  }
  for (const required of descriptor.requiredParams) {
    const value = request.codemodParams[required];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("PLAN_MISSING_REQUIRED_FIELDS");
    }
  }
}

function applyAstCodemod(input: {
  safePath: string;
  before: string;
  codemodId: AstCodemodId;
  params: Record<string, unknown>;
}): { after: string; replacements: number } {
  const kind = inferFileKind(input.safePath);
  const descriptor = AST_CODEMOD_CATALOG.find((item) => item.id === input.codemodId);
  if (!descriptor) {
    throw new Error("PLAN_POLICY_VIOLATION");
  }
  if (!descriptor.targetFileKinds.includes(kind)) {
    throw new Error("PLAN_POLICY_VIOLATION");
  }

  switch (input.codemodId) {
    case "rename_identifier_in_file":
      return applyRenameIdentifier(input.safePath, input.before, input.params);
    case "update_import_specifier":
      return applyUpdateImportSpecifier(input.safePath, input.before, input.params);
    case "update_route_path_literal":
      return applyUpdateRoutePathLiteral(input.safePath, input.before, input.params);
    case "rewrite_template_tag":
      return applyTemplateTagRewrite(input.before, input.params);
    default:
      throw new Error("PLAN_POLICY_VIOLATION");
  }
}

function applyRenameIdentifier(
  safePath: string,
  before: string,
  params: Record<string, unknown>
): { after: string; replacements: number } {
  const from = requiredStringParam(params, "from");
  const to = requiredStringParam(params, "to");
  const sourceFile = createSourceFileForPatch(safePath, before);
  const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
  let replacements = 0;

  for (const identifier of identifiers) {
    if (identifier.getText() !== from) {
      continue;
    }
    identifier.replaceWithText(to);
    replacements += 1;
  }

  return {
    after: sourceFile.getFullText(),
    replacements
  };
}

function applyUpdateImportSpecifier(
  safePath: string,
  before: string,
  params: Record<string, unknown>
): { after: string; replacements: number } {
  const moduleSpecifier = requiredStringParam(params, "moduleSpecifier");
  const from = requiredStringParam(params, "from");
  const to = requiredStringParam(params, "to");
  const sourceFile = createSourceFileForPatch(safePath, before);
  let replacements = 0;

  for (const importDeclaration of sourceFile.getImportDeclarations()) {
    if (importDeclaration.getModuleSpecifierValue() !== moduleSpecifier) {
      continue;
    }
    for (const namedImport of importDeclaration.getNamedImports()) {
      if (namedImport.getName() !== from) {
        continue;
      }
      namedImport.setName(to);
      replacements += 1;
    }
  }

  return {
    after: sourceFile.getFullText(),
    replacements
  };
}

function applyUpdateRoutePathLiteral(
  safePath: string,
  before: string,
  params: Record<string, unknown>
): { after: string; replacements: number } {
  const fromPath = requiredStringParam(params, "fromPath");
  const toPath = requiredStringParam(params, "toPath");
  const sourceFile = createSourceFileForPatch(safePath, before);
  let replacements = 0;

  for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const propertyName = replaceWithGuard(
      property.getNameNode().getText(),
      /['"]/g,
      "",
      "PatchExecService:applyUpdateRoutePathLiteral:property-name"
    );
    if (propertyName !== "path") {
      continue;
    }
    const literal = property.getInitializerIfKind(SyntaxKind.StringLiteral);
    if (!literal) {
      continue;
    }
    if (literal.getLiteralText() !== fromPath) {
      continue;
    }
    literal.setLiteralValue(toPath);
    replacements += 1;
  }

  return {
    after: sourceFile.getFullText(),
    replacements
  };
}

function applyTemplateTagRewrite(
  before: string,
  params: Record<string, unknown>
): { after: string; replacements: number } {
  const fromTag = requiredStringParam(params, "fromTag");
  const toTag = requiredStringParam(params, "toTag");
  const parseBefore = parseAngularTemplate(before);
  if (parseBefore.errors.length > 0) {
    throw new Error("PLAN_VERIFICATION_WEAK");
  }

  const pattern = new RegExp(`(<\\/?\\s*)${escapeRegex(fromTag)}(\\b)`, "g");
  const matches = [...before.matchAll(pattern)];
  const replacements = matches.length;
  if (replacements === 0) {
    return { after: before, replacements: 0 };
  }

  const after = replaceWithGuard(
    before,
    pattern,
    `$1${toTag}$2`,
    "PatchExecService:applyTemplateTagRewrite:tag-rewrite"
  );
  const parseAfter = parseAngularTemplate(after);
  if (parseAfter.errors.length > 0) {
    throw new Error("PLAN_VERIFICATION_WEAK");
  }

  return { after, replacements };
}

function createSourceFileForPatch(safePath: string, content: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true
  });
  const scriptKind = safePath.endsWith(".js") || safePath.endsWith(".mjs") || safePath.endsWith(".cjs")
    ? ScriptKind.JS
    : ScriptKind.TS;
  return project.createSourceFile(path.basename(safePath), content, {
    overwrite: true,
    scriptKind
  });
}

function requiredStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("PLAN_MISSING_REQUIRED_FIELDS");
  }
  return value.trim();
}

function inferFileKind(filePath: string): "ts" | "js" | "html" {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".html")) {
    return "html";
  }
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "js";
  }
  return "ts";
}

function countOccurrences(content: string, token: string): number {
  if (!token) {
    return 0;
  }
  return content.split(token).length - 1;
}

function lineCount(content: string): number {
  if (!content) {
    return 0;
  }
  return content.split("\n").length;
}

function escapeRegex(value: string): string {
  return replaceWithGuard(value, /[.*+?^${}()|[\]\\]/g, "\\$&", "PatchExecService:escapeRegex");
}
