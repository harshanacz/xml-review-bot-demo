import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { getLanguageService } from "xml-language-service";
import {
  buildSummary,
  builtinSchemaDir,
  commentableLines,
  dedupeDiagnostics,
  escapeMarkdown,
  isIgnored,
  resolveSchema,
  rootNamespace,
  validateXml,
} from "../src/lib.mjs";

const diag = (line, message, severity = "error") => ({
  message, severity, source: "xsd",
  range: { start: { line, character: 0 }, end: { line, character: 1 } },
});

test("commentableLines keeps added and context lines, skips removed", () => {
  const patch = [
    "@@ -1,4 +1,5 @@",
    " a",
    "-b",
    "+B",
    "+C",
    " d",
    "@@ -20,2 +21,2 @@ header text",
    " x",
    "+y",
    "\\ No newline at end of file",
  ].join("\n");
  assert.deepEqual([...commentableLines(patch)], [1, 2, 3, 4, 21, 22]);
});

test("commentableLines handles missing patch (binary or huge files)", () => {
  assert.equal(commentableLines(undefined).size, 0);
});

test("dedupeDiagnostics drops repeats and sorts by line", () => {
  const out = dedupeDiagnostics([diag(5, "b"), diag(1, "a"), diag(5, "b")]);
  assert.deepEqual(out.map(d => d.message), ["a", "b"]);
});

test("escapeMarkdown neutralises tags and pipes", () => {
  assert.equal(escapeMarkdown("<a>|x"), "\\<a\\>\\|x");
});

test("isIgnored matches globs", () => {
  assert.ok(isIgnored("gen/generated/a.xml", ["**/generated/**"]));
  assert.ok(!isIgnored("src/a.xml", ["**/generated/**"]));
});

test("rootNamespace skips prolog and comments", () => {
  const xml = `<?xml version="1.0"?>\n<!-- <x xmlns="nope"> -->\n<project xmlns="http://maven.apache.org/POM/4.0.0"/>`;
  assert.equal(rootNamespace(xml), "http://maven.apache.org/POM/4.0.0");
});

test("built-in schemas are found in the installed package", () => {
  assert.ok(builtinSchemaDir(), "bundled XSD directory not found");
  assert.match(resolveSchema("module/pom.xml", "<project/>").xsdPath, /maven-4\.0\.0\.xsd$/);
});

test("schema resolved by namespace when file name differs", () => {
  const r = resolveSchema("parent-pom.xml", `<project xmlns="http://maven.apache.org/POM/4.0.0"/>`);
  assert.match(r.xsdPath, /maven-4\.0\.0\.xsd$/);
});

test("buildSummary lists issues outside the diff", () => {
  const { body, totalErrors } = buildSummary([
    { filename: "pom.xml", status: "issues", errors: 1, warnings: 0, outsideDiff: [diag(9, "bad")] },
    { filename: "ok.xml", status: "ok", errors: 0, warnings: 0 },
  ]);
  assert.equal(totalErrors, 1);
  assert.match(body, /`pom.xml:10`/);
  assert.match(body, /\| `ok.xml` \| ✅ no issues \|/);
});

test("validateXml reports XSD errors in the demo pom.xml", async () => {
  const ls = getLanguageService();
  try {
    const { diagnostics, schema } = await validateXml(ls, "pom.xml", readFileSync("pom.xml", "utf8"));
    assert.equal(schema, "maven-4.0.0.xsd");
    const msgs = diagnostics.map(d => d.message).join("\n");
    assert.match(msgs, /'scop'/);
    assert.match(msgs, /'extraTag'/);
  } finally {
    ls.dispose();
  }
});

test("validateXml accepts a valid pom.xml", async () => {
  const ls = getLanguageService();
  try {
    const xml = `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>` +
      `<groupId>a</groupId><artifactId>b</artifactId><version>1</version></project>`;
    const { diagnostics } = await validateXml(ls, "pom.xml", xml);
    assert.deepEqual(diagnostics, []);
  } finally {
    ls.dispose();
  }
});

test("validateXml checks well-formedness when no schema applies", async () => {
  const ls = getLanguageService();
  try {
    const bad = await validateXml(ls, "data.xml", "<root><a></root>");
    assert.equal(bad.schema, null);
    assert.equal(bad.diagnostics.length, 1);
    assert.equal(bad.diagnostics[0].source, "syntax");
    const good = await validateXml(ls, "data.xml", `<r xmlns="urn:x"><a/></r>`);
    assert.deepEqual(good.diagnostics, []);
  } finally {
    ls.dispose();
  }
});
