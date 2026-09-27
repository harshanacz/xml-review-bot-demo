/**
 * xml-pr-review: GitHub Action script
 *
 * For each XML file changed in a PR:
 *   1. Resolves its schema (pom.xml / web.xml by name or xmlns, or a custom
 *      schema from .xml-review.json). Files without a schema get a
 *      well-formedness check only.
 *   2. Validates with xml-language-service (Xerces-C++ via xerces-wasm)
 *   3. Posts inline PR review comments on the exact line of each diagnostic
 *   4. Posts a summary (also written to the Actions job summary)
 *
 * Local usage (no GitHub needed):
 *   node src/review.mjs --local pom.xml other.xml
 */

import { getLanguageService } from "xml-language-service";
import { readFileSync, appendFileSync } from "fs";
import { resolve } from "path";
import {
  MAX_INLINE_COMMENTS,
  buildSummary,
  commentableLines,
  countBySeverity,
  formatComment,
  isIgnored,
  loadConfig,
  validateXml,
} from "./lib.mjs";

const WORKSPACE = process.env.GITHUB_WORKSPACE ?? process.cwd();

// ─── GitHub REST API with retries ─────────────────────────────────────────────
function githubClient({ token, repo, apiUrl = "https://api.github.com" }) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function request(path, { method = "GET", body } = {}) {
    const url = path.startsWith("http") ? path : `${apiUrl}/repos/${repo}${path}`;
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** attempt);
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "xml-pr-review-bot",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        lastErr = err;                      // network error / timeout: retry
        continue;
      }
      if (res.ok) return { data: res.status === 204 ? null : await res.json(), headers: res.headers };

      const text = await res.text();
      const err = new Error(`GitHub API ${method} ${path} -> ${res.status}: ${text}`);
      err.status = res.status;
      // Retry only on transient errors; 4xx (bad request, forbidden) are final.
      const rateLimited = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
      if (res.status >= 500 || res.status === 429 || rateLimited) { lastErr = err; continue; }
      throw err;
    }
    throw lastErr;
  }

  async function paginate(path) {
    const items = [];
    let next = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next) {
      const { data, headers } = await request(next);
      items.push(...data);
      next = headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return items;
  }

  return { request, paginate };
}

// ─── Validation of a set of files ─────────────────────────────────────────────
async function reviewFiles(ls, files, userSchemas) {
  const results = [];
  const inline = [];

  for (const { filename, localPath, patch } of files) {
    let xmlText;
    try {
      xmlText = readFileSync(localPath, "utf8");
    } catch (err) {
      console.warn(`::warning file=${filename}::Could not read file: ${err.message}`);
      results.push({ filename, status: "failed", note: "could not read file" });
      continue;
    }

    let diagnostics, schema;
    try {
      ({ diagnostics, schema } = await validateXml(ls, filename, xmlText, userSchemas));
    } catch (err) {
      // One broken schema or file must never take down the whole review.
      console.warn(`::warning file=${filename}::Validation crashed: ${err.stack ?? err}`);
      results.push({ filename, status: "failed", note: "validator error, see Action log" });
      continue;
    }

    const mode = schema ? `schema ${schema}` : "well-formedness only";
    console.log(`  ${filename} (${mode}): ${diagnostics.length} diagnostic(s)`);

    for (const d of diagnostics) {
      const line = d.range.start.line + 1;
      const level = d.severity === "error" ? "error" : "warning";
      // Workflow commands give annotations even when review posting fails (forks).
      console.log(`::${level} file=${filename},line=${line},col=${d.range.start.character + 1}::${d.message}`);
    }

    if (diagnostics.length === 0) {
      results.push({ filename, status: "ok", errors: 0, warnings: 0, note: schema ? undefined : "well-formed (no schema)" });
      continue;
    }

    const { errors, warnings } = countBySeverity(diagnostics);
    const allowed = commentableLines(patch);
    const outsideDiff = [];

    // One comment per line: Xerces often reports several related problems
    // (e.g. "no declaration" + "not allowed for content model") on one line.
    const byLine = new Map();
    for (const d of diagnostics) {
      const line = d.range.start.line + 1;
      if (!allowed.has(line)) { outsideDiff.push(d); continue; }
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(formatComment(d));
    }
    for (const [line, bodies] of byLine) {
      inline.push({ path: filename, line, side: "RIGHT", body: bodies.join("\n\n") });
    }

    results.push({ filename, status: "issues", errors, warnings, outsideDiff });
  }

  return { results, inline };
}

