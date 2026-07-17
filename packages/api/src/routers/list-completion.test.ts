import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock every module list.ts imports before importing the router.
vi.mock("@kan/db/repository/board.repo", () => ({
  getWorkspaceAndBoardIdByBoardPublicId: vi.fn(),
}));

vi.mock("@kan/db/repository/card.repo", () => ({
  softDeleteAllByListIds: vi.fn(),
  backfillCompletedAtForList: vi.fn(),
  clearCompletedAtForList: vi.fn(),
}));

vi.mock("@kan/db/repository/cardActivity.repo", () => ({
  bulkCreate: vi.fn(),
}));

vi.mock("@kan/db/repository/list.repo", () => ({
  create: vi.fn(),
  getWorkspaceAndListIdByListPublicId: vi.fn(),
  update: vi.fn(),
  updateDiscordConfig: vi.fn(),
  updateCompletionConfig: vi.fn(),
  reorder: vi.fn(),
  softDeleteById: vi.fn(),
  getBoardPublicIdByListPublicId: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../utils/permissions", () => ({
  assertCanDelete: vi.fn(),
  assertCanEdit: vi.fn(),
  assertPermission: vi.fn(),
}));

import * as cardRepo from "@kan/db/repository/card.repo";
import * as listRepo from "@kan/db/repository/list.repo";

import { assertCanEdit } from "../utils/permissions";

const mockUpdateConfig = listRepo.updateCompletionConfig as ReturnType<
  typeof vi.fn
>;
const mockGetListMeta = listRepo.getWorkspaceAndListIdByListPublicId as
  ReturnType<typeof vi.fn>;
const mockBackfill = cardRepo.backfillCompletedAtForList as ReturnType<
  typeof vi.fn
>;
const mockClearAll = cardRepo.clearCompletedAtForList as ReturnType<
  typeof vi.fn
>;
const mockAssertCanEdit = assertCanEdit as ReturnType<typeof vi.fn>;

describe("list.update completion config", () => {
  const mockDb = {} as never;
  const mockUser = { id: "user-1", name: "T", email: "t@e.com" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertCanEdit.mockResolvedValue(undefined);
    mockGetListMeta.mockResolvedValue({
      id: 20,
      publicId: "list-done0001",
      name: "Done",
      createdBy: "user-1",
      workspaceId: 7,
      boardPublicId: "brd-000000001",
      boardName: "Board",
      discordBehaviour: null,
      discordRoleIds: null,
      boardDiscordChannelId: null,
    });
    mockUpdateConfig.mockResolvedValue({
      publicId: "list-done0001",
      name: "Done",
    });
  });

  it("backfills completedAt when a list is marked completed", async () => {
    const { listRouter } = await import("./list");
    const ctx = { user: mockUser, db: mockDb } as never;
    await listRouter.createCaller(ctx).update({
      listPublicId: "list-done0001",
      isCompleted: true,
    });

    expect(mockUpdateConfig).toHaveBeenCalledWith(mockDb, {
      listPublicId: "list-done0001",
      isCompleted: true,
      autoArchiveEnabled: undefined,
      autoArchiveDays: undefined,
    });
    expect(mockBackfill).toHaveBeenCalledWith(mockDb, {
      listId: 20,
      completedBy: "user-1",
    });
    expect(mockClearAll).not.toHaveBeenCalled();
  });

  it("clears completedAt when a list is un-marked", async () => {
    const { listRouter } = await import("./list");
    const ctx = { user: mockUser, db: mockDb } as never;
    await listRouter.createCaller(ctx).update({
      listPublicId: "list-done0001",
      isCompleted: false,
    });

    expect(mockUpdateConfig).toHaveBeenCalledWith(mockDb, {
      listPublicId: "list-done0001",
      isCompleted: false,
      autoArchiveEnabled: undefined,
      autoArchiveDays: undefined,
    });
    expect(mockClearAll).toHaveBeenCalledWith(mockDb, { listId: 20 });
    expect(mockBackfill).not.toHaveBeenCalled();
  });
});
