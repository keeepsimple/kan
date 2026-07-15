import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@kan/discord", () => ({
  createThread: vi.fn(),
  postMessage: vi.fn(),
  buildRoleMentions: (ids: string[]) =>
    ids.map((id) => `<@&${id}>`).join(" "),
}));

vi.mock("@kan/db/repository/discord.repo", () => ({
  getByWorkspaceId: vi.fn(),
  setCardDiscordThreadId: vi.fn(),
  getBoardDiscordChannelId: vi.fn(),
}));

vi.mock("@kan/logger", () => ({
  createLogger: vi.fn(() => mockLogger),
}));

import * as discordClient from "@kan/discord";
import * as discordRepo from "@kan/db/repository/discord.repo";

import {
  assertListAllowsCardCreation,
  notifyCardCreated,
  notifyCardMoved,
  parseRoleIds,
} from "./discord";

const mockDb = {} as Parameters<typeof notifyCardCreated>[0];

const mockCreateThread = discordClient.createThread as ReturnType<
  typeof vi.fn
>;
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

const connection = { id: 1, workspaceId: 7, guildId: "g1" };

beforeEach(() => {
  vi.clearAllMocks();
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

    expect(mockCreateThread).toHaveBeenCalledWith("chan1", "Fix login");
    expect(mockSetThreadId).toHaveBeenCalledWith(mockDb, 5, "t9");
    expect(mockPostMessage).toHaveBeenCalledWith(
      "t9",
      "<@&r1> Fix login — Sprint 1",
      ["r1"],
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

describe("notifyCardMoved", () => {
  const args = {
    cardTitle: "Fix login",
    boardName: "Sprint 1",
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

    expect(mockPostMessage).toHaveBeenCalledWith("t9", "Fix login Sprint 1 - An");
  });

  it("falls back to the board channel when the card has no thread", async () => {
    mockGetByWorkspaceId.mockResolvedValue(connection);
    mockGetBoardChannel.mockResolvedValue("chan1");
    mockPostMessage.mockResolvedValue({ success: true, data: { id: "m1" } });

    await notifyCardMoved(mockDb, { ...args, cardDiscordThreadId: null });

    expect(mockGetBoardChannel).toHaveBeenCalledWith(mockDb, 3);
    expect(mockPostMessage).toHaveBeenCalledWith(
      "chan1",
      "Fix login Sprint 1 - An",
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
