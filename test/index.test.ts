import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMailSendMethodCalls,
  deriveUsingFromMethodCalls,
  ensureConfig,
  JMAP_CAPABILITIES,
  resolveSessionDiscoveryUrls,
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
  ]);

  assert.deepEqual(using, [
    JMAP_CAPABILITIES.core,
    JMAP_CAPABILITIES.mail,
    JMAP_CAPABILITIES.submission,
    JMAP_CAPABILITIES.calendars,
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
