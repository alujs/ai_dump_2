/**
 * Angular Route Config Parser — extracts route tree from TypeScript source files.
 *
 * Handles:
 *   - `export default [...] as Routes` (standalone route files)
 *   - `provideRouter([...])` (app.config.ts pattern)
 *   - `RouterModule.forRoot([...])` / `RouterModule.forChild([...])` (NgModule pattern)
 *   - Nested `children: [...]`
 *   - `loadComponent` / `loadChildren` dynamic imports (extracts target module path)
 *   - `canMatch` / `canActivate` guard presence
 *
 * Does NOT resolve dynamic import targets to actual class names — that's a
 * cross-file concern handled by the IndexingService symbol map. This parser
 * extracts the *structure* (path tree + import targets) only.
 *
 * [REF:ROUTE-PARSER]
 */

import {
  type SourceFile,
  type ObjectLiteralExpression,
  type ArrayLiteralExpression,
  type PropertyAssignment,
  SyntaxKind,
  type Node,
  type ArrowFunction,
  type CallExpression,
} from "ts-morph";

/* ── Public types ────────────────────────────────────────── */

export interface ParsedRoute {
  /** Full resolved path from root (e.g. "editor/:slug") */
  fullPath: string;
  /** Literal path segment from this route definition */
  pathSegment: string;
  /** Source file where the route is defined */
  filePath: string;
  /** Line number (0-based) of the route object literal */
  line: number;
  /** Whether the route uses loadComponent or loadChildren (lazy) */
  isLazy: boolean;
  /** Dynamic import target path for loadComponent (e.g. "./edit-article/edit-article.component") */
  loadComponentTarget?: string;
  /** Dynamic import target path for loadChildren (e.g. "./editor/editor.routes") */
  loadChildrenTarget?: string;
  /** Guard function names if present */
  guards: string[];
  /** Parent route fullPath, if nested */
  parentRoutePath?: string;
  /** Child routes (pre-flattened — also in the flat output) */
  childCount: number;
  /** Whether this route has a `children` array */
  hasChildren: boolean;
  /** Whether this route has `providers` (route-scoped DI) */
  hasProviders: boolean;
}

export interface RouteParseResult {
  /** All routes flattened into a list (including nested children) */
  routes: ParsedRoute[];
  /** Source file that was parsed */
  filePath: string;
  /** Parse-time notes/warnings */
  notes: string[];
}

/* ── Public API ──────────────────────────────────────────── */

/**
 * Extract Angular route definitions from a single SourceFile.
 * Tries multiple patterns (provideRouter, RouterModule, default export).
 */
export function parseRouteConfig(sourceFile: SourceFile): RouteParseResult {
  const filePath = sourceFile.getFilePath();
  const notes: string[] = [];
  const routes: ParsedRoute[] = [];

  // Strategy 1: `provideRouter([...])` — standalone app.config.ts
  const providerRoutes = findProvideRouterArray(sourceFile);
  if (providerRoutes) {
    extractRoutesFromArray(providerRoutes, filePath, "", null, routes, notes);
  }

  // Strategy 2: `RouterModule.forRoot([...])` or `RouterModule.forChild([...])`
  const routerModuleRoutes = findRouterModuleArray(sourceFile);
  if (routerModuleRoutes) {
    extractRoutesFromArray(routerModuleRoutes, filePath, "", null, routes, notes);
  }

  // Strategy 3: `export default [...] as Routes` or `export default [...]`
  const defaultExportRoutes = findDefaultExportArray(sourceFile);
  if (defaultExportRoutes) {
    extractRoutesFromArray(defaultExportRoutes, filePath, "", null, routes, notes);
  }

  // Strategy 4: Named variable `const routes: Routes = [...]` or `const appRoutes = [...]`
  if (routes.length === 0) {
    const namedRoutes = findNamedRoutesArray(sourceFile);
    if (namedRoutes) {
      extractRoutesFromArray(namedRoutes, filePath, "", null, routes, notes);
    }
  }

  if (routes.length === 0) {
    notes.push(`No route definitions found in ${filePath}`);
  }

  return { routes, filePath, notes };
}

/**
 * Quick check: does this file look like it might contain route definitions?
 * Used to filter files before the heavier parse pass.
 */
