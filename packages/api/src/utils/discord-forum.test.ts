import { beforeEach, expect, it, vi } from "vitest";

import type { dbClient } from "@kan/db/client";
import * as discordRepo from "@kan/db/repository/discord.repo";
import * as discordClient from "@kan/discord";

import { notifyCardCreated, notifyCardMoved } from "./discord";

vi.mock("@kan/db/repository/discord.repo", () => ({
  getByWorkspaceId: vi.fn(() => Promise.resolve({ id: 1 })),
  setCardDiscordThreadId: vi.fn(),
  setCardDiscordMessageId: vi.fn(),
  getBoardDiscordChannelId: vi.fn(),
}));
vi.mock("@kan/db/repository/card.repo", () => ({}));
vi.mock("@kan/discord", async (importActual) => {
  const actual = await importActual<typeof import("@kan/discord")>();
  return {
    ...actual,
    getChannel: vi.fn(),
    createThread: vi.fn(),
    createForumPost: vi.fn(),
    postMessage: vi.fn(() =>
      Promise.resolve({ success: true, data: { id: "m1" } }),
    ),
  };
});

const db = {} as dbClient;
const base = {
  cardId: 10,
  cardPublicId: "card_00000001",
  cardTitle: "Ship it",
  boardName: "Roadmap",
  workspaceId: 1,
  discordBehaviour: "create_thread",
  discordRoleIds: null,
  labelNames: ["Bug"],
};

beforeEach(() => vi.clearAllMocks());

it("creates a forum post (not a thread) when the channel is a forum", async () => {
  (discordClient.getChannel as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
    data: {
      id: "chan1",
      type: 15,
      flags: 0,
      availableTags: [{ id: "t1", name: "Bug" }],
    },
  });
  (discordClient.createForumPost as ReturnType<typeof vi.fn>).mockResolvedValue(
    {
      success: true,
      data: { id: "post1" },
    },
  );

  await notifyCardCreated(db, { ...base, discordChannelId: "chan1" });

  expect(discordClient.createForumPost).toHaveBeenCalledWith(
    "chan1",
    "Ship it - 📋 Roadmap",
    expect.objectContaining({ appliedTagIds: ["t1"] }),
  );
  expect(discordClient.createThread).not.toHaveBeenCalled();
  expect(discordRepo.setCardDiscordThreadId).toHaveBeenCalledWith(
    db,
    10,
    "post1",
  );
  expect(discordRepo.setCardDiscordMessageId).toHaveBeenCalledWith(
    db,
    10,
    "post1",
  );
});

it("creates a thread + message when the channel is a text channel", async () => {
  (discordClient.getChannel as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
    data: { id: "chan1", type: 0, flags: 0, availableTags: [] },
  });
  (discordClient.createThread as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
    data: { id: "thread1" },
  });

  await notifyCardCreated(db, { ...base, discordChannelId: "chan1" });

  expect(discordClient.createThread).toHaveBeenCalled();
  expect(discordClient.createForumPost).not.toHaveBeenCalled();
  expect(discordRepo.setCardDiscordThreadId).toHaveBeenCalledWith(
    db,
    10,
    "thread1",
  );
});

it("skips the fallback post when the card has no thread and the board channel is a forum", async () => {
  (
    discordRepo.getBoardDiscordChannelId as ReturnType<typeof vi.fn>
  ).mockResolvedValue("forumChan");
  (discordClient.getChannel as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
    data: { id: "forumChan", type: 15, flags: 0, availableTags: [] },
  });

  await notifyCardMoved(db, {
    cardTitle: "x",
    newListName: "Done",
    userName: "u",
    workspaceId: 1,
    newListDiscordBehaviour: "notify",
    cardDiscordThreadId: null,
    newListBoardId: 5,
  });

  expect(discordClient.postMessage).not.toHaveBeenCalled();
});
