# xml-pr-review-bot

A GitHub Action that validates XML files in pull requests and posts inline review comments on the exact line of each error. Powered by [xml-language-service](https://www.npmjs.com/package/xml-language-service) and [xerces-wasm](https://www.npmjs.com/package/xerces-wasm) (Apache Xerces-C++ compiled to WebAssembly).

---

## How it works

When a PR touches any `.xml` file, the Action:

1. **Detects** all changed XML files in the PR via the GitHub API (paginated, so large PRs work)
2. **Resolves the schema**:
   - custom schemas from `.xml-review.json` first
   - `pom.xml` and `web.xml` by file name, with zero config
   - any file whose root `xmlns` is the Maven POM or Java EE namespace (e.g. `parent-pom.xml`)
   - files with no schema still get a **well-formedness check** by Xerces
3. **Validates** each file with Xerces, catching syntax errors and XSD violations in one pass
4. **Posts inline review comments** on the changed lines of the diff
5. **Posts a summary table** with pass/fail per file; issues on lines outside the diff are listed in a collapsible section instead of being dropped
6. **Annotates** every issue in the Actions log and writes the summary to the job summary page
7. **Fails the check** when errors are found (warnings do not fail the build)

---

## Demo

### Inline comment on an invalid element

> 🔴 **XML error** (`xsd`)
>
> no declaration found for element 'scop'

### Summary comment

| File | Result |
|------|--------|
| `pom.xml` | ❌ 4 error(s), 0 warning(s) |
| `web.xml` | ✅ no issues |

---

## Setup

### 1. Copy these files into your repo

```
your-repo/
├── .github/
│   └── workflows/
│       └── xml-review.yml
├── src/
│   ├── lib.mjs
│   └── review.mjs
├── test/
│   └── lib.test.mjs
├── package.json
└── package-lock.json
```

### 2. Enable write permissions for Actions

Go to **Settings → Actions → General → Workflow permissions** and select **Read and write permissions**. This lets the bot post PR reviews with `GITHUB_TOKEN`; no extra secrets are needed.

### 3. That's it for `pom.xml` / `web.xml`

| Filename / namespace | Schema |
|----------|--------|
| `pom.xml` or `http://maven.apache.org/POM/4.0.0` | Maven 4.0.0 XSD |
| `web.xml` or `http://xmlns.jcp.org/xml/ns/javaee` | Servlet 3.1 XSD |

---

## Dependencies

| Package | Version | Role |
|---------|---------|------|
| `xml-language-service` | `^1.1.0` | XML parsing, schema registry, diagnostic ranges |
| `xerces-wasm` | `^2.0.2` | Xerces-C++ WASM validator with in-memory grammar caching |

`xml-language-service@1.1.0` declares `xerces-wasm@^1.0.0`. `package.json` uses an npm `overrides` entry so the whole tree runs on `xerces-wasm` 2.x, whose `validate()` API is backward compatible. The lockfile pins exact versions and the workflow installs with `npm ci`, so every run uses the same build.

---

## Custom schemas and ignores

Add `.xml-review.json` to the repo root:

```json
{
  "schemas": [
    { "pattern": "**/*.config.xml", "xsd": "schemas/config.xsd" }
  ],
  "ignore": ["**/generated/**", "**/test-data/**"]
}
```

- `schemas`: glob → XSD path (relative to the repo root). Checked before the built-ins.
- `ignore`: globs of XML files the bot should skip.

---

## Run it locally

```bash
npm ci
node src/review.mjs --local pom.xml path/to/other.xml   # prints the summary, exit 1 on errors
npm test                                                # unit + integration tests
```

---

## Stability features

- **Retries** GitHub API calls on network errors, 5xx, 429 and rate limits, with exponential backoff and a 30s timeout per request
- **Per-file isolation**: an unreadable file or a crashing schema is reported as ⚠️ in the summary instead of aborting the review
- **Review fallback**: if GitHub rejects the review with inline comments (422), the summary is posted on its own
- **Fork PRs**: `GITHUB_TOKEN` is read-only there, so posting fails; the job still annotates every issue and writes the job summary, and fails on errors
- **Duplicate suppression**: Xerces often reports the same problem twice; duplicates are merged
- **Comment cap**: at most 50 inline comments per review; the rest are counted in the summary
- **Markdown escaping** of Xerces messages so element names like `<scope>` render correctly
- **Built-in XSD lookup**: `xml-language-service@1.1.0` looks for its bundled XSDs in the wrong folder, so the bot locates them itself
- **Concurrency**: a new push cancels the review of the previous commit
- **Self-test** step runs `npm test` before the reviewer so a broken install never produces a false pass

---

## How inline comments work

GitHub only accepts review comments on lines that appear in the PR diff. The bot parses each file's unified diff to find those lines (added and context lines) and posts comments with `line` + `side: "RIGHT"`.

Issues on untouched lines are listed under **"issue(s) not shown inline"** in the summary.

---

## Requirements

- Node.js 18 or later (the workflow uses Node 22)
- A GitHub repository with Actions enabled
