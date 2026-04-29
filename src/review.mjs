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
import { readFileSync } from "fs";
import { resolve, basename } from "path";

// ─── GitHub context (injected by the Action runner) ─────────────────────────
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const REPO           = process.env.GITHUB_REPOSITORY;          // "owner/repo"
const PR_NUMBER      = Number(process.env.PR_NUMBER);
const WORKSPACE      = process.env.GITHUB_WORKSPACE ?? ".";
const HEAD_SHA       = process.env.HEAD_SHA;

// ─── Helper: GitHub REST API ─────────────────────────────────────────────────
async function ghFetch(path, method = "GET", body = undefined) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept:        "application/vnd.github+json",
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
      filename: f.filename,             // relative path in repo  e.g. "config/web.xml"
      localPath: resolve(WORKSPACE, f.filename),
    }));
}

// ─── Parse diff to map absolute line numbers → diff position ─────────────────
// GitHub inline comments need a "position" within the diff hunk, NOT a raw line number.
// This function builds a map: { absoluteLine → diffPosition }.
function buildLinePositionMap(patch) {
  if (!patch) return {};
  const map = {};
  let diffPos = 0;
  let fileLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      // @@ -a,b +c,d @@ — extract the new-file start line
      const m = line.match(/\+(\d+)/);
      fileLine = m ? Number(m[1]) - 1 : fileLine;
      diffPos++;
      continue;
    }
    if (line.startsWith("-")) { diffPos++; continue; } // removed line
    if (line.startsWith("+") || line.startsWith(" ")) {
      fileLine++;
      diffPos++;
      map[fileLine] = diffPos;
    }
  }
  return map;
}

// ─── Get diff metadata for each file in the PR ───────────────────────────────
async function getDiffMap() {
  const files = await ghFetch(`/pulls/${PR_NUMBER}/files`);
  const map = {};
  for (const f of files) {
    map[f.filename] = buildLinePositionMap(f.patch);
  }
  return map;
}

// ─── Delete all previous bot review comments on this PR ──────────────────────
async function clearPreviousBotComments() {
  const reviews = await ghFetch(`/pulls/${PR_NUMBER}/reviews`);
  const botReviews = reviews.filter(r =>
    r.user?.type === "Bot" || r.body?.includes("<!-- xml-pr-review -->")
  );
  for (const r of botReviews) {
    // Dismiss pending reviews, delete comment-only ones
    if (r.state === "PENDING") {
      await ghFetch(`/pulls/${PR_NUMBER}/reviews/${r.id}/dismissals`, "PUT", {
        message: "Superseded by new review",
      }).catch(() => {});
    }
  }
}

// ─── Post a PR Review with inline comments ────────────────────────────────────
async function postReview(comments, summary) {
  const event = comments.length > 0 ? "REQUEST_CHANGES" : "APPROVE";

  await ghFetch(`/pulls/${PR_NUMBER}/reviews`, "POST", {
    commit_id: HEAD_SHA,
    body: summary,
    event,
    comments: comments.map(c => ({
      path:     c.path,
      position: c.position,   // diff position (required by the API)
      body:     c.body,
    })),
  });
}

// ─── Format a single diagnostic into a Markdown comment ──────────────────────
function formatComment(diag) {
  const icon = diag.severity === "error" ? "🔴" : diag.severity === "warning" ? "🟡" : "🔵";
  const tag  = diag.source === "syntax" ? "`syntax`" : "`xsd`";
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
    const diffMap = await getDiffMap();

    let totalErrors   = 0;
    let totalWarnings = 0;
    const reviewComments = [];
    const fileSummaries  = [];

    for (const { filename, localPath } of changedFiles) {
      let xmlText;
      try {
        xmlText = readFileSync(localPath, "utf8");
      } catch {
        console.warn(`Could not read ${localPath} — skipping.`);
        continue;
      }

      // Parse (always succeeds, even on broken XML)
      const doc = ls.parseXMLDocument(`file:///${filename}`, xmlText);

      // Auto-resolve schema by filename (pom.xml, web.xml, or custom via addUserAssociation)
      const schemaInfo = ls.resolveSchemaForDocument(basename(filename));

      let diagnostics = [];

      if (schemaInfo) {
        if (!ls.hasSchema(schemaInfo.uri)) {
          await ls.registerSchema({ uri: schemaInfo.uri, xsdText: schemaInfo.xsdText });
        }
        diagnostics = await ls.validate(schemaInfo.uri, doc);
        console.log(`  ${filename}: schema=${schemaInfo.uri}, ${diagnostics.length} diagnostic(s)`);
      } else {
        console.log(`  ${filename}: no schema found, skipping XSD validation`);
      }

      if (diagnostics.length === 0) {
        fileSummaries.push(`✅ \`${filename}\` — no issues`);
        continue;
      }

      const linePositionMap = diffMap[filename] ?? {};
      const errors   = diagnostics.filter(d => d.severity === "error").length;
      const warnings = diagnostics.filter(d => d.severity === "warning").length;
      totalErrors   += errors;
      totalWarnings += warnings;

      fileSummaries.push(
        `❌ \`${filename}\` — ${errors} error(s), ${warnings} warning(s)`
      );

      for (const diag of diagnostics) {
        // Diagnostics use 0-based lines; diff positions are 1-based absolute lines
        const line         = diag.range.start.line + 1;
        const diffPosition = linePositionMap[line];

        if (diffPosition == null) {
          // Line is not in the diff — can't post an inline comment, log only
          console.log(`    [line ${line}] ${diag.severity}: ${diag.message} (not in diff, skipped)`);
          continue;
        }

        reviewComments.push({
          path:     filename,
          position: diffPosition,
          body:     formatComment(diag),
        });
      }
    }

    // ── Build summary comment ────────────────────────────────────────────────
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
      totalErrors + totalWarnings > 0
        ? "_Schema validation powered by [xml-language-service](https://www.npmjs.com/package/xml-language-service) (Apache Xerces WASM)._"
        : "_Validated by [xml-language-service](https://www.npmjs.com/package/xml-language-service)._",
    ].join("\n");

    await postReview(reviewComments, summary);

    console.log(`\nReview posted. ${reviewComments.length} inline comment(s).`);

    // Exit with error code if there are schema errors — fails the CI check
    if (totalErrors > 0) process.exit(1);

  } finally {
    ls.dispose();
  }
}

main().catch(err => {
  console.error("xml-pr-review failed:", err);
  process.exit(1);
});
