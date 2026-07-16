import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildRoleMentions,
  createThread,
  editMessage,
  getTextChannels,
  postMessage,
} from "./index";

const mockFetch = vi.fn();

beforeEach(() => {
  process.env.DISCORD_BOT_TOKEN = "test-token";
  global.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
});

afterEach(() => {
  delete process.env.DISCORD_BOT_TOKEN;
});

const jsonResponse = (data: unknown) => ({
  ok: true,
  json: () => Promise.resolve(data),
});

describe("buildRoleMentions", () => {
  it("formats role ids as Discord role mentions", () => {
    expect(buildRoleMentions(["1", "2"])).toBe("<@&1> <@&2>");
  });

  it("returns an empty string for no roles", () => {
    expect(buildRoleMentions([])).toBe("");
  });
});

describe("createThread", () => {
  it("creates a public thread with a name truncated to 100 chars", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "42", name: "x" }));

    const result = await createThread("123", "a".repeat(150));

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe("42");
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("https://discord.com/api/v10/channels/123/threads");
    const body = JSON.parse(call[1].body as string) as {
      name: string;
      type: number;
    };
    expect(body.name).toHaveLength(100);
    expect(body.type).toBe(11);
    expect((call[1].headers as Record<string, string>).Authorization).toBe(
      "Bot test-token",
    );
  });

  it("returns an error without calling fetch when the bot token is missing", async () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const result = await createThread("123", "test");

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns an error on a non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve("Missing Permissions"),
    });

    const result = await createThread("123", "test");

    expect(result.success).toBe(false);
    expect(result.error).toContain("403");
  });
});

describe("postMessage", () => {
  it("sends allowed_mentions restricted to the given roles", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "1", channel_id: "42" }));

    await postMessage("42", "hello <@&7>", ["7"]);

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as {
      content: string;
      allowed_mentions: unknown;
    };
    expect(body.content).toBe("hello <@&7>");
    expect(body.allowed_mentions).toEqual({ parse: [], roles: ["7"] });
  });

  it("defaults to no role mentions", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "1", channel_id: "42" }));

    await postMessage("42", "hello");

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as {
      allowed_mentions: unknown;
    };
    expect(body.allowed_mentions).toEqual({ parse: [], roles: [] });
  });
});

describe("editMessage", () => {
  it("PATCHes only the embeds of the message", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "m1", channel_id: "42" }));

    await editMessage("42", "m1", [{ title: "t" }]);

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("/channels/42/messages/m1");
    expect(call[1].method).toBe("PATCH");
    const body = JSON.parse(call[1].body as string) as { embeds: unknown };
    expect(body).toEqual({ embeds: [{ title: "t" }] });
  });
});

describe("getTextChannels", () => {
  it("filters to text channels (type 0) only", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        { id: "1", name: "general", type: 0 },
        { id: "2", name: "voice", type: 2 },
      ]),
    );

    const result = await getTextChannels("g1");

    expect(result.data).toEqual([{ id: "1", name: "general", type: 0 }]);
  });
});