export function isLikelyRouteFile(filePath: string, content: string): boolean {
  const lowerPath = filePath.toLowerCase();
  if (
    lowerPath.includes("route") ||
    lowerPath.includes("routing") ||
    lowerPath.endsWith("app.config.ts") ||
    lowerPath.endsWith("app.module.ts")
  ) {
    return true;
  }
  // Content heuristic: check for route-related tokens
  return (
    content.includes("provideRouter") ||
    content.includes("RouterModule") ||
    content.includes("loadComponent") ||
    content.includes("loadChildren") ||
    (content.includes("Routes") && content.includes("path"))
  );
}

/* ── Finders: locate the array literal containing route configs ── */

function findProvideRouterArray(sourceFile: SourceFile): ArrayLiteralExpression | null {
  // Look for: provideRouter([...], ...)
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (expr.getText() === "provideRouter") {
      const firstArg = call.getArguments()[0];
      if (firstArg && firstArg.isKind(SyntaxKind.ArrayLiteralExpression)) {
        return firstArg;
      }
    }
  }
  return null;
}

function findRouterModuleArray(sourceFile: SourceFile): ArrayLiteralExpression | null {
  // Look for: RouterModule.forRoot([...]) or RouterModule.forChild([...])
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const text = call.getExpression().getText();
    if (text === "RouterModule.forRoot" || text === "RouterModule.forChild") {
      const firstArg = call.getArguments()[0];
      if (firstArg && firstArg.isKind(SyntaxKind.ArrayLiteralExpression)) {
        return firstArg;
      }
    }
  }
  return null;
}

function findDefaultExportArray(sourceFile: SourceFile): ArrayLiteralExpression | null {
  // Pattern: `export default [...] as Routes` or `export default [...]`
  for (const exp of sourceFile.getExportAssignments()) {
    if (!exp.isExportEquals()) {
      // This is a `export default ...` (not `export = ...`)
      const expr = exp.getExpression();
      // Handle `[...] as Routes`
      if (expr.isKind(SyntaxKind.AsExpression)) {
        const inner = expr.getExpression();
        if (inner.isKind(SyntaxKind.ArrayLiteralExpression)) {
          return inner;
        }
      }
      // Direct array
      if (expr.isKind(SyntaxKind.ArrayLiteralExpression)) {
        return expr;
      }
    }
  }
  return null;
}

function findNamedRoutesArray(sourceFile: SourceFile): ArrayLiteralExpression | null {
  // Pattern: `const routes: Routes = [...]` or `const appRoutes = [...]`
  for (const decl of sourceFile.getVariableDeclarations()) {
    const name = decl.getName().toLowerCase();
    if (name.includes("route")) {
      const init = decl.getInitializer();
      if (init && init.isKind(SyntaxKind.ArrayLiteralExpression)) {
        return init;
      }
    }
  }
  return null;
}

/* ── Extractors: walk route config objects ───────────────── */

function extractRoutesFromArray(
  array: ArrayLiteralExpression,
  filePath: string,
  parentPath: string,
  parentRoutePath: string | null,
  output: ParsedRoute[],
  notes: string[],
): void {
  for (const element of array.getElements()) {
    if (element.isKind(SyntaxKind.ObjectLiteralExpression)) {
      extractSingleRoute(element, filePath, parentPath, parentRoutePath, output, notes);
    } else {
      // Could be a spread element or a variable reference — skip with note
      notes.push(`Skipped non-object route element at ${filePath}:${element.getStartLineNumber()}`);
    }
  }
}

function extractSingleRoute(
  obj: ObjectLiteralExpression,
  filePath: string,
  parentPath: string,
  parentRoutePath: string | null,
  output: ParsedRoute[],
  notes: string[],
): void {
  const pathSegment = getStringProperty(obj, "path") ?? "";
  const fullPath = joinRoutePaths(parentPath, pathSegment);

  const loadComponentTarget = extractDynamicImportPath(obj, "loadComponent");
  const loadChildrenTarget = extractDynamicImportPath(obj, "loadChildren");
  const isLazy = !!(loadComponentTarget || loadChildrenTarget);
  const guards = extractGuardNames(obj);
  const childrenProp = getArrayProperty(obj, "children");
  const hasProviders = hasProperty(obj, "providers");

  const route: ParsedRoute = {
    fullPath,
    pathSegment,
    filePath,
    line: obj.getStartLineNumber() - 1, // 0-based
    isLazy,
    loadComponentTarget,
    loadChildrenTarget,
    guards,
    parentRoutePath: parentRoutePath ?? undefined,
    childCount: 0,
    hasChildren: !!childrenProp,
    hasProviders,
  };

  output.push(route);

  // Recurse into children
  if (childrenProp) {
    const beforeCount = output.length;
    extractRoutesFromArray(childrenProp, filePath, fullPath, fullPath, output, notes);
    route.childCount = output.length - beforeCount;
  }
}

