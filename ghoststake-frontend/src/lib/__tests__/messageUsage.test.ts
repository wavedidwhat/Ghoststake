import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import messages from "../../../messages/en.json";
import descriptions from "../../../messages/descriptions.json";

/**
 * The catalog against the code (GHO-117).
 *
 * `tsc` already fails on a key the code asks for that the catalog lacks. This
 * is the other direction: a key the catalog has that nothing asks for. Left
 * alone, those pile up as copy gets rewritten, and every one is a string a
 * reviewer reads and a translator is paid for that no user will ever see.
 *
 * It reads the source with the TypeScript compiler rather than grepping,
 * because a key is only meaningful with the namespace its `t` was made with:
 * `t("title")` means `notFound.title` in one file and `routeError.title` in
 * the next.
 *
 * What it understands:
 * - `useTranslations("ns")` / `getTranslations("ns")` / `getTranslations({ namespace: "ns" })`,
 *   assigned to a variable, then `v("key")`, `v.rich("key")`, `v.markup`, `v.raw`, `v.has`.
 * - A template key, `` v(`links.${id}`) ``: every key under `ns.links.` counts.
 * - A key held in a variable, `v(hint)`: then any string literal anywhere in
 *   `src/` that names a key in that namespace counts. Loose, on purpose — the
 *   literal is how a helper like `switchHint` spells the key it returns.
 * - `messages.a.b` on a direct import of `en.json`, for code outside React.
 */

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [`${prefix}${key}`] : leaves(value, `${prefix}${key}.`),
  );
}

const keys = leaves(messages);

const sources = execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx'", { cwd: process.cwd() })
  .toString()
  .trim()
  .split("\n")
  .filter((f) => !f.includes("__tests__") && !f.endsWith(".d.ts"));

function literalText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** The namespace a `useTranslations(...)` / `getTranslations(...)` call names, or "" for the root. */
function namespaceOf(call: ts.CallExpression): string | undefined {
  const callee = call.expression.getText();
  if (callee !== "useTranslations" && callee !== "getTranslations") return undefined;
  const [arg] = call.arguments;
  if (!arg) return "";
  const text = literalText(arg);
  if (text !== undefined) return text;
  if (ts.isObjectLiteralExpression(arg)) {
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name.getText() === "namespace") {
        return literalText(prop.initializer) ?? "";
      }
    }
    return "";
  }
  return undefined;
}

function unwrapAwait(node: ts.Expression): ts.Expression {
  return ts.isAwaitExpression(node) ? node.expression : node;
}

const join = (ns: string, key: string) => (ns ? `${ns}.${key}` : key);

const used = new Set<string>();
const prefixes = new Set<string>();
const dynamicNamespaces = new Set<string>();
const literals = new Set<string>();

for (const file of sources) {
  const text = readFileSync(file, "utf8");
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);

  // Pass 1: which variables are translators, and for which namespaces. A
  // name bound twice in one file (two components, both `t`) keeps both.
  const translators = new Map<string, Set<string>>();
  const catalogImports = new Set<string>();

  const bind = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrapAwait(node.initializer);
      if (ts.isCallExpression(init)) {
        const ns = namespaceOf(init);
        if (ns !== undefined) {
          const set = translators.get(node.name.text) ?? new Set<string>();
          set.add(ns);
          translators.set(node.name.text, set);
        }
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      literalText(node.moduleSpecifier)?.endsWith("messages/en.json") &&
      node.importClause?.name
    ) {
      catalogImports.add(node.importClause.name.text);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.add(node.text);
    ts.forEachChild(node, bind);
  };
  bind(source);

  // Pass 2: what each translator is asked for.
  const collect = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      let callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && ["rich", "markup", "raw", "has"].includes(callee.name.text)) {
        callee = callee.expression;
      }
      const namespaces = ts.isIdentifier(callee) ? translators.get(callee.text) : undefined;
      const [arg] = node.arguments;
      if (namespaces && arg) {
        const key = literalText(arg);
        for (const ns of namespaces) {
          if (key !== undefined) used.add(join(ns, key));
          else if (ts.isTemplateExpression(arg)) prefixes.add(join(ns, arg.head.text));
          else dynamicNamespaces.add(ns);
        }
      }
    }
    // `messages.nav.links.markets` on a direct import of the catalog.
    if (ts.isPropertyAccessExpression(node) && !ts.isPropertyAccessExpression(node.parent)) {
      const path: string[] = [];
      let cursor: ts.Expression = node;
      while (ts.isPropertyAccessExpression(cursor)) {
        path.unshift(cursor.name.text);
        cursor = cursor.expression;
      }
      if (ts.isIdentifier(cursor) && catalogImports.has(cursor.text)) prefixes.add(path.join("."));
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
}

function isUsed(key: string): boolean {
  if (used.has(key)) return true;
  for (const prefix of prefixes) if (key === prefix || key.startsWith(prefix)) return true;
  for (const ns of dynamicNamespaces) {
    const relative = ns ? (key.startsWith(`${ns}.`) ? key.slice(ns.length + 1) : undefined) : key;
    if (relative !== undefined && literals.has(relative)) return true;
  }
  return false;
}

/**
 * `{name}` and `{name, plural, …}` at the top of a message, by brace depth.
 * A pattern match read the plural branch in `other {settings}` as an
 * argument named "settings"; a branch is always one level down.
 */
function topLevelArguments(message: string): string[] {
  const names: string[] = [];
  let depth = 0;
  for (let i = 0; i < message.length; i++) {
    const c = message[i];
    if (c === "{") {
      if (depth === 0) {
        const name = /^\s*([A-Za-z]\w*)\s*[,}]/.exec(message.slice(i + 1));
        if (name) names.push(name[1]);
      }
      depth++;
    } else if (c === "}") depth--;
  }
  return names;
}

describe("messages/en.json against the code", () => {
  it("has no key that nothing uses", () => {
    expect(keys.filter((key) => !isUsed(key))).toEqual([]);
  });

  it("found translators to check against", () => {
    // Guards the check above: an analyzer that recognised nothing would
    // report every key unused, but one that recognised the wrong thing could
    // report none. Both ends are pinned.
    expect(used.size).toBeGreaterThan(20);
  });
});

describe("messages/descriptions.json", () => {
  /**
   * Every key says where it appears and what it is (GHO-117). A string read
   * on its own — in a review, or by a translator — is ambiguous in exactly
   * the way it isn't on screen: "Close" is a verb on a button and an
   * adjective in a sentence.
   */
  it("describes every key in the catalog, and nothing else", () => {
    const described = leaves(descriptions);
    expect(keys.filter((k) => !described.includes(k))).toEqual([]);
    expect(described.filter((k) => !keys.includes(k))).toEqual([]);
  });

  it("names every argument a message takes", () => {
    // A description that doesn't say what {chain} is leaves the reviewer to
    // guess whether it's a name, a number or an address.
    const flat = new Map(leaves(descriptions).map((k) => [k, k.split(".").reduce<unknown>((t, p) => (t as Tree)[p], descriptions) as string]));
    const missing: string[] = [];
    for (const key of keys) {
      const message = key.split(".").reduce<unknown>((t, p) => (t as Tree)[p], messages) as string;
      for (const name of topLevelArguments(message)) {
        if (!flat.get(key)?.includes(`{${name}}`)) missing.push(`${key}: {${name}}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
