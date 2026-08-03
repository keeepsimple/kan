import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildRoleMentions,
  buildUserMentions,
  createForumPost,
  createThread,
  editMessage,
  getChannel,
  getPostableChannels,
  getUser,
  postMessage,
  searchGuildMembers,
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
    expect(body.allowed_mentions).toEqual({
      parse: [],
      roles: ["7"],
      users: [],
    });
  });

  it("defaults to no role mentions", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "1", channel_id: "42" }));

    await postMessage("42", "hello");

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as {
      allowed_mentions: unknown;
    };
    expect(body.allowed_mentions).toEqual({ parse: [], roles: [], users: [] });
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

describe("getPostableChannels", () => {
  it("keeps text (0) and forum (15) channels, drops others", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        { id: "1", name: "general", type: 0 },
        { id: "2", name: "voice", type: 2 },
        { id: "3", name: "ideas", type: 15 },
      ]),
    );
    const result = await getPostableChannels("g1");
    expect(result.data).toEqual([
      { id: "1", name: "general", type: 0 },
      { id: "3", name: "ideas", type: 15 },
    ]);
  });
});

describe("getChannel", () => {
  it("maps available_tags and flags for a forum channel", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        id: "3",
        type: 15,
        flags: 16,
        available_tags: [{ id: "t1", name: "Bug" }],
      }),
    );
    const res = await getChannel("3");
    expect(res.data).toEqual({
      id: "3",
      type: 15,
      flags: 16,
      availableTags: [{ id: "t1", name: "Bug" }],
    });
  });
});

describe("createForumPost", () => {
  it("posts a thread with an initial message, tags and allowed_mentions", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "post1", name: "n" }));
    const res = await createForumPost("3", "a".repeat(150), {
      content: "<@&7>",
      embeds: [{ title: "t" }],
      mentionRoleIds: ["7"],
      appliedTagIds: ["t1", "t2", "t3", "t4", "t5", "t6"],
    });
    expect(res.data?.id).toBe("post1");
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("https://discord.com/api/v10/channels/3/threads");
    const body = JSON.parse(call[1].body as string) as {
      name: string;
      applied_tags: string[];
      message: { content: string; allowed_mentions: unknown; embeds: unknown };
    };
    expect(body.name).toHaveLength(100);
    expect(body.applied_tags).toEqual(["t1", "t2", "t3", "t4", "t5"]); // capped at 5
    expect(body.message.content).toBe("<@&7>");
    expect(body.message.allowed_mentions).toEqual({
      parse: [],
      roles: ["7"],
      users: [],
    });
    expect(body.message.embeds).toEqual([{ title: "t" }]);
  });
});

describe("buildUserMentions", () => {
  it("formats user ids as <@id> joined by spaces", () => {
    expect(buildUserMentions(["111", "222"])).toBe("<@111> <@222>");
  });
  it("returns empty string for no ids", () => {
    expect(buildUserMentions([])).toBe("");
  });
});

describe("postMessage user mentions", () => {
  it("adds mentionUserIds to allowed_mentions.users", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "m1" }));
    await postMessage("chan1", "<@111> hi", [], [], ["111"]);
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as {
      allowed_mentions: unknown;
    };
    expect(body.allowed_mentions).toEqual({
      parse: [],
      roles: [],
      users: ["111"],
    });
  });
  it("defaults users to [] when omitted", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "m1" }));
    await postMessage("chan1", "hi");
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as {
      allowed_mentions: unknown;
    };
    expect(body.allowed_mentions).toEqual({ parse: [], roles: [], users: [] });
  });
});

describe("searchGuildMembers", () => {
  it("calls the search endpoint and maps results", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        {
          user: { id: "111", username: "alice", global_name: "Alice A" },
          nick: null,
        },
        {
          user: { id: "222", username: "bob", global_name: null },
          nick: "Bobby",
        },
      ]),
    );
    const res = await searchGuildMembers("guild1", "a");
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("/guilds/guild1/members/search?query=a");
    expect(res.success).toBe(true);
    expect(res.data).toEqual([
      { id: "111", username: "alice", displayName: "Alice A" },
      { id: "222", username: "bob", displayName: "Bobby" },
    ]);
  });
});

describe("getUser", () => {
  it("fetches a user by id and maps the handle", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ id: "111", username: "alice", global_name: "Alice A" }),
    );
    const res = await getUser("111");
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("/users/111");
    expect(res.data).toEqual({
      id: "111",
      username: "alice",
      displayName: "Alice A",
    });
  });
});
