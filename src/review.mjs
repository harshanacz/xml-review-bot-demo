/**
 * xml-pr-review — GitHub Action script
 *
 * For each XML file changed in a PR:
 *   1. Auto-resolves its schema (pom.xml / web.xml / custom)
 *   2. Validates with xml-language-service (Xerces WASM)
 *   3. Posts inline PR review comments at the exact line of each diagnostic
 *   4. Posts a summary comment (✅ all good  or  ❌ N issues found)
 */

import { getLanguageService } from "xml-language-service";
import { readFileSync, existsSync } from "fs";
import { resolve, basename, dirname } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";

// ─── GitHub context (injected by the Action runner) ─────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const PR_NUMBER = Number(process.env.PR_NUMBER);
const WORKSPACE = process.env.GITHUB_WORKSPACE ?? ".";
const HEAD_SHA = process.env.HEAD_SHA;

// ─── Built-in schema loader ──────────────────────────────────────────────────
function loadBuiltinSchema(filename) {
  const require = createRequire(import.meta.url);
  const pkgRoot = dirname(require.resolve("xml-language-service/package.json"));

  // Try common locations inside the package
  const candidates = [
    `${pkgRoot}/dist/resources/default/${filename}`,
    `${pkgRoot}/resources/default/${filename}`,
    `${pkgRoot}/src/schema/resources/default/${filename}`,
    `${pkgRoot}/dist/schema/resources/default/${filename}`,
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      console.log(`  Found schema at: ${p}`);
      return readFileSync(p, "utf8");
    }
  }

  // Log all XSD files found in the package to help debug
  console.log(`  Could not find ${filename} — searching package for .xsd files...`);
  try {
    const files = execSync(`find ${pkgRoot} -name "*.xsd" 2>/dev/null`).toString().trim();
    if (files) {
      console.log(`  Available XSD files:\n${files}`);
    } else {
      console.log(`  No .xsd files found in package.`);
    }
  } catch { }

  return null;
}

// ─── Map filename → known schema URI and XSD filename ───────────────────────
const BUILTIN_SCHEMAS = {
  "pom.xml": {
    uri: "builtin://maven-4.0.0.xsd",
    xsdFile: "maven-4.0.0.xsd",
  },
  "web.xml": {
    uri: "builtin://web-app_3_1.xsd",
    xsdFile: "web-app_3_1.xsd",
  },
};

// ─── Helper: GitHub REST API ─────────────────────────────────────────────────
async function ghFetch(path, method = "GET", body = undefined) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

// ─── Get list of XML files changed in this PR ────────────────────────────────
async function getChangedXmlFiles() {
  const files = await ghFetch(`/pulls/${PR_NUMBER}/files`);
  return files
    .filter(f => f.status !== "removed" && f.filename.endsWith(".xml"))
    .map(f => ({
      filename: f.filename,
      localPath: resolve(WORKSPACE, f.filename),
      patch: f.patch,
    }));
}

// ─── Parse diff hunk → map { absoluteLine → diffPosition } ──────────────────
function buildLinePositionMap(patch) {
  if (!patch) return {};
  const map = {};
  let diffPos = 0;
  let fileLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const m = line.match(/\+(\d+)/);
      fileLine = m ? Number(m[1]) - 1 : fileLine;
      diffPos++;
      continue;
    }
    if (line.startsWith("-")) { diffPos++; continue; }
    if (line.startsWith("+") || line.startsWith(" ")) {
      fileLine++;
      diffPos++;
      map[fileLine] = diffPos;
    }
  }
  return map;
}

// ─── Post a PR Review with inline comments ────────────────────────────────────
async function postReview(comments, summary) {
  const event = comments.length > 0 ? "REQUEST_CHANGES" : "COMMENT";

  await ghFetch(`/pulls/${PR_NUMBER}/reviews`, "POST", {
    commit_id: HEAD_SHA,
    body: summary,
    event,
    comments: comments.map(c => ({
      path: c.path,
      position: c.position,
      body: c.body,
    })),
  });
}

