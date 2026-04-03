---
name: stalwart-jmap
description: Use the Stalwart JMAP plugin tools for Stalwart-hosted mail, calendar, and contacts. This plugin exposes full read/write capabilities. Resolve ids before acting, prefer typed tools, and use Stalwart/JMAP-specific filter semantics.
metadata: { "openclaw": { "emoji": "🦀" } }
---

# Stalwart JMAP

Use this skill when the user is working with a Stalwart server through the `stalwart-jmap` plugin: reading mail, sending mail, querying calendars, RSVPing, or managing contacts.

## Core Rules

- Prefer the typed `stalwart_*` tools. Use `stalwart_jmap_request` only when no typed tool fits.
- This plugin is full read/write, not read-only. Use its send, update, create, destroy, and RSVP tools when the user asks for changes.
- Do not invent `accountId`, `mailboxId`, `identityId`, `calendarId`, `addressBookId`, or participant ids. Resolve them first.
- `accountId` is usually optional. Let the plugin resolve it unless the user provides an explicit override.
- For JMAP auth, Stalwart supports OAuth bearer tokens and mailbox username/password. Do not assume Stalwart API keys work for JMAP.

## Mail

For mailbox-specific reads:

1. Use `stalwart_mailbox_get` first if the mailbox id is not already known.
2. Use `stalwart_mail_query` to get ids.
3. Use `stalwart_mail_get` to fetch the messages.

For send flows:

1. Use `stalwart_identity_get` first if the sending identity is unclear.
2. Use `stalwart_mail_send`.

For updates like moving mail or flags:

- Use `stalwart_mail_update`.

Mail query filter rules:

- Pass a filter object, not a JSON string.
- `hasKeyword` and `notKeyword` are single strings, not arrays.
- Unread mail means `notKeyword: "$seen"`.
- Read mail means `hasKeyword: "$seen"`.
- Do not use `$Unread`.

Examples:

```json
{ "filter": { "inMailbox": "mailbox-id", "notKeyword": "$seen" }, "limit": 10 }
```

```json
{ "filter": { "inMailbox": "mailbox-id", "hasKeyword": "$seen" }, "limit": 10 }
```

## Calendar

For calendar reads:

1. Use `stalwart_calendar_get` first if the calendar id is not already known.
2. Use `stalwart_calendar_event_query` for ids.
3. Use `stalwart_calendar_event_get` for event objects.

For event create/update:

- Use `stalwart_calendar_event_set`.

For RSVP or scheduling identity issues:

1. Use `stalwart_participant_identity_get` if the acting participant is unclear.
2. Use `stalwart_calendar_event_rsvp` for accept/tentative/decline/reset flows.

## Contacts

For contact reads:

1. Use `stalwart_addressbook_get` first if the address book is unclear.
2. Use `stalwart_contact_query` for ids.
3. Use `stalwart_contact_get` for full cards.

For contact writes:

- Use `stalwart_contact_set`.

## Failure Recovery

- If a typed tool returns a JMAP error about missing ids or account resolution, call the relevant discovery tool first and retry with the resolved id.
- If a query fails due to filter shape, rewrite the filter to valid JMAP structure instead of retrying the same payload.
