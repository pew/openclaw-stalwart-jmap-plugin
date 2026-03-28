import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";

export const JMAP_CAPABILITIES = {
  core: "urn:ietf:params:jmap:core",
  mail: "urn:ietf:params:jmap:mail",
  submission: "urn:ietf:params:jmap:submission",
  calendars: "urn:ietf:params:jmap:calendars",
  contacts: "urn:ietf:params:jmap:contacts",
} as const;

type JmapCapabilityKey = keyof typeof JMAP_CAPABILITIES;

export type PluginConfig = {
  baseUrl?: string;
  sessionUrl?: string;
  username?: string;
  password?: string;
  accessToken?: string;
  accountId?: string;
  identityId?: string;
  timeoutMs: number;
};

type JmapSession = {
  apiUrl: string;
  downloadUrl?: string;
  uploadUrl?: string;
  eventSourceUrl?: string;
  state?: string;
  capabilities?: Record<string, unknown>;
  primaryAccounts?: Record<string, string>;
  accounts?: Record<string, unknown>;
  username?: string;
};

type JmapResponse = {
  methodResponses: unknown[];
  createdIds?: Record<string, string>;
  sessionState?: string;
};

type JmapMethodCall = [string, Record<string, unknown>, string];

type Address = {
  email: string;
  name?: string;
};

type MailSendParams = {
  accountId?: string;
  identityId?: string;
  mailboxId?: string;
  from?: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address[];
  subject: string;
  text: string;
  keywords?: Record<string, boolean>;
};

type Rights = {
  mayWrite?: boolean;
  mayWriteAll?: boolean;
  mayWriteOwn?: boolean;
  mayRSVP?: boolean;
};

type NamedContainer = {
  id?: string;
  name?: string;
  role?: string;
  isDefault?: boolean;
  myRights?: Rights;
};

type ParticipantIdentity = {
  id?: string;
  name?: string;
  scheduleId?: string;
  sendTo?: Record<string, string>;
  isDefault?: boolean;
};

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function resolveSessionDiscoveryUrls(cfg: PluginConfig): string[] {
  if (cfg.sessionUrl) {
    return [normalizeUrl(cfg.sessionUrl)];
  }

  if (!cfg.baseUrl) {
    throw new Error("stalwart-jmap: configure baseUrl or sessionUrl");
  }

  const baseUrl = normalizeUrl(cfg.baseUrl);
  if (baseUrl.endsWith("/.well-known/jmap") || baseUrl.endsWith("/jmap")) {
    return [baseUrl];
  }

  return [`${baseUrl}/.well-known/jmap`, `${baseUrl}/jmap`];
}

export function ensureConfig(input: unknown): PluginConfig {
  const cfg = (input ?? {}) as Record<string, unknown>;
  const baseUrl = typeof cfg.baseUrl === "string" && cfg.baseUrl.trim() !== "" ? normalizeUrl(cfg.baseUrl.trim()) : undefined;
  const sessionUrl = typeof cfg.sessionUrl === "string" && cfg.sessionUrl.trim() !== "" ? normalizeUrl(cfg.sessionUrl.trim()) : undefined;
  const username = typeof cfg.username === "string" && cfg.username.trim() !== "" ? cfg.username.trim() : undefined;
  const password = typeof cfg.password === "string" ? cfg.password : undefined;
  const accessToken = typeof cfg.accessToken === "string" && cfg.accessToken.trim() !== "" ? cfg.accessToken.trim() : undefined;

  if (!baseUrl && !sessionUrl) {
    throw new Error("stalwart-jmap: configure baseUrl or sessionUrl");
  }
  if (!accessToken && (!username || typeof password !== "string")) {
    throw new Error("stalwart-jmap: configure accessToken or username/password");
  }

  return {
    baseUrl,
    sessionUrl,
    username,
    password,
    accessToken,
    accountId: typeof cfg.accountId === "string" && cfg.accountId.trim() !== "" ? cfg.accountId.trim() : undefined,
    identityId: typeof cfg.identityId === "string" && cfg.identityId.trim() !== "" ? cfg.identityId.trim() : undefined,
    timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : 30000,
  };
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : formatJson(value),
      },
    ],
    details: value,
  };
}

