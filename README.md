# BentoLabs docs

Public documentation for the BentoLabs platform and SDKs. Built on [Mintlify](https://mintlify.com).

Live site: [docs.bentolabs.ai](https://docs.bentolabs.ai)

## Local development

Install the Mintlify CLI (requires Node 19 to 24, **not** Node 26+):

```bash
npm install -g mint
```

Preview locally:

```bash
mint dev
```

Opens at `http://localhost:3000`. Hot-reloads on file save.

## Repo layout

```
docs.json              Mintlify configuration (theme, navigation, SEO)
index.mdx              Landing page
quickstart.mdx         Three-step onboarding
changelog.mdx          SDK release notes
404.mdx                Not-found page
concepts/              Cross-cutting docs (attribute mapping, troubleshooting)
python/                Python SDK reference
typescript/            TypeScript SDK reference
snippets/              Reusable MDX fragments (imported via /snippets/<name>.mdx)
logo/                  Light + dark brand marks
images/                Static assets
AGENTS.md              Contributor and style guide
.github/workflows/     CI: validate, broken-links, a11y
```

## Validation

Before pushing:

```bash
mint validate                                    # docs.json + MDX schema
mint broken-links --check-anchors --check-snippets
mint a11y                                        # alt text + contrast
```

CI runs all three on every PR. See `.github/workflows/docs-ci.yml`.

## Style

Read `AGENTS.md` before editing. Top rules:

- Active voice, second person
- Sentence case headings
- No em dashes (use period, comma, colon, or hyphen)
- Bold for UI elements: Click **Settings**
- Code formatting for file names, commands, paths

## Reusable snippets

Repeated content lives in `/snippets/`. Import with an absolute path:

```mdx
import InstallPython from "/snippets/install-python.mdx";

<InstallPython />
```

Existing snippets: `install-python`, `install-typescript`, `install-sdk` (both), `api-key-setup`, `track-ai-canonical`.

## Deployment

Pushes to `main` deploy automatically via the Mintlify GitHub app. PRs get a preview URL.

## Contact

[support@bentolabs.ai](mailto:support@bentolabs.ai)