// ─── Local mode ───────────────────────────────────────────────────────────────
async function runLocal(paths) {
  const ls = getLanguageService();
  const config = loadConfig(WORKSPACE);
  try {
    const files = paths.map(p => ({ filename: p, localPath: resolve(WORKSPACE, p), patch: undefined }));
    const { results } = await reviewFiles(ls, files, config.schemas);
    const { body, totalErrors } = buildSummary(results);
    console.log(`\n${body}`);
    return totalErrors > 0 ? 1 : 0;
  } finally {
    ls.dispose();
  }
}

// ─── PR mode ──────────────────────────────────────────────────────────────────
async function runPullRequest() {
  const env = {
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPOSITORY,
    prNumber: Number(process.env.PR_NUMBER),
    headSha: process.env.HEAD_SHA,
    apiUrl: process.env.GITHUB_API_URL,
  };
  const missing = ["token", "repo", "headSha"].filter(k => !env[k]);
  if (!Number.isInteger(env.prNumber) || env.prNumber <= 0) missing.push("prNumber");
  if (missing.length) {
    throw new Error(`Missing required environment: ${missing.join(", ")}. ` +
      "Run inside the pull_request workflow, or use --local <files> for a local check.");
  }

  const gh = githubClient(env);
  const config = loadConfig(WORKSPACE);

  const prFiles = await gh.paginate(`/pulls/${env.prNumber}/files`);
  const changed = prFiles
    .filter(f => f.status !== "removed" && /\.xml$/i.test(f.filename))
    .filter(f => !isIgnored(f.filename, config.ignore))
    .map(f => ({ filename: f.filename, localPath: resolve(WORKSPACE, f.filename), patch: f.patch }));

  if (changed.length === 0) {
    console.log("No XML files changed in this PR, nothing to review.");
    return 0;
  }
  console.log(`Reviewing ${changed.length} XML file(s)...`);

  const ls = getLanguageService();

  let results, inline;
  try {
    ({ results, inline } = await reviewFiles(ls, changed, config.schemas));
  } finally {
    ls.dispose();
  }

  const truncated = Math.max(0, inline.length - MAX_INLINE_COMMENTS);
  const comments = inline.slice(0, MAX_INLINE_COMMENTS);
  const { body, totalErrors } = buildSummary(results, { truncated });

  writeJobSummary(body);

  try {
    const posted = await postReview(gh, env, body, comments);
    console.log(`\nReview posted with ${posted} inline comment(s).`);
  } catch (err) {
    // Fork PRs get a read-only token (403). Annotations and the job summary
    // above still surface every issue, so do not fail on this alone.
    console.warn(`::warning::Could not post PR review: ${err.message}`);
  }

  return totalErrors > 0 ? 1 : 0;
}

async function postReview(gh, env, body, comments) {
  const review = event => ({ commit_id: env.headSha, body, event, comments });
  const event = comments.length > 0 ? "REQUEST_CHANGES" : "COMMENT";
  try {
    await gh.request(`/pulls/${env.prNumber}/reviews`, { method: "POST", body: review(event) });
    return comments.length;
  } catch (err) {
    if (err.status !== 422) throw err;
    // 422: a comment line is not in the diff, or REQUEST_CHANGES is not
    // allowed for this token. Fall back to a plain summary so the PR still
    // gets feedback.
    console.warn(`::warning::Review rejected (${err.message}); posting summary only.`);
    await gh.request(`/pulls/${env.prNumber}/reviews`, {
      method: "POST",
      body: { commit_id: env.headSha, body, event: "COMMENT" },
    });
    return 0;
  }
}

function writeJobSummary(body) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try { appendFileSync(file, `${body}\n`); } catch { /* best effort */ }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const run = args[0] === "--local" ? () => runLocal(args.slice(1)) : runPullRequest;

run()
  .then(code => { process.exitCode = code; })
  .catch(err => {
    console.error("::error::xml-pr-review failed:", err.stack ?? err);
    process.exitCode = 1;
  });
