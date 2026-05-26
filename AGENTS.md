# BentoLabs docs

Public documentation site for the BentoLabs platform and SDKs. Built on [Mintlify](https://mintlify.com).

## Project layout

- Pages are MDX files with YAML frontmatter
- Configuration lives in `docs.json`
- Source of truth for SDK surfaces lives in this repo's siblings:
  - Python: `../sdk/python/` (see `README.md` and `INTEGRATION.md`)
  - TypeScript: `../sdk/typescript/packages/sdk/` (see `README.md`)
- Run `mint dev` to preview locally
- Run `mint broken-links` to check links

## Terminology

- "Workspace" not "project" (workspaces are the top-level Bento org)
- "Trace" / "span" are the OTel-native nouns
- "Trajectory" = one Bento `Interaction` (one outer span wrapping multi-step work)
- "Run" for user-facing copy referring to a single AI interaction
- API keys are `bl_pk_...` (publishable). The prefix is validated by the SDK.

## Style preferences

- Active voice, second person ("you")
- Sentence case for headings
- One idea per sentence
- Bold for UI elements: Click **Settings**
- Code formatting for file names, commands, paths, code references
- No em dashes in body copy. Use period, comma, colon, or hyphen.
- No emojis anywhere (not even decorative)

## Component conventions

- `<Steps>` for setup walkthroughs
- `<CodeGroup>` for multi-language code samples (Python + TypeScript)
- `<ParamField>` for API parameter documentation
- `<AccordionGroup>` for FAQ-style content
- `<CardGroup>` for landing-page navigation
- `<Tip>`, `<Info>`, `<Warning>` for callouts. Pick the lowest-severity level that fits.

## Reusable snippets

Repeated content lives in `/snippets/`. Import with an absolute path from the project root:

```mdx
import InstallPython from "/snippets/install-python.mdx";

<InstallPython />
```

Existing snippets:

- `install-python.mdx`: `pip install bentolabs-sdk` block
- `install-typescript.mdx`: `npm install @bentolabs/sdk ...` block
- `install-sdk.mdx`: both above wrapped in a `<CodeGroup>` for cross-language pages
- `api-key-setup.mdx`: the `bl_pk_` key explanation and export line
- `track-ai-canonical.mdx`: the reference `track_ai` example in both languages

Snippets that contain a `<CodeGroup>` cannot be nested inside another `<CodeGroup>`. Use the single-language snippets when wrapping in your own `CodeGroup`.

## CI

`.github/workflows/docs-ci.yml` runs on every PR:

- `mint validate`: schema and MDX validity
- `mint broken-links --check-anchors --check-snippets`: internal link health
- `mint a11y`: alt text and contrast (non-blocking)

Run locally before pushing:

```bash
mint dev               # preview at localhost:3000
mint broken-links      # internal link check
mint validate          # full validation
```

Requires Node 19 or higher and **not** Node 26+.

## Content boundaries

- Don't document internal endpoints or admin features
- Don't expose product roadmap or unreleased features
- SDK reference must match the actual shipped surface. When in doubt, check the SDK source.

## Mintlify product knowledge

For component reference, configuration, and writing standards, install the Mintlify skill:

```bash
npx skills add https://mintlify.com/docs
```