function capabilityForMethod(methodName: string): JmapCapabilityKey[] {
  const [namespace] = methodName.split("/");
  switch (namespace) {
    case "Mailbox":
    case "Email":
    case "Thread":
    case "SearchSnippet":
    case "VacationResponse":
      return ["mail"];
    case "EmailSubmission":
    case "Identity":
      return ["submission", "mail"];
    case "Calendar":
    case "CalendarEvent":
    case "ParticipantIdentity":
      return ["calendars"];
    case "AddressBook":
    case "ContactCard":
    case "ContactGroup":
      return ["contacts"];
    default:
      return [];
  }
}

function parseScheduleId(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function scheduleIdsMatch(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const leftUrl = parseScheduleId(left);
  const rightUrl = parseScheduleId(right);
  if (!leftUrl || !rightUrl) {
    return false;
  }

  return (
    leftUrl.protocol.toLowerCase() === rightUrl.protocol.toLowerCase() &&
    leftUrl.hostname.toLowerCase() === rightUrl.hostname.toLowerCase() &&
    leftUrl.port === rightUrl.port &&
    leftUrl.username === rightUrl.username &&
    leftUrl.password === rightUrl.password &&
    leftUrl.pathname === rightUrl.pathname &&
    leftUrl.search === rightUrl.search &&
    leftUrl.hash === rightUrl.hash
  );
}

function encodePatchPathSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function pickDefaultWritableContainer(items: NamedContainer[], writeKey: keyof Rights): NamedContainer | undefined {
  const writableDefaults = items.filter((item) => item.id && item.isDefault && item.myRights?.[writeKey] === true);
  if (writableDefaults[0]) {
    return writableDefaults[0];
  }

  const anyDefault = items.find((item) => item.id && item.isDefault);
  if (anyDefault && anyDefault.myRights?.[writeKey] !== false) {
    return anyDefault;
  }

  return items.find((item) => item.id && item.myRights?.[writeKey] !== false);
}

export function deriveUsingFromMethodCalls(methodCalls: unknown[]): string[] {
  const using = new Set<string>([JMAP_CAPABILITIES.core]);

  for (const call of methodCalls) {
    if (!Array.isArray(call) || typeof call[0] !== "string") {
      continue;
    }
    for (const capability of capabilityForMethod(call[0])) {
      using.add(JMAP_CAPABILITIES[capability]);
    }
  }

  return [...using];
}

function resolvePrimaryAccountId(session: JmapSession, capability: JmapCapabilityKey): string | undefined {
  const primaryAccounts = session.primaryAccounts ?? {};
  const candidates: string[] = [];

  switch (capability) {
    case "mail":
      candidates.push(JMAP_CAPABILITIES.mail, JMAP_CAPABILITIES.core);
      break;
    case "submission":
      candidates.push(JMAP_CAPABILITIES.submission, JMAP_CAPABILITIES.mail, JMAP_CAPABILITIES.core);
      break;
    case "calendars":
      candidates.push(JMAP_CAPABILITIES.calendars, JMAP_CAPABILITIES.core);
      break;
    case "contacts":
      candidates.push(JMAP_CAPABILITIES.contacts, JMAP_CAPABILITIES.core);
      break;
    case "core":
      candidates.push(JMAP_CAPABILITIES.core);
      break;
  }

  for (const candidate of candidates) {
    const accountId = primaryAccounts[candidate];
    if (accountId) {
      return accountId;
    }
  }

  return undefined;
}

export function buildMailSendMethodCalls(params: {
  accountId: string;
  identityId: string;
  mailboxId: string;
  mail: MailSendParams;
}): JmapMethodCall[] {
  const createEmailId = "email-1";

  return [
    [
      "Email/set",
      {
        accountId: params.accountId,
        create: {
          [createEmailId]: {
            mailboxIds: {
              [params.mailboxId]: true,
            },
            from: params.mail.from ? [params.mail.from] : undefined,
            to: params.mail.to,
            cc: params.mail.cc,
            bcc: params.mail.bcc,
            replyTo: params.mail.replyTo,
            subject: params.mail.subject,
            keywords: params.mail.keywords,
            bodyValues: {
              body1: {
                value: params.mail.text,
              },
            },
            textBody: [
              {
                partId: "body1",
                type: "text/plain",
              },
            ],
          },
        },
      },
      "mail-set-1",
    ],
    [
      "EmailSubmission/set",
      {
        accountId: params.accountId,
        create: {
          submission1: {
            emailId: `#${createEmailId}`,
            identityId: params.identityId,
          },
        },
      },
      "mail-submit-1",
    ],
  ];
}

export function applyDefaultContainerIds<T extends Record<string, unknown>>(
  create: Record<string, T> | undefined,
  containerKey: "addressBookIds" | "calendarIds",
  containerId: string,
): Record<string, T> | undefined {
  if (!create) {
    return undefined;
  }

  const injected = Object.fromEntries(
    Object.entries(create).map(([creationId, value]) => {
      if (value[containerKey] !== undefined) {
        return [creationId, value];
      }

      return [
        creationId,
        {
          ...value,
          [containerKey]: {
            [containerId]: true,
          },
        },
      ];
    }),
  ) as Record<string, T>;

  return injected;
}

export function buildCalendarEventRsvpPatch(params: {
  participantId: string;
  participationStatus: "accepted" | "tentative" | "declined" | "needs-action";
  participationComment?: string | null;
  expectReply?: boolean;
}): Record<string, unknown> {
  const encodedParticipantId = encodePatchPathSegment(params.participantId);
  const patch: Record<string, unknown> = {
    [`participants/${encodedParticipantId}/participationStatus`]: params.participationStatus,
  };

  if (params.participationComment !== undefined) {
    patch[`participants/${encodedParticipantId}/participationComment`] = params.participationComment;
  }
  if (params.expectReply !== undefined) {
    patch[`participants/${encodedParticipantId}/expectReply`] = params.expectReply;
  }

  return patch;
}

export class StalwartJmapClient {
  private readonly cfg: PluginConfig;
  private sessionCache?: JmapSession;

  constructor(cfg: PluginConfig) {
    this.cfg = cfg;
  }

  private authHeaders(): Record<string, string> {
    if (this.cfg.accessToken) {
      return { Authorization: `Bearer ${this.cfg.accessToken}` };
    }

    const raw = `${this.cfg.username ?? ""}:${this.cfg.password ?? ""}`;
    return { Authorization: `Basic ${Buffer.from(raw, "utf8").toString("base64")}` };
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...this.authHeaders(),
          ...(init?.headers ?? {}),
        },
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${bodyText}`);
      }
      if (!bodyText) {
        return {};
      }

      try {
        return JSON.parse(bodyText);
      } catch (error) {
        throw new Error(`Invalid JSON response from ${url}: ${String(error)}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async session(force = false): Promise<JmapSession> {
    if (this.sessionCache && !force) {
      return this.sessionCache;
    }

    const attempts: string[] = [];
    for (const candidate of resolveSessionDiscoveryUrls(this.cfg)) {
      try {
        const session = (await this.fetchJson(candidate)) as JmapSession;
        if (session.apiUrl) {
          this.sessionCache = session;
          return session;
        }

        attempts.push(`${candidate} -> missing apiUrl`);
      } catch (error) {
        attempts.push(`${candidate} -> ${String(error)}`);
      }
    }

    throw new Error(`stalwart-jmap: JMAP session discovery failed:\n${attempts.join("\n")}`);
  }

  async accountIdFor(capability: JmapCapabilityKey): Promise<string> {
    if (this.cfg.accountId) {
      return this.cfg.accountId;
    }

    const session = await this.session();
    const accountId = resolvePrimaryAccountId(session, capability);
    if (!accountId) {
      throw new Error(`stalwart-jmap: could not resolve primary JMAP accountId for ${capability}`);
    }

    return accountId;
  }

  async call(methodCalls: unknown[], using?: string[]): Promise<JmapResponse> {
    const session = await this.session();
    const payload = {
      using: using ?? deriveUsingFromMethodCalls(methodCalls),
      methodCalls,
    };

    return (await this.fetchJson(session.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })) as JmapResponse;
  }

  async resolveIdentityId(accountId?: string): Promise<string> {
    if (this.cfg.identityId) {
      return this.cfg.identityId;
    }

    const resolvedAccountId = accountId ?? (await this.accountIdFor("mail"));
    const res = await this.call([
      ["Identity/get", { accountId: resolvedAccountId, ids: null }, "identity-get-1"],
    ]);
    const first = (res.methodResponses?.[0] as [string, { list?: Array<{ id?: string }> }, string] | undefined)?.[1]?.list?.[0];

    if (!first?.id) {
      throw new Error("stalwart-jmap: no sending identity available; set identityId in plugin config");
    }

    return first.id;
  }

  async resolveMailboxIdByRole(role: string, accountId?: string): Promise<string> {
    const resolvedAccountId = accountId ?? (await this.accountIdFor("mail"));
    const res = await this.call([
      [
        "Mailbox/get",
        { accountId: resolvedAccountId, ids: null, properties: ["id", "name", "role"] },
        "mailbox-get-1",
      ],
    ]);
    const mailboxes =
      (res.methodResponses?.[0] as [string, { list?: Array<{ id?: string; role?: string }> }, string] | undefined)?.[1]?.list ?? [];
    const mailbox = mailboxes.find((item) => item.role === role);

    if (!mailbox?.id) {
      throw new Error(`stalwart-jmap: could not resolve mailbox with role ${role}; pass mailboxId explicitly`);
    }

    return mailbox.id;
  }

  async resolveAddressBookId(accountId?: string): Promise<string> {
    const resolvedAccountId = accountId ?? (await this.accountIdFor("contacts"));
    const res = await this.call([
      [
        "AddressBook/get",
        { accountId: resolvedAccountId, ids: null, properties: ["id", "name", "isDefault", "myRights"] },
        "addressbook-get-1",
      ],
    ]);
    const addressBooks =
      (res.methodResponses?.[0] as [string, { list?: NamedContainer[] }, string] | undefined)?.[1]?.list ?? [];
    const addressBook = pickDefaultWritableContainer(addressBooks, "mayWrite");

    if (!addressBook?.id) {
      throw new Error("stalwart-jmap: could not resolve a writable address book; pass addressBookId explicitly");
    }

    return addressBook.id;
  }

  async resolveCalendarId(accountId?: string): Promise<string> {
    const resolvedAccountId = accountId ?? (await this.accountIdFor("calendars"));
    const res = await this.call([
      [
        "Calendar/get",
        { accountId: resolvedAccountId, ids: null, properties: ["id", "name", "isDefault", "myRights"] },
        "calendar-get-1",
      ],
    ]);
    const calendars =
      (res.methodResponses?.[0] as [string, { list?: NamedContainer[] }, string] | undefined)?.[1]?.list ?? [];
    const calendar = pickDefaultWritableContainer(calendars, "mayWriteAll") ?? pickDefaultWritableContainer(calendars, "mayWriteOwn");

    if (!calendar?.id) {
      throw new Error("stalwart-jmap: could not resolve a writable calendar; pass calendarId explicitly");
    }

    return calendar.id;
  }

  async resolveParticipantIdentity(accountId?: string): Promise<ParticipantIdentity> {
    const resolvedAccountId = accountId ?? (await this.accountIdFor("calendars"));
    const res = await this.call([
      [
        "ParticipantIdentity/get",
        { accountId: resolvedAccountId, ids: null, properties: ["id", "name", "scheduleId", "sendTo", "isDefault"] },
        "participant-identity-get-1",
      ],
    ]);
    const identities =
      (res.methodResponses?.[0] as [string, { list?: ParticipantIdentity[] }, string] | undefined)?.[1]?.list ?? [];
    const identity = identities.find((item) => item.id && item.isDefault) ?? identities.find((item) => item.id);

    if (!identity?.id || !identity.scheduleId) {
      throw new Error("stalwart-jmap: no participant identity available; resolve one explicitly first");
    }

    return identity;
  }

  async resolveEventParticipantId(params: {
    accountId?: string;
    eventId: string;
    participantId?: string;
  }): Promise<string> {
    if (params.participantId) {
      return params.participantId;
    }

    const resolvedAccountId = params.accountId ?? (await this.accountIdFor("calendars"));
    const [eventRes, identity] = await Promise.all([
      this.call([
        [
          "CalendarEvent/get",
          { accountId: resolvedAccountId, ids: [params.eventId], properties: ["id", "participants"] },
          "calendar-event-get-1",
        ],
      ]),
      this.resolveParticipantIdentity(resolvedAccountId),
    ]);

    const event = (eventRes.methodResponses?.[0] as [string, { list?: Array<{ participants?: Record<string, { scheduleId?: string }> }> }, string] | undefined)?.[1]
      ?.list?.[0];
    const participants = event?.participants ?? {};
    const identityScheduleId = identity.scheduleId as string;

    const match = Object.entries(participants).find(([, participant]) => {
      return typeof participant.scheduleId === "string" && scheduleIdsMatch(participant.scheduleId, identityScheduleId);
    });

    if (!match?.[0]) {
      throw new Error(
        "stalwart-jmap: could not match the current account to an event participant; pass participantId explicitly or inspect ParticipantIdentity/get",
      );
    }

    return match[0];
  }
}

