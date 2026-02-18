import { Project } from "ts-morph";
import { parseTemplate, type TmplAstElement, type TmplAstTemplate } from "@angular/compiler";

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
  const result = parseTemplate(normalizeSelfClosingTags(templateSource), "inline-template");
  const errors = result.errors ?? [];
  return {
    nodes: result.nodes.length,
    errors: errors.map((error) => error.toString())
  };
}

/**
 * Extract inline template strings from an Angular component .ts file.
 * Handles both backtick-quoted templates (`template: \`...\``) and
 * single/double-quoted templates (rare but valid for one-liners).
 *
 * Returns an array because a file can theoretically contain multiple
 * @Component decorators (e.g. test helpers), though typically just one.
 */
export function extractInlineTemplates(tsFileContent: string): string[] {
  const templates: string[] = [];
  // Match: template: `...` (backtick — most common for multi-line)
  const backtickRe = /template\s*:\s*`([\s\S]*?)`/g;
  let m: RegExpExecArray | null;
  while ((m = backtickRe.exec(tsFileContent)) !== null) {
    templates.push(m[1]);
  }
  // Match: template: '...' or template: "..." (single-line)
  if (templates.length === 0) {
    const quoteRe = /template\s*:\s*(['"])([\s\S]*?)\1/g;
    while ((m = quoteRe.exec(tsFileContent)) !== null) {
      templates.push(m[2]);
    }
  }
  return templates;
}

/**
 * HTML void elements (self-closing is valid per spec).
 * Angular's parseTemplate only allows self-closing tags on these + foreign (SVG/MathML).
 * See: https://html.spec.whatwg.org/multipage/syntax.html#void-elements
 */
const HTML_VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Pre-process a template to expand self-closing custom element tags
 * (e.g. `<app-banner />` → `<app-banner></app-banner>`).
 *
 * Angular 14+ runtime allows self-closing custom components, but the
 * offline `parseTemplate()` from @angular/compiler rejects them with
 * "Only void and foreign elements can be self closed".
 *
 * This normalization makes the template parseable while preserving
 * directive bindings, attributes, and structure.
 */
export function normalizeSelfClosingTags(templateSource: string): string {
  // Match <tag-name ...attrs /> where tag-name is NOT a void element
  return templateSource.replace(
    /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)\s*\/>/g,
    (_match, tagName: string, attrs: string) => {
      if (HTML_VOID_ELEMENTS.has(tagName.toLowerCase())) {
        return _match; // Leave void elements as-is
      }
      return `<${tagName}${attrs}></${tagName}>`;
    },
  );
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
    const result = parseTemplate(normalizeSelfClosingTags(templateSource), filePath);    collectElementUsage(result.nodes, filePath, facts);
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
    const parsed = parseTemplate(normalizeSelfClosingTags(templateSource), filePath);
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

/* ── Phase 6: Template directive extraction ─────────────────── */

/**
 * Angular built-in directive/binding names that should NOT be captured as
 * custom directive usages.  This is the ONLY filter — everything else is
 * extracted as a fact and resolved against the symbol map later.
 *
 * We intentionally keep this list to Angular CORE built-ins only.
 * Custom directives from any library (including role/permission/auth directives
 * whose names we cannot predict) will be captured and resolved through the
 * dependency graph at index time.
 */
const ANGULAR_BUILTIN_DIRECTIVES = new Set([
  // Structural
  "ngif", "ngfor", "ngforof", "ngswitch", "ngswitchcase", "ngswitchdefault",
  "ngtemplateoutlet", "ngcomponentoutlet", "ngplural", "ngpluralcase",
  // Common attribute directives / bindings
  "ngclass", "ngstyle", "ngmodel", "ngformcontrolname", "ngformgroupname",
  "ngformarrayname", "ngform", "ngnoform", "ngsubmitgroup",
  "ngmodelgroup", "ngdefaultcontrol",
  // Router
  "routerlink", "routerlinkactive", "routerlinkactiveoptions",
  // Template reference / structural sugar
  "ngtemplate", "ngcontainer",
  // Common HTML attributes that aren't directives
  "class", "style", "id", "name", "type", "value", "placeholder",
  "disabled", "readonly", "checked", "selected", "hidden", "tabindex",
  "title", "alt", "src", "href", "target", "rel", "role", "aria",
  // Event bindings (Angular desugars (click) into bound attributes)
  "click", "submit", "change", "input", "focus", "blur", "keyup",
  "keydown", "keypress", "mouseenter", "mouseleave", "mouseover",
  "mouseout", "mousedown", "mouseup", "dblclick", "contextmenu",
  "scroll", "resize", "load", "error", "touchstart", "touchend",
  "touchmove", "drag", "dragstart", "dragend", "dragover", "drop",
]);

/** A directive usage found in a template */
export interface TemplateDirectiveUsage {
  /** The directive/attribute name as it appears (e.g. "appHasRole", "appHighlight", "tooltip") */
  directiveName: string;
  /** The bound expression or static value (e.g. "'ADMIN'", "someCondition") */
  boundExpression: string | null;
  /** 0-based line number in the template */
  line: number;
  /** The host element tag the directive is on */
  hostTag: string;
  /** Whether this is a structural directive (*appXyz) vs attribute directive ([appXyz]) */
  isStructural: boolean;
}

/** Result of scanning a template for custom directive usages */
export interface TemplateDirectiveFacts {
  usages: TemplateDirectiveUsage[];
}

/**
 * Parse an Angular template and extract ALL custom directive usages.
 *
 * Covers two forms:
 *  1. Structural directives: `*appHasRole="'ADMIN'"` — compiled into
 *     TmplAstTemplate nodes with the directive binding in templateAttrs.
 *  2. Attribute directives: `[appHasPermission]="'canEdit'"` — appear
 *     as bound inputs on regular TmplAstElement nodes.
 *
 * Extracts ALL directives EXCEPT known Angular built-ins (ngIf, ngFor,
 * routerLink, etc.).  Does NOT pattern-match for specific names — any
 * custom directive is captured as a fact.  Classification (role, permission,
 * auth, etc.) happens downstream via symbol resolution and import tracing,
 * not hardcoded patterns.
 */
export function parseAngularTemplateDirectives(
  templateSource: string,
  filePath: string,
): TemplateDirectiveFacts {
  const result: TemplateDirectiveFacts = { usages: [] };

  try {
    const parsed = parseTemplate(normalizeSelfClosingTags(templateSource), filePath);
    collectDirectiveUsages(parsed.nodes, result);
  } catch {
    // Template parse failures are non-fatal
  }

  return result;
}

function isBuiltinDirective(name: string): boolean {
  return ANGULAR_BUILTIN_DIRECTIVES.has(name.toLowerCase());
}

function collectDirectiveUsages(nodes: unknown[], result: TemplateDirectiveFacts): void {
  for (const node of nodes) {
    // 1. Structural directives → TmplAstTemplate nodes
    //    *appHasRole="expr" compiles to a TmplAstTemplate with:
    //    - templateAttrs containing the directive binding
    //    - tagName might be null / "ng-template"
    if (isTemplateNode(node)) {
      const templateNode = node as TmplAstTemplate;
      const tagName = templateNode.tagName ?? "ng-template";

      // Check templateAttrs (structural directive bindings)
      const templateAttrs = (templateNode as unknown as { templateAttrs?: unknown[] }).templateAttrs;
      if (Array.isArray(templateAttrs)) {
        for (const attr of templateAttrs) {
          if (attr && typeof attr === "object" && "name" in attr) {
            const attrName = (attr as { name: string }).name;
            if (!isBuiltinDirective(attrName)) {
              const boundExpr = extractExpressionValue(attr);
              result.usages.push({
                directiveName: attrName,
                boundExpression: boundExpr,
                line: templateNode.sourceSpan?.start?.line ?? 0,
                hostTag: tagName,
                isStructural: true,
              });
            }
          }
        }
      }

      // Also check static attributes on the ng-template
      if (Array.isArray(templateNode.attributes)) {
        for (const attr of templateNode.attributes) {
          if (attr && typeof attr === "object" && "name" in attr) {
            const attrName = (attr as { name: string }).name;
            if (!isBuiltinDirective(attrName)) {
              result.usages.push({
                directiveName: attrName,
                boundExpression: (attr as { value?: string }).value ?? null,
                line: templateNode.sourceSpan?.start?.line ?? 0,
                hostTag: tagName,
                isStructural: true,
              });
            }
          }
        }
      }

      // Recurse into children
      if (Array.isArray(templateNode.children)) {
        collectDirectiveUsages(templateNode.children, result);
      }
    }

    // 2. Attribute directives on regular elements → TmplAstElement
    //    [appHasPermission]="expr" appears in node.inputs
    //    appHighlight="value" appears in node.attributes
    if (isTemplateElement(node)) {
      const tag = node.name;

      // Check bound attributes (inputs) like [appHasRole]="expr"
      if ("inputs" in node && Array.isArray((node as { inputs: unknown[] }).inputs)) {
        for (const input of (node as { inputs: unknown[] }).inputs) {
          if (input && typeof input === "object" && "name" in input) {
            const inputName = (input as { name: string }).name;
            if (!isBuiltinDirective(inputName)) {
              const boundExpr = extractExpressionValue(input);
              result.usages.push({
                directiveName: inputName,
                boundExpression: boundExpr,
                line: node.sourceSpan?.start?.line ?? 0,
                hostTag: tag,
                isStructural: false,
              });
            }
          }
        }
      }

      // Check static attributes — only capture ones that look like custom
      // directives (contain "app" prefix or camelCase or similar)
      // We skip plain HTML attributes by checking the built-in list
      for (const attr of (node.attributes ?? [])) {
        if (attr && typeof attr === "object" && "name" in attr) {
          const attrName = (attr as { name: string }).name;
          if (!isBuiltinDirective(attrName) && looksLikeDirective(attrName)) {
            result.usages.push({
              directiveName: attrName,
              boundExpression: (attr as { value?: string }).value ?? null,
              line: node.sourceSpan?.start?.line ?? 0,
              hostTag: tag,
              isStructural: false,
            });
          }
        }
      }

      // Recurse into children
      if (Array.isArray(node.children)) {
        collectDirectiveUsages(node.children, result);
      }
    }

    // Handle other container nodes (ng-container etc.) that might wrap directives
    if (node && typeof node === "object" && "children" in node
        && Array.isArray((node as { children: unknown[] }).children)
        && !isTemplateElement(node) && !isTemplateNode(node)) {
      collectDirectiveUsages((node as { children: unknown[] }).children, result);
    }
  }
}

/**
 * Heuristic for static attributes: only capture names that look like custom
 * Angular directives rather than plain HTML.  We check for:
 *   - camelCase (e.g. "appHasRole", "myTooltip")
 *   - prefixed with known app/lib prefixes containing a dash or uppercase
 * This avoids capturing every HTML attribute as a "directive usage."
 */
function looksLikeDirective(name: string): boolean {
  // Contains uppercase letter → likely camelCase directive selector
  if (/[A-Z]/.test(name)) return true;
  // Has a prefix separator (app-has-role style)
  if (name.includes("-") && !name.startsWith("data-") && !name.startsWith("aria-")) return true;
  return false;
}

/**
 * Detect TmplAstTemplate nodes (structural directives, ng-template).
 * These have tagName (possibly null) and templateAttrs.
 */
function isTemplateNode(node: unknown): node is TmplAstTemplate {
  return node !== null
    && typeof node === "object"
    && "tagName" in node
    && "templateAttrs" in node;
}

/**
 * Extract the expression value from a bound attribute or template attr.
 * Tries value.source (expression source text), then falls back to value.
 */
function extractExpressionValue(attr: unknown): string | null {
  if (!attr || typeof attr !== "object") return null;
  const obj = attr as Record<string, unknown>;

  // Bound attributes: value is an AST expression object with .source
  if (obj.value && typeof obj.value === "object") {
    const valueObj = obj.value as Record<string, unknown>;
    if (typeof valueObj.source === "string") return valueObj.source;
  }

  // Static attributes: value is a string directly
  if (typeof obj.value === "string") return obj.value;

  return null;
}

