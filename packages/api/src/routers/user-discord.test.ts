import { beforeEach, describe, expect, it, vi } from "vitest";

import * as discordRepo from "@kan/db/repository/discord.repo";
import * as userRepo from "@kan/db/repository/user.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { getUser, searchGuildMembers } from "@kan/discord";

import { assertPermission } from "../utils/permissions";
import { discordRouter } from "./discord";
import { userRouter } from "./user";

// Mock every module user.ts / discord.ts import before importing the routers.
vi.mock("@kan/db/repository/user.repo", () => ({
  setDiscordMapping: vi.fn(),
  clearDiscordMapping: vi.fn(),
  getById: vi.fn(),
}));

vi.mock("@kan/db/repository/discord.repo", () => ({
  getByWorkspaceId: vi.fn(),
}));

vi.mock("@kan/db/repository/workspace.repo", () => ({
  getByPublicId: vi.fn(),
}));

vi.mock("@kan/discord", () => ({
  getUser: vi.fn(),
  searchGuildMembers: vi.fn(),
  isDiscordConfigured: vi.fn(),
  getBotInviteUrl: vi.fn(),
  getGuild: vi.fn(),
  getTextChannels: vi.fn(),
  getRoles: vi.fn(),
}));

vi.mock("../utils/permissions", () => ({
  assertPermission: vi.fn(),
}));

const mockSet = userRepo.setDiscordMapping as ReturnType<typeof vi.fn>;
const mockClear = userRepo.clearDiscordMapping as ReturnType<typeof vi.fn>;
const mockGetUser = getUser as ReturnType<typeof vi.fn>;
const mockSearchGuildMembers = searchGuildMembers as ReturnType<typeof vi.fn>;
const mockGetByWorkspaceId = discordRepo.getByWorkspaceId as ReturnType<
  typeof vi.fn
>;
const mockGetWorkspaceByPublicId = workspaceRepo.getByPublicId as ReturnType<
  typeof vi.fn
>;
const mockAssertPermission = assertPermission as ReturnType<typeof vi.fn>;

const mockDb = {} as never;

// Valid 15-20 digit Discord snowflake (matches /^\d{15,20}$/).
const VALID_DISCORD_ID = "123456789012345";

describe("user.linkDiscord", () => {
  const ctx = { user: { id: "user1" }, db: mockDb } as never;
  const caller = userRouter.createCaller(ctx);

  beforeEach(() => vi.clearAllMocks());

  it("links a pasted discord id to the calling user and resolves the handle", async () => {
    mockGetUser.mockResolvedValue({
      success: true,
      data: { id: VALID_DISCORD_ID, username: "alice", displayName: "Alice" },
    });

    const result = await caller.linkDiscord({
      discordUserId: VALID_DISCORD_ID,
    });

    expect(mockGetUser).toHaveBeenCalledWith(VALID_DISCORD_ID);
    expect(mockSet).toHaveBeenCalledWith(mockDb, "user1", {
      discordUserId: VALID_DISCORD_ID,
      discordUsername: "alice",
    });
    expect(result).toEqual({
      discordUserId: VALID_DISCORD_ID,
      discordUsername: "alice",
    });
  });

  it("stores a null username (best-effort) when the discord lookup fails", async () => {
    mockGetUser.mockResolvedValue({ success: false, error: "not found" });

    const result = await caller.linkDiscord({
      discordUserId: VALID_DISCORD_ID,
    });

    expect(mockSet).toHaveBeenCalledWith(mockDb, "user1", {
      discordUserId: VALID_DISCORD_ID,
      discordUsername: null,
    });
    expect(result).toEqual({
      discordUserId: VALID_DISCORD_ID,
      discordUsername: null,
    });
  });

  it("rejects a non-numeric discord id", async () => {
    await expect(
      caller.linkDiscord({ discordUserId: "not-a-snowflake" }),
    ).rejects.toThrow();
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("rejects a discord id shorter than 15 digits", async () => {
    await expect(
      caller.linkDiscord({ discordUserId: "123" }),
    ).rejects.toThrow();
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe("user.unlinkDiscord", () => {
  const ctx = { user: { id: "user1" }, db: mockDb } as never;
  const caller = userRouter.createCaller(ctx);

  beforeEach(() => vi.clearAllMocks());

  it("clears the calling user's mapping", async () => {
    const result = await caller.unlinkDiscord({});

    expect(mockClear).toHaveBeenCalledWith(mockDb, "user1");
    expect(result).toEqual({ success: true });
  });
});

describe("discord.searchWorkspaceDiscordMembers", () => {
  const ctx = { user: { id: "user1" }, db: mockDb } as never;
  const caller = discordRouter.createCaller(ctx);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkspaceByPublicId.mockResolvedValue({
      id: 1,
      publicId: "ws1234567890",
    });
    mockAssertPermission.mockResolvedValue(undefined);
  });

  it("searches guild members for an authorized workspace member", async () => {
    mockGetByWorkspaceId.mockResolvedValue({
      id: 1,
      guildId: "guild1",
      workspaceId: 1,
    });
    mockSearchGuildMembers.mockResolvedValue({
      success: true,
      data: [{ id: "1", username: "alice", displayName: "Alice" }],
    });

    const result = await caller.searchWorkspaceDiscordMembers({
      workspacePublicId: "ws1234567890",
      query: "ali",
    });

    expect(mockAssertPermission).toHaveBeenCalledWith(
      mockDb,
      "user1",
      1,
      "board:view",
    );
    expect(mockSearchGuildMembers).toHaveBeenCalledWith("guild1", "ali");
    expect(result).toEqual([
      { id: "1", username: "alice", displayName: "Alice" },
    ]);
  });

  it("throws NOT_FOUND when discord is not connected for the workspace", async () => {
    mockGetByWorkspaceId.mockResolvedValue(undefined);

    await expect(
      caller.searchWorkspaceDiscordMembers({
        workspacePublicId: "ws1234567890",
        query: "ali",
      }),
    ).rejects.toThrow();
    expect(mockSearchGuildMembers).not.toHaveBeenCalled();
  });

  it("is permission-gated: rejects when the user lacks board:view on the workspace", async () => {
    mockGetByWorkspaceId.mockResolvedValue({
      id: 1,
      guildId: "guild1",
      workspaceId: 1,
    });
    mockAssertPermission.mockRejectedValue(new Error("forbidden"));

    await expect(
      caller.searchWorkspaceDiscordMembers({
        workspacePublicId: "ws1234567890",
        query: "ali",
      }),
    ).rejects.toThrow();
    expect(mockSearchGuildMembers).not.toHaveBeenCalled();
  });
});