const accountIdField = Type.Optional(Type.String({ description: "Optional JMAP account id override for this call." }));
const propertiesField = Type.Optional(Type.Array(Type.String(), { description: "Optional property whitelist." }));
const filterField = Type.Optional(Type.Any({ description: "JMAP filter object passed through as-is." }));
const sortField = Type.Optional(Type.Array(Type.Any(), { description: "JMAP sort array passed through as-is." }));
const idsField = Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Optional object ids. Omit to fetch all." }));
const mutableRecordField = Type.Optional(Type.Record(Type.String(), Type.Any()));
const addressField = Type.Object({
  email: Type.String(),
  name: Type.Optional(Type.String()),
});

export default definePluginEntry({
  id: "stalwart-jmap",
  name: "Stalwart JMAP",
  description: "Typed Stalwart JMAP tools for mail, calendar, and contacts, plus a raw JMAP request escape hatch.",
  register(api) {
    const cfg = ensureConfig(api.pluginConfig);
    const client = new StalwartJmapClient(cfg);

    api.registerTool({
      name: "stalwart_jmap_session",
      label: "Stalwart JMAP Session",
      description: "Fetch the JMAP session object from Stalwart. Use this first for diagnostics and capability discovery.",
      parameters: Type.Object({
        refresh: Type.Optional(Type.Boolean({ default: false })),
      }),
      async execute(_id, params) {
        return textResult(await client.session(Boolean(params.refresh)));
      },
    });

    api.registerTool({
      name: "stalwart_mailbox_get",
      label: "Stalwart Mailbox Get",
      description: "Fetch mailboxes via JMAP Mailbox/get so the agent can resolve inbox, sent, archive, and custom mailbox ids.",
      parameters: Type.Object({
        accountId: accountIdField,
        ids: idsField,
        properties: propertiesField,
      }),
      async execute(_id, params) {
        const accountId = params.accountId ?? (await client.accountIdFor("mail"));
        const res = await client.call([
          ["Mailbox/get", { accountId, ids: params.ids ?? null, properties: params.properties }, "mailbox-get-1"],
        ]);
        return textResult(res);
      },
    });

    api.registerTool({
      name: "stalwart_addressbook_get",
      label: "Stalwart AddressBook Get",
      description: "Fetch address books via JMAP AddressBook/get so the agent can resolve writable contact stores before creating or moving contacts.",
      parameters: Type.Object({
        accountId: accountIdField,
        ids: idsField,
        properties: propertiesField,
      }),
      async execute(_id, params) {
        const accountId = params.accountId ?? (await client.accountIdFor("contacts"));
        const res = await client.call([
          ["AddressBook/get", { accountId, ids: params.ids ?? null, properties: params.properties }, "addressbook-get-1"],
        ]);
        return textResult(res);
      },
    });

    api.registerTool({
      name: "stalwart_identity_get",
      label: "Stalwart Identity Get",
      description: "Fetch sending identities via JMAP Identity/get. Use this before sending if the correct From identity is unclear.",
      parameters: Type.Object({
        accountId: accountIdField,
        ids: idsField,
      }),
      async execute(_id, params) {
        const accountId = params.accountId ?? (await client.accountIdFor("mail"));
        const res = await client.call([
          ["Identity/get", { accountId, ids: params.ids ?? null }, "identity-get-1"],
        ]);
        return textResult(res);
      },
    });

    api.registerTool(
      {
        name: "stalwart_jmap_request",
        label: "Stalwart Raw JMAP Request",
        description: "Low-level JMAP escape hatch. Sends raw methodCalls to Stalwart and returns raw methodResponses. Provide using explicitly for non-core capabilities not inferred by the plugin.",
        parameters: Type.Object({
          methodCalls: Type.Array(Type.Any(), { minItems: 1, description: "Raw JMAP methodCalls array." }),
          using: Type.Optional(Type.Array(Type.String(), { description: "Optional JMAP capability URNs." })),
        }),
        async execute(_id, params) {
          return textResult(await client.call(params.methodCalls, params.using));
        },
      },
      { optional: true },
    );

    api.registerTool({
      name: "stalwart_participant_identity_get",
      label: "Stalwart Participant Identity Get",
      description: "Fetch participant identities via JMAP ParticipantIdentity/get. Use this before creating scheduled events or if RSVP identity matching is unclear.",
      parameters: Type.Object({
        accountId: accountIdField,
        ids: idsField,
        properties: propertiesField,
      }),
      async execute(_id, params) {
        const accountId = params.accountId ?? (await client.accountIdFor("calendars"));
        const res = await client.call([
          [
            "ParticipantIdentity/get",
            { accountId, ids: params.ids ?? null, properties: params.properties },
            "participant-identity-get-1",
          ],
        ]);
        return textResult(res);
      },
    });

    api.registerTool({
      name: "stalwart_mail_query",
      label: "Stalwart Mail Query",
      description: "Query email ids using JMAP Email/query.",
      parameters: Type.Object({
        accountId: accountIdField,
        filter: filterField,
        sort: sortField,
        position: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 25 })),
        calculateTotal: Type.Optional(Type.Boolean({ default: true })),
      }),
      async execute(_id, params) {
        const accountId = params.accountId ?? (await client.accountIdFor("mail"));
        const res = await client.call([
          [
            "Email/query",
            {
              accountId,
              filter: params.filter,
              sort: params.sort,
              position: params.position ?? 0,
              limit: params.limit ?? 25,
              calculateTotal: params.calculateTotal ?? true,
            },
            "mail-query-1",
          ],
        ]);
        return textResult(res);
      },
    });

    api.registerTool({
      name: "stalwart_mail_get",
      label: "Stalwart Mail Get",
      description: "Fetch email objects using JMAP Email/get.",
      parameters: Type.Object({
        accountId: accountIdField,
        ids: Type.Array(Type.String(), { minItems: 1, description: "Email ids to fetch." }),
        properties: propertiesField,
        bodyProperties: Type.Optional(Type.Array(Type.String(), { description: "Optional bodyProperties for bodyValues/body parts." })),
        fetchTextBodyValues: Type.Optional(Type.Boolean({ default: true })),
        fetchHTMLBodyValues: Type.Optional(Type.Boolean({ default: false })),
        fetchAllBodyValues: Type.Optional(Type.Boolean({ default: false })),
      }),
      async execute(_id, params) {
        const accountId = params.accountId ?? (await client.accountIdFor("mail"));
        const res = await client.call([
          [
            "Email/get",
            {
              accountId,
              ids: params.ids,
              properties: params.properties,
              bodyProperties: params.bodyProperties,
              fetchTextBodyValues: params.fetchTextBodyValues ?? true,
              fetchHTMLBodyValues: params.fetchHTMLBodyValues ?? false,
              fetchAllBodyValues: params.fetchAllBodyValues ?? false,
            },
            "mail-get-1",
          ],
        ]);
        return textResult(res);
      },
    });

    api.registerTool(
      {
        name: "stalwart_mail_send",
        label: "Stalwart Mail Send",
        description: "Send a plain-text email using Email/set plus EmailSubmission/set. If mailboxId is omitted, the plugin uses the Sent mailbox role.",
        parameters: Type.Object({
          accountId: accountIdField,
          identityId: Type.Optional(Type.String({ description: "Optional JMAP identity id override." })),
          mailboxId: Type.Optional(Type.String({ description: "Optional mailbox id to store the created message in. Defaults to the Sent mailbox role." })),
          from: Type.Optional(addressField),
          to: Type.Array(addressField, { minItems: 1 }),
          cc: Type.Optional(Type.Array(addressField)),
          bcc: Type.Optional(Type.Array(addressField)),
          replyTo: Type.Optional(Type.Array(addressField)),
          subject: Type.String(),
          text: Type.String({ description: "Plain-text body." }),
          keywords: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
        }),
        async execute(_id, params) {
          const accountId = params.accountId ?? (await client.accountIdFor("mail"));
          const identityId = params.identityId ?? (await client.resolveIdentityId(accountId));
          const mailboxId = params.mailboxId ?? (await client.resolveMailboxIdByRole("sent", accountId));
          const res = await client.call(
            buildMailSendMethodCalls({
              accountId,
              identityId,
              mailboxId,
              mail: params,
            }),
          );
          return textResult(res);
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "stalwart_mail_update",
        label: "Stalwart Mail Update",
        description: "Update email properties via JMAP Email/set. Use this for mailbox moves, keyword changes, or flags.",
        parameters: Type.Object({
          accountId: accountIdField,
          update: Type.Record(Type.String(), Type.Any(), {
            description: "Map of emailId -> patch object, for example {\"msg-id\": {\"mailboxIds/<mailboxId>\": true}}",
          }),
          destroy: Type.Optional(Type.Array(Type.String())),
        }),
        async execute(_id, params) {
          const accountId = params.accountId ?? (await client.accountIdFor("mail"));
          const res = await client.call([
            [
              "Email/set",
              {
                accountId,
                update: params.update,
                destroy: params.destroy,
              },
              "mail-update-1",
            ],
          ]);
          return textResult(res);
        },
      },
      { optional: true },
    );

    api.registerTool({
      name: "stalwart_calendar_get",
      label: "Stalwart Calendar Get",
      description: "Fetch calendars via JMAP Calendar/get so the agent can resolve calendar ids before reading or updating events.",
      parameters: Type.Object({
        accountId: accountIdField,
        ids: idsField,
        properties: propertiesField,
      }),
      async execute(_id, params) {
        const accountId = params.accountId ?? (await client.accountIdFor("calendars"));
        const res = await client.call([
          ["Calendar/get", { accountId, ids: params.ids ?? null, properties: params.properties }, "calendar-get-1"],
        ]);
        return textResult(res);
      },
    });

    api.registerTool({
      name: "stalwart_calendar_event_query",
      label: "Stalwart Calendar Event Query",
      description: "Query calendar event ids using JMAP CalendarEvent/query. The filter object is passed through as-is.",
      parameters: Type.Object({
        accountId: accountIdField,
        filter: filterField,
        sort: sortField,
        position: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 25 })),
        calculateTotal: Type.Optional(Type.Boolean({ default: true })),
      }),
      async execute(_id, params) {
        const accountId = params.accountId ?? (await client.accountIdFor("calendars"));
        const res = await client.call([
          [
            "CalendarEvent/query",
            {
              accountId,
              filter: params.filter,
              sort: params.sort,
              position: params.position ?? 0,
              limit: params.limit ?? 25,
              calculateTotal: params.calculateTotal ?? true,
            },
            "calendar-event-query-1",
          ],
        ]);
        return textResult(res);
      },
    });

    api.registerTool({
      name: "stalwart_calendar_event_get",
      label: "Stalwart Calendar Event Get",
      description: "Fetch calendar events via JMAP CalendarEvent/get.",
      parameters: Type.Object({
        accountId: accountIdField,
        ids: Type.Array(Type.String(), { minItems: 1 }),
        properties: propertiesField,
      }),
      async execute(_id, params) {
        const accountId = params.accountId ?? (await client.accountIdFor("calendars"));
        const res = await client.call([
          ["CalendarEvent/get", { accountId, ids: params.ids, properties: params.properties }, "calendar-event-get-1"],
        ]);
        return textResult(res);
      },
    });

    api.registerTool(
      {
        name: "stalwart_calendar_event_set",
        label: "Stalwart Calendar Event Set",
        description: "Create, update, or destroy calendar events via JMAP CalendarEvent/set.",
        parameters: Type.Object({
          accountId: accountIdField,
          calendarId: Type.Optional(Type.String({ description: "Default calendar id applied to created events that omit calendarIds." })),
          create: mutableRecordField,
          update: mutableRecordField,
          destroy: Type.Optional(Type.Array(Type.String())),
          sendSchedulingMessages: Type.Optional(
            Type.Boolean({ default: false, description: "If true, JMAP scheduling messages are sent for event creates or updates." }),
          ),
        }),
        async execute(_id, params) {
          const accountId = params.accountId ?? (await client.accountIdFor("calendars"));
          const calendarId = params.create ? params.calendarId ?? (await client.resolveCalendarId(accountId)) : undefined;
          const res = await client.call([
            [
              "CalendarEvent/set",
              {
                accountId,
                create: calendarId ? applyDefaultContainerIds(params.create, "calendarIds", calendarId) : params.create,
                update: params.update,
                destroy: params.destroy,
                sendSchedulingMessages: params.sendSchedulingMessages ?? false,
              },
              "calendar-event-set-1",
            ],
          ]);
          return textResult(res);
        },
      },
      { optional: true },
    );

    api.registerTool({
      name: "stalwart_contact_query",
      label: "Stalwart Contact Query",
      description: "Query contact ids using JMAP ContactCard/query. The filter object is passed through as-is.",
      parameters: Type.Object({
        accountId: accountIdField,
        filter: filterField,
        sort: sortField,
        position: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 25 })),
        calculateTotal: Type.Optional(Type.Boolean({ default: true })),
      }),
      async execute(_id, params) {
        const accountId = params.accountId ?? (await client.accountIdFor("contacts"));
        const res = await client.call([
          [
            "ContactCard/query",
            {
              accountId,
              filter: params.filter,
              sort: params.sort,
              position: params.position ?? 0,
              limit: params.limit ?? 25,
              calculateTotal: params.calculateTotal ?? true,
            },
            "contact-query-1",
          ],
        ]);
        return textResult(res);
      },
    });

    api.registerTool({
      name: "stalwart_contact_get",
      label: "Stalwart Contact Get",
      description: "Fetch contact cards via JMAP ContactCard/get.",
      parameters: Type.Object({
        accountId: accountIdField,
        ids: Type.Array(Type.String(), { minItems: 1 }),
        properties: propertiesField,
      }),
      async execute(_id, params) {
        const accountId = params.accountId ?? (await client.accountIdFor("contacts"));
        const res = await client.call([
          ["ContactCard/get", { accountId, ids: params.ids, properties: params.properties }, "contact-get-1"],
        ]);
        return textResult(res);
      },
    });

    api.registerTool(
      {
        name: "stalwart_contact_set",
        label: "Stalwart Contact Set",
        description: "Create, update, or destroy contacts via JMAP ContactCard/set. If a created card omits addressBookIds, the plugin applies a writable default address book.",
        parameters: Type.Object({
          accountId: accountIdField,
          addressBookId: Type.Optional(Type.String({ description: "Default address book id applied to created contacts that omit addressBookIds." })),
          create: mutableRecordField,
          update: mutableRecordField,
          destroy: Type.Optional(Type.Array(Type.String())),
        }),
        async execute(_id, params) {
          const accountId = params.accountId ?? (await client.accountIdFor("contacts"));
          const addressBookId = params.create ? params.addressBookId ?? (await client.resolveAddressBookId(accountId)) : undefined;
          const res = await client.call([
            [
              "ContactCard/set",
              {
                accountId,
                create: addressBookId ? applyDefaultContainerIds(params.create, "addressBookIds", addressBookId) : params.create,
                update: params.update,
                destroy: params.destroy,
              },
              "contact-set-1",
            ],
          ]);
          return textResult(res);
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "stalwart_calendar_event_rsvp",
        label: "Stalwart Calendar Event RSVP",
        description: "Accept, tentatively accept, decline, or reset your RSVP for a calendar event. The plugin matches your default participant identity unless participantId is provided.",
        parameters: Type.Object({
          accountId: accountIdField,
          eventId: Type.String({ description: "CalendarEvent id to update. A synthetic instance id is allowed for single-occurrence RSVPs." }),
          participantId: Type.Optional(Type.String({ description: "Optional participant key override inside the event participants object." })),
          participationStatus: Type.Union([
            Type.Literal("accepted"),
            Type.Literal("tentative"),
            Type.Literal("declined"),
            Type.Literal("needs-action"),
          ]),
          participationComment: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          expectReply: Type.Optional(Type.Boolean()),
          sendSchedulingMessages: Type.Optional(
            Type.Boolean({ default: true, description: "If true, Stalwart sends scheduling replies or updates to the organizer." }),
          ),
        }),
        async execute(_id, params) {
          const accountId = params.accountId ?? (await client.accountIdFor("calendars"));
          const participantId = await client.resolveEventParticipantId({
            accountId,
            eventId: params.eventId,
            participantId: params.participantId,
          });
          const res = await client.call([
            [
              "CalendarEvent/set",
              {
                accountId,
                update: {
                  [params.eventId]: buildCalendarEventRsvpPatch({
                    participantId,
                    participationStatus: params.participationStatus,
                    participationComment: params.participationComment,
                    expectReply: params.expectReply,
                  }),
                },
                sendSchedulingMessages: params.sendSchedulingMessages ?? true,
              },
              "calendar-event-rsvp-1",
            ],
          ]);
          return textResult(res);
        },
      },
      { optional: true },
    );

    api.logger.info("stalwart-jmap: registered tools");
  },
});
