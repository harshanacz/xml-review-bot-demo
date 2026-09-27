/**
 * Pure helpers for the XML PR review bot. Kept free of GitHub / process side
 * effects so they can be unit tested with `node --test`.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { validate as xercesValidate } from "xerces-wasm";

// Hard cap on inline comments per review. GitHub rejects very large reviews
// and a wall of comments is not useful anyway.
export const MAX_INLINE_COMMENTS = 50;

// Marker used to find the bot's own summary in the review body.
export const SUMMARY_MARKER = "<!-- xml-pr-review -->";

// ─── Diff parsing ─────────────────────────────────────────────────────────────
/**
 * Returns the set of new-file line numbers (1-based) that GitHub allows a
 * review comment on (`side: "RIGHT"`): added lines and context lines inside
 * a hunk. Lines outside every hunk cannot be commented on.
 */
export function commentableLines(patch) {
  const lines = new Set();
  if (!patch) return lines;

  let fileLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!m) { inHunk = false; continue; }
      fileLine = Number(m[1]) - 1;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("\\")) continue;       // "\ No newline at end of file"
    if (raw.startsWith("-")) continue;        // removed line, left side only
    if (raw.startsWith("+") || raw.startsWith(" ") || raw === "") {
      fileLine++;
      lines.add(fileLine);
    }
  }
  return lines;
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────
// An empty schema: validating against it makes Xerces report only
// well-formedness problems in `parseErrors`, which is what we want for XML
// files that have no associated schema.
const EMPTY_XSD = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>';

/** Well-formedness check through Xerces, for files without a schema. */
export async function wellFormednessDiagnostics(xmlText) {
  const result = await xercesValidate(xmlText, EMPTY_XSD);
  return result.parseErrors.map(e => {
    const pos = { line: Math.max(e.line - 1, 0), character: Math.max(e.column - 1, 0) };
    return { message: e.message, severity: "error", source: "syntax", range: { start: pos, end: pos } };
  });
}

/**
 * Removes duplicate diagnostics. Xerces often reports the same problem twice
 * (e.g. once as a syntax error and once again from the schema pass), which
 * would otherwise produce duplicate PR comments.
 */
export function dedupeDiagnostics(diagnostics) {
  const seen = new Set();
  const out = [];
  for (const d of diagnostics) {
    const key = `${d.range?.start?.line}|${d.severity}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out.sort((a, b) =>
    (a.range?.start?.line ?? 0) - (b.range?.start?.line ?? 0) ||
    (a.range?.start?.character ?? 0) - (b.range?.start?.character ?? 0));
}

export function countBySeverity(diagnostics) {
  let errors = 0, warnings = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errors++;
    else if (d.severity === "warning") warnings++;
  }
  return { errors, warnings };
}

// ─── Formatting ───────────────────────────────────────────────────────────────
const SEVERITY_ICON = { error: "🔴", warning: "🟡" };

/** Escapes text so it renders literally inside Markdown. */
export function escapeMarkdown(text) {
  return String(text).replace(/[\\`*_{}[\]<>|]/g, "\\$&");
}

export function formatComment(diag) {
  const icon = SEVERITY_ICON[diag.severity] ?? "🔵";
  const tag = diag.source === "syntax" ? "`syntax`" : "`xsd`";
  return `${icon} **XML ${diag.severity}** (${tag})\n\n${escapeMarkdown(diag.message)}`;
}

/**
 * Builds the Markdown review body.
 * @param results  one entry per file: { filename, status, errors, warnings, note?, outsideDiff? }
 */
export function buildSummary(results, { truncated = 0 } = {}) {
  const totalErrors = results.reduce((n, r) => n + (r.errors ?? 0), 0);
  const totalWarnings = results.reduce((n, r) => n + (r.warnings ?? 0), 0);

  const header = totalErrors + totalWarnings === 0
    ? "## ✅ XML Review: all files valid"
    : `## ❌ XML Review: ${totalErrors} error(s), ${totalWarnings} warning(s) found`;

  const rows = results.map(r => {
    const icon = { ok: "✅", issues: r.errors ? "❌" : "⚠️", skipped: "⚪", failed: "⚠️" }[r.status] ?? "⚪";
    let detail;
    if (r.status === "issues") detail = `${r.errors} error(s), ${r.warnings} warning(s)`;
    else if (r.status === "ok") detail = "no issues";
    else detail = r.note ?? r.status;
    return `| \`${r.filename}\` | ${icon} ${detail} |`;
  });

  const body = [
    SUMMARY_MARKER,
    header,
    "",
    "| File | Result |",
    "|------|--------|",
    ...rows,
  ];

  // Issues that could not be posted inline (outside the diff, or over the cap)
  // are listed here so they are never silently lost.
  const outside = results.flatMap(r => (r.outsideDiff ?? []).map(d => ({ file: r.filename, d })));
  if (outside.length > 0) {
    body.push(
      "",
      `<details><summary>${outside.length} issue(s) not shown inline</summary>`,
      "",
      ...outside.map(({ file, d }) =>
        `- \`${file}:${d.range.start.line + 1}\` ${SEVERITY_ICON[d.severity] ?? "🔵"} ${escapeMarkdown(d.message)}`),
      "",
      "</details>",
    );
  }
  if (truncated > 0) {
    body.push("", `_${truncated} inline comment(s) omitted (limit ${MAX_INLINE_COMMENTS} per review)._`);
  }

  body.push(
    "",
    "_Powered by [xml-language-service](https://www.npmjs.com/package/xml-language-service) " +
    "and [xerces-wasm](https://www.npmjs.com/package/xerces-wasm) (Apache Xerces-C++ WASM)._",
  );

  return { body: body.join("\n"), totalErrors, totalWarnings };
}

