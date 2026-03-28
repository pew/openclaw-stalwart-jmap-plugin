# OpenClaw Stalwart JMAP plugin

Native OpenClaw plugin for Stalwart JMAP. It adds typed tools for:

- email reads and updates
- email sending
- mailbox and identity discovery
- calendar reads and writes
- contact reads
- raw JMAP requests when a typed wrapper is missing

## Install

Local development install:

```bash
npm install
npm run build
openclaw plugins uninstall stalwart-jmap
openclaw plugins install -l /path/to/stalwart-jmap-plugin
openclaw gateway restart
```

Published package install:

```bash
openclaw plugins install stalwart-jmap
openclaw gateway restart
```

Use `-l` during development so OpenClaw uses the repo directly instead of a copied snapshot.

## Configure

Configure the plugin under `plugins.entries.stalwart-jmap.config`.

If your Stalwart deployment exposes an explicit JMAP session endpoint such as:

```text
https://mail.example.com/jmap/session
```

So use `sessionUrl`, not `baseUrl`.

### Recommended working config

Use the exact JMAP session URL and either:

- `username` + `password`
- or an OAuth `accessToken`

Equivalent `openclaw config set` commands:

```bash
openclaw config set plugins.entries.stalwart-jmap.enabled true --strict-json
openclaw config set plugins.entries.stalwart-jmap.config.sessionUrl "https://mail.example.com/jmap/session"
openclaw config set plugins.entries.stalwart-jmap.config.username "you@example.com"
openclaw config set plugins.entries.stalwart-jmap.config.password "REPLACE_WITH_PASSWORD"
openclaw gateway restart
```

Equivalent JSON:

```json
{
  "plugins": {
    "entries": {
      "stalwart-jmap": {
        "enabled": true,
        "config": {
          "sessionUrl": "https://mail.example.com/jmap/session",
          "username": "you@example.com",
          "password": "REPLACE_WITH_PASSWORD"
        }
      }
    }
  }
}
```

OAuth token variant:

```bash
openclaw config set plugins.entries.stalwart-jmap.enabled true --strict-json
openclaw config set plugins.entries.stalwart-jmap.config.sessionUrl "https://mail.example.com/jmap/session"
openclaw config set plugins.entries.stalwart-jmap.config.accessToken "REPLACE_WITH_OAUTH_ACCESS_TOKEN"
openclaw gateway restart
```

## Important auth note

- Stalwart API keys are not JMAP credentials.
- Do not use a Stalwart admin/API token here.
- For JMAP, use either mailbox username/password or a real OAuth access token.
- `/jmap/session` is a discovery endpoint, not a token-issuing endpoint.

If `curl` with the same credentials works on the OpenClaw host but the plugin fails, the usual cause is stale OpenClaw install/config state. Reinstall with `-l`, verify the plugin config, and restart the gateway.

## Optional tool allowlist

If you run OpenClaw with `tools.allow`, include this plugin id:

```bash
openclaw config set tools.allow '["stalwart-jmap"]' --strict-json
openclaw gateway restart
```

If you intentionally allow all plugins and tools, you do not need this.

## Tools

Always available:

- `stalwart_jmap_session`
- `stalwart_mailbox_get`
- `stalwart_identity_get`
- `stalwart_mail_query`
- `stalwart_mail_get`
- `stalwart_calendar_get`
- `stalwart_calendar_event_query`
- `stalwart_calendar_event_get`
- `stalwart_contact_query`
- `stalwart_contact_get`

Optional or side-effecting:

- `stalwart_jmap_request`
- `stalwart_mail_send`
- `stalwart_mail_update`
- `stalwart_calendar_event_set`

## Smoke test

Ask OpenClaw to run:

```text
Use `stalwart_jmap_session` with {"refresh": true} and tell me whether the plugin is connected correctly.
```

Then verify:

1. `stalwart_mailbox_get`
2. `stalwart_identity_get`
3. `stalwart_mail_query`
4. `stalwart_mail_get`

## Will OpenClaw use this automatically?

Usually yes, if:

- the plugin is enabled
- the tools are available
- the request clearly matches the tool descriptions

So prompts like:

- "send an email to Alice"
- "check my latest email"
- "look up tomorrow's calendar events"

may be enough for OpenClaw to choose the Stalwart tools on its own.

But this is not guaranteed. Tool choice depends on the model and the rest of your configured tools.

## Do you need a SKILL?

No, not strictly.

The plugin works without a skill because the tools are already registered with descriptions.

A skill or agent instruction is still useful if you want OpenClaw to prefer Stalwart consistently for mail and calendar work. Add guidance like:

```md
When working with email, calendars, or contacts:
- Prefer the `stalwart-jmap` plugin tools.
- Start with `stalwart_jmap_session` if account ids or capabilities are unclear.
- Use `stalwart_mailbox_get` before mailbox-specific mail workflows.
- Use `stalwart_identity_get` before sending if the sender identity is unclear.
- Use `stalwart_mail_query` and `stalwart_mail_get` for mail reads.
- Use `stalwart_mail_send` for outbound mail.
- Use `stalwart_calendar_get`, `stalwart_calendar_event_query`, and `stalwart_calendar_event_set` for calendar work.
- Do not invent mailbox ids, account ids, or identity ids; resolve them first.
```

If you already maintain agent instructions or a skill pack, put that there. If not, the plugin can still be used directly.

## Repo verification

```bash
npm install
npm run check
npm test
npm run build
npm pack --dry-run
```