// ─── Format a diagnostic into a Markdown comment ─────────────────────────────
function formatComment(diag) {
  const icon = diag.severity === "error" ? "🔴" : diag.severity === "warning" ? "🟡" : "🔵";
  const tag = diag.source === "syntax" ? "`syntax`" : "`xsd`";
  return `${icon} **XML ${diag.severity}** (${tag})\n\n${diag.message}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const ls = getLanguageService();

  try {
    const changedFiles = await getChangedXmlFiles();

    if (changedFiles.length === 0) {
      console.log("No XML files changed in this PR — nothing to review.");
      return;
    }

    console.log(`Reviewing ${changedFiles.length} XML file(s)…`);

    let totalErrors = 0;
    let totalWarnings = 0;
    const reviewComments = [];
    const fileSummaries = [];

    for (const { filename, localPath, patch } of changedFiles) {
      let xmlText;
      try {
        xmlText = readFileSync(localPath, "utf8");
      } catch {
        console.warn(`  Could not read ${localPath} — skipping.`);
        continue;
      }

      const doc = ls.parseXMLDocument(`file:///${filename}`, xmlText);
      const fileBase = basename(filename);
      const schemaInfo = BUILTIN_SCHEMAS[fileBase];

      let diagnostics = [];

      if (schemaInfo) {
        if (!ls.hasSchema(schemaInfo.uri)) {
          const xsdText = loadBuiltinSchema(schemaInfo.xsdFile);
          if (xsdText) {
            await ls.registerSchema({ uri: schemaInfo.uri, xsdText });
          } else {
            console.log(`  ${filename}: could not load built-in schema, skipping XSD validation`);
            fileSummaries.push(`⚠️ \`${filename}\` — schema not found, skipped`);
            continue;
          }
        }
        diagnostics = await ls.validate(schemaInfo.uri, doc);
        console.log(`  ${filename}: ${diagnostics.length} diagnostic(s)`);
      } else {
        console.log(`  ${filename}: no built-in schema for "${fileBase}", skipping`);
        fileSummaries.push(`⚪ \`${filename}\` — no schema, skipped`);
        continue;
      }

      if (diagnostics.length === 0) {
        fileSummaries.push(`✅ \`${filename}\` — no issues`);
        continue;
      }

      const errors = diagnostics.filter(d => d.severity === "error").length;
      const warnings = diagnostics.filter(d => d.severity === "warning").length;
      totalErrors += errors;
      totalWarnings += warnings;

      fileSummaries.push(`❌ \`${filename}\` — ${errors} error(s), ${warnings} warning(s)`);

      const linePositionMap = buildLinePositionMap(patch);

      for (const diag of diagnostics) {
        const line = diag.range.start.line + 1;
        const diffPosition = linePositionMap[line];

        if (diffPosition == null) {
          console.log(`    [line ${line}] ${diag.severity}: ${diag.message} (not in diff, skipped)`);
          continue;
        }

        reviewComments.push({
          path: filename,
          position: diffPosition,
          body: formatComment(diag),
        });
      }
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    const summaryHeader = totalErrors + totalWarnings === 0
      ? "## ✅ XML Review — All files valid"
      : `## ❌ XML Review — ${totalErrors} error(s), ${totalWarnings} warning(s) found`;

    const summary = [
      "<!-- xml-pr-review -->",
      summaryHeader,
      "",
      "| File | Result |",
      "|------|--------|",
      ...fileSummaries.map(s => {
        const [icon, ...rest] = s.split(" ");
        return `| ${rest.join(" ")} | ${icon} |`;
      }),
      "",
      "_Powered by [xml-language-service](https://www.npmjs.com/package/xml-language-service) (Apache Xerces WASM)._",
    ].join("\n");

    await postReview(reviewComments, summary);
    console.log(`\nReview posted — ${reviewComments.length} inline comment(s).`);

    if (totalErrors > 0) process.exit(1);

  } finally {
    ls.dispose();
  }
}

main().catch(err => {
  console.error("xml-pr-review failed:", err);
  process.exit(1);
});
