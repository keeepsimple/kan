import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/repository/card.repo", () => ({ getDiscordContextByPublicId: vi.fn() }));
vi.mock("@kan/db/repository/member.repo", () => ({ getByPublicIdsWithUsers: vi.fn() }));
vi.mock("@kan/discord", () => ({
  postMessage: vi.fn(() => Promise.resolve({ success: true })),
  buildUserMentions: (ids: string[]) => ids.map((id) => `<@${id}>`).join(" "),
}));

import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as memberRepo from "@kan/db/repository/member.repo";
import { postMessage } from "@kan/discord";

import { notifyAssigned } from "./discordMentions";

const db = {} as dbClient;
const mockCtx = cardRepo.getDiscordContextByPublicId as ReturnType<typeof vi.fn>;
const mockMembers = memberRepo.getByPublicIdsWithUsers as ReturnType<typeof vi.fn>;
const mockPost = postMessage as ReturnType<typeof vi.fn>;

describe("notifyAssigned", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pings the assigned member's discord id in the card thread", async () => {
    mockCtx.mockResolvedValue({ discordThreadId: "thread1" });
    mockMembers.mockResolvedValue([{ user: { discordUserId: "111" } }]);
    await notifyAssigned(db, "card_1", ["mem_1"]);
    expect(mockPost).toHaveBeenCalledWith("thread1", expect.stringContaining("<@111>"), [], [], ["111"]);
  });

  it("does nothing when the card has no thread", async () => {
    mockCtx.mockResolvedValue({ discordThreadId: null });
    await notifyAssigned(db, "card_1", ["mem_1"]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("does nothing when the member has no linked discord id", async () => {
    mockCtx.mockResolvedValue({ discordThreadId: "thread1" });
    mockMembers.mockResolvedValue([{ user: { discordUserId: null } }]);
    await notifyAssigned(db, "card_1", ["mem_1"]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("never throws when a repo call rejects", async () => {
    mockCtx.mockRejectedValue(new Error("db down"));
    await expect(notifyAssigned(db, "card_1", ["mem_1"])).resolves.toBeUndefined();
  });
});