/* ── Property helpers ────────────────────────────────────── */

function getStringProperty(obj: ObjectLiteralExpression, name: string): string | undefined {
  const prop = obj.getProperty(name);
  if (!prop || !prop.isKind(SyntaxKind.PropertyAssignment)) return undefined;
  const init = (prop as PropertyAssignment).getInitializer();
  if (!init) return undefined;

  // String literal: `path: 'login'`
  if (init.isKind(SyntaxKind.StringLiteral)) {
    return init.getLiteralText();
  }
  // No-substitution template literal: `path: \`login\``
  if (init.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    return init.getLiteralText();
  }
  return undefined;
}

function getArrayProperty(obj: ObjectLiteralExpression, name: string): ArrayLiteralExpression | null {
  const prop = obj.getProperty(name);
  if (!prop || !prop.isKind(SyntaxKind.PropertyAssignment)) return null;
  const init = (prop as PropertyAssignment).getInitializer();
  if (init && init.isKind(SyntaxKind.ArrayLiteralExpression)) {
    return init;
  }
  return null;
}

function hasProperty(obj: ObjectLiteralExpression, name: string): boolean {
  return !!obj.getProperty(name);
}

/**
 * Extract the import path from `loadComponent: () => import('./foo/bar.component')`
 * or `loadChildren: () => import('./foo/bar.routes')`.
 */
function extractDynamicImportPath(obj: ObjectLiteralExpression, propName: string): string | undefined {
  const prop = obj.getProperty(propName);
  if (!prop || !prop.isKind(SyntaxKind.PropertyAssignment)) return undefined;
  const init = (prop as PropertyAssignment).getInitializer();
  if (!init) return undefined;

  // Arrow function: `() => import('...')`
  if (init.isKind(SyntaxKind.ArrowFunction)) {
    const arrow = init as ArrowFunction;
    const body = arrow.getBody();
    return extractImportPathFromExpression(body);
  }

  // Direct call expression (unlikely but handle): `import('...')`
  return extractImportPathFromExpression(init);
}

function extractImportPathFromExpression(node: Node): string | undefined {
  // Walk for CallExpression with `import(...)` — in ts-morph this is a CallExpression
  // where the expression text is "import"
  const calls = node.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    const exprText = call.getExpression().getText();
    if (exprText === "import") {
      const firstArg = call.getArguments()[0];
      if (firstArg && firstArg.isKind(SyntaxKind.StringLiteral)) {
        return firstArg.getLiteralText();
      }
    }
  }
  // Handle: `() => import('...')` where body is directly a CallExpression
  if (node.isKind(SyntaxKind.CallExpression)) {
    const call = node as CallExpression;
    const exprText = call.getExpression().getText();
    if (exprText === "import") {
      const firstArg = call.getArguments()[0];
      if (firstArg && firstArg.isKind(SyntaxKind.StringLiteral)) {
        return firstArg.getLiteralText();
      }
    }
  }
  return undefined;
}

/**
 * Extract guard function *names* from canMatch/canActivate/canDeactivate arrays.
 * e.g. `canMatch: [authGuard()]` → ["authGuard"]
 */
function extractGuardNames(obj: ObjectLiteralExpression): string[] {
  const guards: string[] = [];
  for (const guardProp of ["canMatch", "canActivate", "canDeactivate", "canActivateChild"]) {
    const arr = getArrayProperty(obj, guardProp);
    if (!arr) continue;
    for (const el of arr.getElements()) {
      // `authGuard()` — CallExpression whose expression is Identifier
      if (el.isKind(SyntaxKind.CallExpression)) {
        const name = el.getExpression().getText();
        guards.push(name);
      }
      // `AuthGuard` — Identifier (class-based guard)
      if (el.isKind(SyntaxKind.Identifier)) {
        guards.push(el.getText());
      }
    }
  }
  return guards;
}

/* ── Path helpers ────────────────────────────────────────── */

function joinRoutePaths(parent: string, child: string): string {
  if (!parent && !child) return "";
  if (!parent) return child;
  if (!child) return parent;
  // Avoid double slashes
  const p = parent.endsWith("/") ? parent.slice(0, -1) : parent;
  return `${p}/${child}`;
}
