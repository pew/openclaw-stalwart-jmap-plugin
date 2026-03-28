# AGENTS.md

## Scope

This repository contains one native OpenClaw tool plugin for Stalwart JMAP.

Current layout:

- `index.ts`: plugin entry and JMAP client
- `openclaw.plugin.json`: manifest and config schema
- `package.json`: package metadata and OpenClaw entrypoint metadata
- `test/index.test.ts`: narrow behavior tests

## Working rules

- Preserve the native OpenClaw plugin shape:
  - manifest in repo root
  - built runtime at `dist/index.js`
  - `package.json.openclaw.extensions` must point at the built file, not the TypeScript source
- Keep config in `plugins.entries.stalwart-jmap.config`
- Prefer OAuth bearer tokens over Basic auth
- Do not claim Stalwart API keys work for JMAP; they do not
- Keep typed tools small and literal. Use the raw JMAP tool only as an escape hatch
- For mail/calendar/contact changes, verify the required JMAP capability URNs and account resolution path

## Verification

Run the narrow checks first:

```bash
npm run check
npm test
```

If you change package metadata or distribution shape, also inspect:

```bash
npm pack --dry-run
```

## Documentation expectations

- README should stay focused on OpenClaw installation, config, tool surface, and agent usage
- Keep references to Stalwart auth precise:
  - OAuth access token supported for JMAP
  - API keys are management-only
