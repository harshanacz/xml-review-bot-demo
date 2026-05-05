# xml-pr-review-bot

A GitHub Action that automatically validates XML files in pull requests and posts inline review comments at the exact line of each error — powered by [xml-language-service](https://www.npmjs.com/package/xml-language-service).

---

## How it works

When a PR touches any `.xml` file, the Action:

1. **Detects** all changed XML files in the PR via the GitHub API
2. **Resolves the schema** — `pom.xml` and `web.xml` are matched automatically with zero config
3. **Validates** each file using [xml-language-service](https://www.npmjs.com/package/xml-language-service) (Apache Xerces compiled to WASM), catching both syntax errors and XSD schema violations in one pass
4. **Posts inline review comments** pinned to the exact diff line of each error or warning
5. **Posts a summary table** showing pass/fail status for every XML file in the PR
6. **Fails the CI check** when errors are found — warnings do not fail the build

---

## Demo

### Inline comment on an invalid element

> 🔴 **XML error** (`xsd`)
>
> `no declaration found for element 'deployTarget'`

### Summary comment

| File | Result |
|------|--------|
| `pom.xml` | ❌ 2 error(s), 0 warning(s) |
| `web.xml` | ✅ |

---

## Setup

### 1. Copy the two files into your repo

```
your-repo/
├── .github/
│   └── workflows/
│       └── xml-review.yml
└── src/
    └── review.mjs
```

### 2. Enable write permissions for Actions

Go to **Settings → Actions → General → Workflow permissions** and set it to **Read and write permissions**. This allows the bot to post PR review comments using `GITHUB_TOKEN` — no extra secrets needed.

### 3. That's it for `pom.xml` / `web.xml`

The built-in schemas are matched by filename automatically:

| Filename | Schema |
|----------|--------|
| `pom.xml` | Maven 4.0.0 XSD |
| `web.xml` | Servlet 3.1 XSD |

---

## Workflow file

```yaml
name: XML PR Review

on:
  pull_request:
    paths:
      - "**/*.xml"   # only runs when XML files are touched

permissions:
  contents:      read
  pull-requests: write

jobs:
  xml-review:
    name: Validate XML files
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - run: npm install xml-language-service

      - name: Run XML reviewer
        env:
          GITHUB_TOKEN:      ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          PR_NUMBER:         ${{ github.event.pull_request.number }}
          GITHUB_WORKSPACE:  ${{ github.workspace }}
          HEAD_SHA:          ${{ github.event.pull_request.head.sha }}
        run: node src/review.mjs
```

---

## Adding custom schemas

To validate your own XML formats, register a schema inside `src/review.mjs` before the main validation loop:

```js
// After getLanguageService():
const MY_SCHEMA_URI = "file:///my-schema.xsd";

ls.addUserAssociation({
  pattern: "**/*.config.xml",
  uri: MY_SCHEMA_URI,
});

await ls.registerSchema({
  uri: MY_SCHEMA_URI,
  xsdText: readFileSync("schemas/my-config.xsd", "utf8"),
});
```

---

## How inline comments work

GitHub's review API requires a **diff position** (not a raw line number) to anchor inline comments. The script parses each file's unified diff hunk to build a `line → diffPosition` map so comments land on the exact changed line in the PR diff view.

If an error falls on a line that wasn't changed in the PR (e.g. a pre-existing issue in an untouched block), it is logged to the Action console but skipped as an inline comment — GitHub does not allow commenting outside the diff.

---

## Tech stack

| Component | Role |
|-----------|------|
| [xml-language-service](https://www.npmjs.com/package/xml-language-service) | XML parsing, XSD schema validation via Apache Xerces WASM |
| GitHub Actions | CI runner and event trigger |
| GitHub REST API | Fetching changed files, posting PR reviews |
| `GITHUB_TOKEN` | Auth — no extra secrets required |

---

## Requirements

- Node.js 18 or later (the workflow pins Node 20)
- A GitHub repository with Actions enabled
