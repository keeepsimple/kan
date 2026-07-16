import { beforeEach, describe, expect, it, vi } from "vitest";

import * as cardRepo from "@kan/db/repository/card.repo";
import * as discordRepo from "@kan/db/repository/discord.repo";
import * as discordClient from "@kan/discord";

import {
  assertListAllowsCardCreation,
  htmlToDiscordMarkdown,
  notifyCardCreated,
  notifyCardMoved,
  notifyCardUpdated,
  parseRoleIds,
} from "./discord";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@kan/discord", () => ({
  createThread: vi.fn(),
  postMessage: vi.fn(),
  editMessage: vi.fn(),
  buildRoleMentions: (ids: string[]) => ids.map((id) => `<@&${id}>`).join(" "),
}));

vi.mock("@kan/db/repository/discord.repo", () => ({
  getByWorkspaceId: vi.fn(),
  setCardDiscordThreadId: vi.fn(),
  setCardDiscordMessageId: vi.fn(),
  getBoardDiscordChannelId: vi.fn(),
}));

vi.mock("@kan/db/repository/card.repo", () => ({
  getDiscordContextByPublicId: vi.fn(),
}));

vi.mock("@kan/logger", () => ({
  createLogger: vi.fn(() => mockLogger),
}));

const mockDb = {} as Parameters<typeof notifyCardCreated>[0];

const mockCreateThread = discordClient.createThread as ReturnType<typeof vi.fn>;
const mockPostMessage = discordClient.postMessage as ReturnType<typeof vi.fn>;
const mockGetByWorkspaceId = discordRepo.getByWorkspaceId as ReturnType<
  typeof vi.fn
>;
const mockSetThreadId = discordRepo.setCardDiscordThreadId as ReturnType<
  typeof vi.fn
>;
const mockGetBoardChannel = discordRepo.getBoardDiscordChannelId as ReturnType<
  typeof vi.fn
>;
const mockSetMessageId = discordRepo.setCardDiscordMessageId as ReturnType<
  typeof vi.fn
>;
const mockEditMessage = discordClient.editMessage as ReturnType<typeof vi.fn>;
const mockGetDiscordContext =
  cardRepo.getDiscordContextByPublicId as ReturnType<typeof vi.fn>;

const connection = { id: 1, workspaceId: 7, guildId: "g1" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_BASE_URL = "https://kan.test";
});

describe("htmlToDiscordMarkdown", () => {
  it("mirrors headings, paragraphs, lists, and inline styles", () => {
    const html =
      "<h1>Hello my friend</h1><p>Lorem ipsum <strong>dolor</strong> sit <em>amet</em>.</p><ul><li><p>Nam aliquet odio elit</p></li><li><p>Morbi rutrum eu sem ut</p></li></ul>";
    expect(htmlToDiscordMarkdown(html)).toBe(
      [
        "**Hello my friend**",
        "Lorem ipsum **dolor** sit *amet*.",
        "",
        "• Nam aliquet odio elit",
        "",
        "• Morbi rutrum eu sem ut",
      ].join("\n"),
    );
  });
});

describe("parseRoleIds", () => {
  it("parses a JSON string array", () => {
    expect(parseRoleIds('["1","2"]')).toEqual(["1", "2"]);
  });

  it("returns [] for null, invalid JSON, and non-arrays", () => {
    expect(parseRoleIds(null)).toEqual([]);
    expect(parseRoleIds("not json")).toEqual([]);
    expect(parseRoleIds('{"a":1}')).toEqual([]);
  });
});

describe("assertListAllowsCardCreation", () => {
  it("throws BAD_REQUEST for notify lists", () => {
    expect(() =>
      assertListAllowsCardCreation({ discordBehaviour: "notify" }),
    ).toThrowError(/notify/i);
  });

  it("passes for create_thread and unconfigured lists", () => {
    expect(() =>
      assertListAllowsCardCreation({ discordBehaviour: "create_thread" }),
    ).not.toThrow();
    expect(() =>
      assertListAllowsCardCreation({ discordBehaviour: null }),
    ).not.toThrow();
  });
});