// ─── Config ───────────────────────────────────────────────────────────────────
/**
 * Loads `.xml-review.json` from the workspace, if present:
 *
 *   {
 *     "schemas": [ { "pattern": "**\/*.config.xml", "xsd": "schemas/config.xsd" } ],
 *     "ignore":  [ "**\/generated/**" ]
 *   }
 */
export function loadConfig(workspace) {
  const path = resolve(workspace, ".xml-review.json");
  const empty = { schemas: [], ignore: [] };
  if (!existsSync(path)) return empty;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    return {
      schemas: (cfg.schemas ?? []).map(s => ({ pattern: s.pattern, xsdPath: resolve(workspace, s.xsd) })),
      ignore: cfg.ignore ?? [],
    };
  } catch (err) {
    console.warn(`::warning::Could not parse ${path}: ${err.message}. Using defaults.`);
    return empty;
  }
}

/** Minimal glob matcher supporting `*`, `**` and `?`. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`(^|/)${re}$`);
}

export function isIgnored(filename, patterns) {
  return patterns.some(p => globToRegExp(p).test(filename));
}

// ─── Schema resolution ────────────────────────────────────────────────────────
// Schemas bundled with xml-language-service, matched by file name or by the
// root element's default namespace.
export const BUILTIN_SCHEMAS = [
  { pattern: "pom.xml", namespace: "http://maven.apache.org/POM/4.0.0", file: "maven-4.0.0.xsd" },
  { pattern: "web.xml", namespace: "http://xmlns.jcp.org/xml/ns/javaee", file: "web-app_3_1.xsd" },
];

let builtinDirCache;
/**
 * Locates the directory holding xml-language-service's bundled XSDs. The
 * package's own lookup points at the wrong folder in some releases, so we
 * search the known layouts ourselves.
 */
export function builtinSchemaDir() {
  if (builtinDirCache !== undefined) return builtinDirCache;
  let pkgRoot;
  try {
    // "exports" hides package.json, so walk up from the resolved entry point.
    const entry = fileURLToPath(import.meta.resolve("xml-language-service"));
    pkgRoot = dirname(dirname(entry));
  } catch {
    // Older Node without import.meta.resolve: walk up looking for node_modules.
    for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", "xml-language-service");
      if (existsSync(candidate)) { pkgRoot = candidate; break; }
      if (dirname(dir) === dir) { builtinDirCache = null; return null; }
    }
  }
  const candidates = [
    "dist/schema/resources/default",
    "dist/resources/default",
    "resources/default",
    "src/schema/resources/default",
  ].map(d => join(pkgRoot, d));
  builtinDirCache = candidates.find(d => existsSync(join(d, BUILTIN_SCHEMAS[0].file))) ?? null;
  return builtinDirCache;
}

/**
 * Picks the XSD for a document. Order: user schemas from .xml-review.json,
 * then built-ins by file name, then built-ins by root namespace.
 * @returns {{ xsdPath: string, xsdText: string } | null}
 */
export function resolveSchema(filename, xmlText, userSchemas = []) {
  const read = xsdPath => {
    try { return { xsdPath, xsdText: readFileSync(xsdPath, "utf8") }; }
    catch (err) { throw new Error(`Cannot read schema ${xsdPath}: ${err.message}`); }
  };

  for (const s of userSchemas) {
    if (globToRegExp(s.pattern).test(filename)) return read(s.xsdPath);
  }

  const dir = builtinSchemaDir();
  if (!dir) return null;
  const name = basename(filename);
  const byName = BUILTIN_SCHEMAS.find(s => s.pattern === name);
  if (byName) return read(join(dir, byName.file));

  const ns = rootNamespace(xmlText);
  const byNs = ns && BUILTIN_SCHEMAS.find(s => s.namespace === ns);
  if (byNs) return read(join(dir, byNs.file));
  return null;
}

// ─── Validation ───────────────────────────────────────────────────────────────
/**
 * Validates one XML document against its schema with xml-language-service
 * (Xerces-C++ via xerces-wasm). Files without a schema still get a
 * well-formedness check.
 *
 * @returns {Promise<{ diagnostics: object[], schema: string | null }>}
 */
export async function validateXml(ls, filename, xmlText, userSchemas = []) {
  const resolved = resolveSchema(filename, xmlText, userSchemas);

  if (!resolved) {
    return { diagnostics: dedupeDiagnostics(await wellFormednessDiagnostics(xmlText)), schema: null };
  }

  // Key the compiled schema by its XSD path so every file sharing a schema
  // reuses the same compiled grammar.
  const schemaUri = `schema://${resolved.xsdPath}`;
  if (!ls.hasSchema(schemaUri)) {
    await ls.registerSchema({ uri: schemaUri, xsdText: resolved.xsdText, xsdPath: resolved.xsdPath });
  }
  const doc = ls.parseXMLDocument(`file:///${filename}`, xmlText);
  const diagnostics = await ls.validate(schemaUri, doc);
  return { diagnostics: dedupeDiagnostics(diagnostics), schema: basename(resolved.xsdPath) };
}

/** Extracts the default namespace of the root element, if any. */
export function rootNamespace(xmlText) {
  const root = xmlText.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, "").match(/<[A-Za-z_][^>]*>/);
  return root?.[0].match(/\sxmlns\s*=\s*(["'])(.*?)\1/)?.[2];
}
