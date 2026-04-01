import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDefaultContainerIds,
  buildMailSendMethodCalls,
  buildCalendarEventRsvpPatch,
  deriveUsingFromMethodCalls,
  ensureConfig,
  JMAP_CAPABILITIES,
  normalizeQueryFilter,
  normalizeQuerySort,
  resolveSessionDiscoveryUrls,
  scheduleIdsMatch,
  StalwartJmapClient,
} from "../index.js";

test("ensureConfig accepts accessToken auth without username", () => {
  const cfg = ensureConfig({
    sessionUrl: "https://mail.example.com/jmap",
    accessToken: "token-1",
  });

  assert.equal(cfg.sessionUrl, "https://mail.example.com/jmap");
  assert.equal(cfg.accessToken, "token-1");
  assert.equal(cfg.username, undefined);
});

test("resolveSessionDiscoveryUrls expands a base URL into both discovery candidates", () => {
  assert.deepEqual(resolveSessionDiscoveryUrls({ baseUrl: "https://mail.example.com/", timeoutMs: 30000 }), [
    "https://mail.example.com/.well-known/jmap",
    "https://mail.example.com/jmap",
  ]);
});

test("deriveUsingFromMethodCalls keeps only required capabilities", () => {
  const using = deriveUsingFromMethodCalls([
    ["Email/set", {}, "c1"],
    ["EmailSubmission/set", {}, "c2"],
    ["CalendarEvent/get", {}, "c3"],
    ["AddressBook/get", {}, "c4"],
    ["ParticipantIdentity/get", {}, "c5"],
  ]);

  assert.deepEqual(using, [
    JMAP_CAPABILITIES.core,
    JMAP_CAPABILITIES.mail,
    JMAP_CAPABILITIES.submission,
    JMAP_CAPABILITIES.calendars,
    JMAP_CAPABILITIES.contacts,
  ]);
});

test("buildMailSendMethodCalls produces RFC 8621-compliant text body wiring", () => {
  const calls = buildMailSendMethodCalls({
    accountId: "A1",
    identityId: "I1",
    mailboxId: "M-sent",
    mail: {
      to: [{ email: "jane@example.com" }],
      subject: "Hello",
      text: "Plain body",
    },
  });
  const emailSetCall = calls[0];
  assert.ok(emailSetCall);

  const emailSetArgs = emailSetCall[1] as {
    create: Record<
      string,
      {
        mailboxIds: Record<string, boolean>;
        bodyValues: Record<string, { value: string }>;
        textBody: Array<{ partId: string; type: string }>;
      }
    >;
  };
  const created = emailSetArgs.create["email-1"];
  assert.ok(created);

  assert.deepEqual(created.mailboxIds, { "M-sent": true });
  assert.deepEqual(created.bodyValues, {
    body1: {
      value: "Plain body",
    },
  });
  assert.deepEqual(created.textBody, [{ partId: "body1", type: "text/plain" }]);
});

test("applyDefaultContainerIds injects a default id only when the object omits one", () => {
  const create = applyDefaultContainerIds(
    {
      contact1: { firstName: "Ada" },
      contact2: { firstName: "Grace", addressBookIds: { existing: true } },
    },
    "addressBookIds",
    "ab-default",
  );

  assert.deepEqual(create, {
    contact1: {
      firstName: "Ada",
      addressBookIds: { "ab-default": true },
    },
    contact2: {
      firstName: "Grace",
      addressBookIds: { existing: true },
    },
  });
});

test("buildCalendarEventRsvpPatch encodes participant ids and emits RSVP fields", () => {
  const patch = buildCalendarEventRsvpPatch({
    participantId: "mailto:ada/example~1",
    participationStatus: "tentative",
    participationComment: "Reviewing",
    expectReply: false,
  });

  assert.deepEqual(patch, {
    "participants/mailto:ada~1example~01/participationStatus": "tentative",
    "participants/mailto:ada~1example~01/participationComment": "Reviewing",
    "participants/mailto:ada~1example~01/expectReply": false,
  });
});

test("normalizeQueryFilter parses stringified JSON objects", () => {
  assert.deepEqual(normalizeQueryFilter('{"inMailbox":"mbox-1"}'), {
    inMailbox: "mbox-1",
  });
});

test("normalizeQuerySort parses stringified JSON arrays", () => {
  assert.deepEqual(normalizeQuerySort('[{"property":"receivedAt","isAscending":false}]'), [
    { property: "receivedAt", isAscending: false },
  ]);
});

test("normalizeQueryFilter rejects non-object JSON", () => {
  assert.throws(
    () => normalizeQueryFilter('"mbox-1"'),
    /stalwart-jmap: filter must be a JSON object/,
  );
});

test("scheduleIdsMatch does not lowercase mailto local parts", () => {
  assert.equal(scheduleIdsMatch("mailto:User@example.com", "mailto:user@example.com"), false);
  assert.equal(scheduleIdsMatch("mailto:user@example.com", "mailto:user@example.com"), true);
});

test("scheduleIdsMatch tolerates scheme and host case differences for hierarchical URIs", () => {
  assert.equal(
    scheduleIdsMatch("HTTPS://Calendar.Example.com/events/abc?view=1", "https://calendar.example.com/events/abc?view=1"),
    true,
  );
});

test("session discovery falls back from /.well-known/jmap to /jmap", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];

  globalThis.fetch = async (input) => {
    const url = String(input);
    seenUrls.push(url);

    if (url.endsWith("/.well-known/jmap")) {
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }

    return new Response(
      JSON.stringify({
        apiUrl: "https://mail.example.com/jmap/api",
        capabilities: {
          [JMAP_CAPABILITIES.core]: {},
          [JMAP_CAPABILITIES.mail]: {},
        },
        primaryAccounts: {
          [JMAP_CAPABILITIES.mail]: "mail-account-1",
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const client = new StalwartJmapClient(
      ensureConfig({
        baseUrl: "https://mail.example.com",
        accessToken: "token-1",
      }),
    );

    const session = await client.session();
    assert.equal(session.apiUrl, "https://mail.example.com/jmap/api");
    assert.deepEqual(seenUrls, [
      "https://mail.example.com/.well-known/jmap",
      "https://mail.example.com/jmap",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
