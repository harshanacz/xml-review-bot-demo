# xml-pr-review-bot

A GitHub Action that automatically reviews XML files in pull requests using
[xml-language-service](https://www.npmjs.com/package/xml-language-service).

## What it does

When a PR touches any `.xml` file, this Action:

1. **Detects** all changed XML files in the PR
2. **Auto-resolves** the schema — `pom.xml` and `web.xml` work with zero config (built-in schemas)
3. **Validates** each file via Xerces WASM (syntax + XSD schema errors in one pass)
4. **Posts inline review comments** at the exact line of each error/warning
5. **Posts a summary table** showing which files passed and which failed
6. **Fails the CI check** if any errors are found (warnings pass)

## Setup

### 1. Copy files into your repo

```
your-repo/
├── .github/
│   └── workflows/
│       └── xml-review.yml   ← copy this
└── src/
    └── review.mjs           ← copy this
```

### 2. That's it for pom.xml / web.xml

No configuration needed. The built-in schemas are auto-matched by filename.

### 3. Custom schemas (optional)

To validate your own XML formats, add schema registration before `main()` runs:

```js
// In src/review.mjs, after getLanguageService():
ls.addUserAssociation({
  pattern: "**/*.config.xml",
  uri: "file:///my-config-schema.xsd",
});
await ls.registerSchema({
  uri: "file:///my-config-schema.xsd",
  xsdText: readFileSync("schemas/my-config.xsd", "utf8"),
});
```

## How inline comments work

GitHub's PR review API requires a **diff position** (not a raw line number) for inline comments.
The script parses each file's diff hunk to build a `line → diffPosition` map, so comments
appear exactly on the right line in the PR diff view.

If a diagnostic falls on a line that isn't part of the diff (e.g. a pre-existing error in an
unchanged block), it's logged to the Action console but not posted as an inline comment.

## Output examples

### Summary comment (always posted)

| File | Result |
|------|--------|
| `pom.xml` | ❌ |
| `web.xml` | ✅ |

### Inline comment (on the offending line)

> 🔴 **XML error** (`xsd`)
>
> cvc-complex-type.2.4.a: Invalid content was found starting with element 'badElement'.

## Permissions

The workflow uses `GITHUB_TOKEN` — no extra secrets needed. Make sure your repo settings
allow Actions to create PR reviews (Settings → Actions → General → Workflow permissions →
set to "Read and write").