describe("notifyCardCreated", () => {
  const args = {
    cardId: 5,
    cardTitle: "Fix login",
    boardName: "Sprint 1",
    workspaceId: 7,
    discordChannelId: "chan1",
    discordBehaviour: "create_thread",
    discordRoleIds: '["r1"]',
  };

  it("creates a thread, saves the thread id, and posts the first message with role mentions", async () => {
    mockGetByWorkspaceId.mockResolvedValue(connection);
    mockCreateThread.mockResolvedValue({
      success: true,
      data: { id: "t9", name: "Fix login" },
    });
    mockPostMessage.mockResolvedValue({ success: true, data: { id: "m1" } });

    await notifyCardCreated(mockDb, args);

    expect(mockCreateThread).toHaveBeenCalledWith(
      "chan1",
      "Fix login - 📋 Sprint 1",
    );
    expect(mockSetThreadId).toHaveBeenCalledWith(mockDb, 5, "t9");
    expect(mockPostMessage).toHaveBeenCalledWith(
      "t9",
      "<@&r1>",
      ["r1"],
      [{ title: "📌 Fix login" }],
    );
    expect(mockSetMessageId).toHaveBeenCalledWith(mockDb, 5, "m1");
  });

  it("includes description, list, labels, members, due date, and checklists in an embed", async () => {
    mockGetByWorkspaceId.mockResolvedValue(connection);
    mockCreateThread.mockResolvedValue({
      success: true,
      data: { id: "t9", name: "Fix login" },
    });
    mockPostMessage.mockResolvedValue({ success: true, data: { id: "m1" } });

    const due = new Date("2026-07-17T02:00:00Z");
    await notifyCardCreated(mockDb, {
      ...args,
      cardPublicId: "cardpub00001",
      description: "<p>Hello <strong>world</strong></p>",
      listName: "Task",
      labelNames: ["Urgent"],
      labelColour: "#dc2626",
      memberNames: ["An Nguyen"],
      dueDate: due,
      checklists: [{ name: "Todo", items: ["Step 1", "Step 2"] }],
      createdBy: "An",
    });

    expect(mockPostMessage).toHaveBeenCalledWith(
      "t9",
      "<@&r1>",
      ["r1"],
      [
        {
          color: 0xdc2626,
          title: "📌 Fix login",
          url: "https://kan.test/cards/cardpub00001",
          description: "Hello **world**",
          fields: [
            { name: "✨ Created by", value: "**An**", inline: true },
            { name: "📂 List", value: "Task", inline: true },
            { name: "🏷️ Labels", value: "Urgent", inline: true },
            {
              name: "⏰ Due",
              value: `<t:${Math.floor(due.getTime() / 1000)}:f>`,
              inline: true,
            },
            { name: "✅ Todo", value: "• Step 1\n• Step 2" },
            { name: "👥 Members", value: "An Nguyen" },
          ],
        },
      ],
    );
  });

  it("does nothing when the list is not a create_thread list", async () => {
    await notifyCardCreated(mockDb, { ...args, discordBehaviour: null });
    expect(mockGetByWorkspaceId).not.toHaveBeenCalled();
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it("does nothing when the board has no channel", async () => {
    await notifyCardCreated(mockDb, { ...args, discordChannelId: null });
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it("does nothing when the workspace is not connected", async () => {
    mockGetByWorkspaceId.mockResolvedValue(undefined);
    await notifyCardCreated(mockDb, args);
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it("logs and does not save when thread creation fails", async () => {
    mockGetByWorkspaceId.mockResolvedValue(connection);
    mockCreateThread.mockResolvedValue({ success: false, error: "403" });

    await notifyCardCreated(mockDb, args);

    expect(mockSetThreadId).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

describe("notifyCardUpdated", () => {
  it("re-renders the thread's first embed from current card state", async () => {
    mockGetDiscordContext.mockResolvedValue({
      id: 5,
      title: "Fix login v2",
      description: "<p>Updated</p>",
      dueDate: null,
      discordThreadId: "t9",
      discordMessageId: "m1",
      createdBy: { name: "An" },
      labels: [{ label: { name: "Urgent", colourCode: "#dc2626" } }],
      members: [{ member: { email: "a@b.co", user: { name: "An Nguyen" } } }],
      checklists: [{ name: "Todo", items: [{ title: "Step 1" }] }],
      list: { name: "Task", board: { name: "Sprint 1" } },
    });
    mockEditMessage.mockResolvedValue({ success: true, data: { id: "m1" } });

    await notifyCardUpdated(mockDb, "card00000001");

    expect(mockEditMessage).toHaveBeenCalledWith("t9", "m1", [
      {
        color: 0xdc2626,
        title: "📌 Fix login v2",
        url: "https://kan.test/cards/card00000001",
        description: "Updated",
        fields: [
          { name: "✨ Created by", value: "**An**", inline: true },
          { name: "📂 List", value: "Task", inline: true },
          { name: "🏷️ Labels", value: "Urgent", inline: true },
          { name: "✅ Todo", value: "• Step 1" },
          { name: "👥 Members", value: "An Nguyen" },
        ],
      },
    ]);
  });

  it("does nothing when the card has no thread or message", async () => {
    mockGetDiscordContext.mockResolvedValue({
      discordThreadId: "t9",
      discordMessageId: null,
    });
    await notifyCardUpdated(mockDb, "card00000001");
    expect(mockEditMessage).not.toHaveBeenCalled();
  });
});

describe("notifyCardMoved", () => {
  const args = {
    cardTitle: "Fix login",
    newListName: "Done",
    userName: "An",
    workspaceId: 7,
    newListDiscordBehaviour: "notify",
    cardDiscordThreadId: "t9",
    newListBoardId: 3,
  };

  it("posts the move message into the card's thread", async () => {
    mockGetByWorkspaceId.mockResolvedValue(connection);
    mockPostMessage.mockResolvedValue({ success: true, data: { id: "m1" } });

    await notifyCardMoved(mockDb, args);

    expect(mockPostMessage).toHaveBeenCalledWith(
      "t9",
      "",
      [],
      [
        {
          color: 0xadd8e6,
          title: "📌 Fix login",
          description: "📊 Status: Done\n👤 Moved by: **An**",
        },
      ],
    );
  });

  it("falls back to the board channel when the card has no thread", async () => {
    mockGetByWorkspaceId.mockResolvedValue(connection);
    mockGetBoardChannel.mockResolvedValue("chan1");
    mockPostMessage.mockResolvedValue({ success: true, data: { id: "m1" } });

    await notifyCardMoved(mockDb, { ...args, cardDiscordThreadId: null });

    expect(mockGetBoardChannel).toHaveBeenCalledWith(mockDb, 3);
    expect(mockPostMessage).toHaveBeenCalledWith(
      "chan1",
      "",
      [],
      [
        {
          color: 0xadd8e6,
          title: "📌 Fix login",
          description: "📊 Status: Done\n👤 Moved by: **An**",
        },
      ],
    );
  });

  it("does nothing when the target list is not a notify list", async () => {
    await notifyCardMoved(mockDb, {
      ...args,
      newListDiscordBehaviour: "create_thread",
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("does nothing when no thread and no board channel exist", async () => {
    mockGetByWorkspaceId.mockResolvedValue(connection);
    mockGetBoardChannel.mockResolvedValue(null);

    await notifyCardMoved(mockDb, { ...args, cardDiscordThreadId: null });

    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});
