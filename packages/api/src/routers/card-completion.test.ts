import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock every module card.ts imports before importing the router.
vi.mock("@kan/db/repository/card.repo", () => ({
  bulkCreateCardLabelRelationships: vi.fn(),
  bulkCreateCardWorkspaceMemberRelationships: vi.fn(),
  create: vi.fn(),
  createCardLabelRelationship: vi.fn(),
  createCardMemberRelationship: vi.fn(),
  getByPublicId: vi.fn(),
  getCardLabelRelationship: vi.fn(),
  getCardMemberRelationship: vi.fn(),
  getWithListAndMembersByPublicId: vi.fn(),
  getWorkspaceAndCardIdByCardPublicId: vi.fn(),
  hardDeleteCardLabelRelationship: vi.fn(),
  hardDeleteCardMemberRelationship: vi.fn(),
  reorder: vi.fn(),
  softDelete: vi.fn(),
  update: vi.fn(),
  setCompletedAt: vi.fn(),
  clearCompletedAt: vi.fn(),
  getBoardPublicIdByCardPublicId: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("@kan/db/repository/cardActivity.repo", () => ({
  bulkCreate: vi.fn(),
  create: vi.fn(),
  getPaginatedActivities: vi.fn(),
}));

vi.mock("@kan/db/repository/cardComment.repo", () => ({
  create: vi.fn(),
  getByPublicId: vi.fn(),
  softDelete: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@kan/db/repository/checklist.repo", () => ({
  create: vi.fn(),
  createItem: vi.fn(),
}));

vi.mock("@kan/db/repository/label.repo", () => ({
  getAllByPublicIds: vi.fn(),
  getByPublicId: vi.fn(),
}));

vi.mock("@kan/db/repository/list.repo", () => ({
  getByPublicId: vi.fn(),
  getWorkspaceAndListIdByListPublicId: vi.fn(),
}));

vi.mock("@kan/db/repository/workspace.repo", () => ({
  getAllMembersByPublicIds: vi.fn(),
  getMemberByPublicId: vi.fn(),
}));

vi.mock("../utils/permissions", () => ({
  assertCanEdit: vi.fn(),
  assertCanDelete: vi.fn(),
  assertPermission: vi.fn(),
}));

vi.mock("../utils/discord", () => ({
  assertListAllowsCardCreation: vi.fn(),
  notifyCardCreated: vi.fn(() => Promise.resolve()),
  notifyCardMoved: vi.fn(() => Promise.resolve()),
  notifyCardUpdated: vi.fn(() => Promise.resolve()),
}));

vi.mock("../utils/webhook", () => ({
  createCardWebhookPayload: vi.fn(),
  sendWebhooksForWorkspace: vi.fn(),
}));

vi.mock("../utils/notifications", () => ({
  sendMentionEmails: vi.fn(),
}));

vi.mock("../utils/activities", () => ({
  mergeActivities: vi.fn(),
}));

import * as cardRepo from "@kan/db/repository/card.repo";
import * as listRepo from "@kan/db/repository/list.repo";

import { notifyCardMoved } from "../utils/discord";
import { assertCanEdit } from "../utils/permissions";
import { sendWebhooksForWorkspace } from "../utils/webhook";

const mockCardGet = cardRepo.getByPublicId as ReturnType<typeof vi.fn>;
const mockGetWorkspaceAndCardId =
  cardRepo.getWorkspaceAndCardIdByCardPublicId as ReturnType<typeof vi.fn>;
const mockReorder = cardRepo.reorder as ReturnType<typeof vi.fn>;
const mockListGet = listRepo.getByPublicId as ReturnType<typeof vi.fn>;
const mockSetCompleted = cardRepo.setCompletedAt as ReturnType<typeof vi.fn>;
const mockClearCompleted = cardRepo.clearCompletedAt as ReturnType<
  typeof vi.fn
>;
const mockAssertCanEdit = assertCanEdit as ReturnType<typeof vi.fn>;
const mockNotifyCardMoved = notifyCardMoved as ReturnType<typeof vi.fn>;
const mockSendWebhooks = sendWebhooksForWorkspace as ReturnType<typeof vi.fn>;

describe("card.update completion tracking", () => {
  const mockDb = {} as never;
  const mockUser = { id: "user-1", name: "T", email: "t@e.com" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertCanEdit.mockResolvedValue(undefined);
    mockNotifyCardMoved.mockResolvedValue(undefined);
    mockSendWebhooks.mockResolvedValue(undefined);
    mockGetWorkspaceAndCardId.mockResolvedValue({
      id: 5,
      createdBy: "user-1",
      workspaceId: 1,
      workspaceVisibility: "private",
      listPublicId: "list-old0001",
      listName: "Doing",
      boardPublicId: "brd-000000001",
      boardName: "Board",
    });
    mockReorder.mockResolvedValue({
      id: 5,
      publicId: "card-000000001",
      title: "x",
      description: null,
      dueDate: null,
    });
  });

  it("stamps completedAt when moved into a completed list", async () => {
    const { cardRouter } = await import("./card");
    mockCardGet.mockResolvedValue({
      id: 5,
      publicId: "card-000000001",
      listId: 10,
      list: { publicId: "list-old0001", name: "Doing", isCompleted: false },
      title: "x",
      description: null,
      dueDate: null,
    });
    mockListGet.mockResolvedValue({
      id: 20,
      publicId: "list-done0001",
      isCompleted: true,
    });

    const ctx = { user: mockUser, db: mockDb } as never;
    await cardRouter.createCaller(ctx).update({
      cardPublicId: "card-000000001",
      listPublicId: "list-done0001",
    });

    expect(mockSetCompleted).toHaveBeenCalledWith(mockDb, {
      cardId: 5,
      completedAt: expect.any(Date),
      completedBy: "user-1",
    });
    expect(mockClearCompleted).not.toHaveBeenCalled();
  });

  it("clears completedAt when moved out of a completed list into a normal list", async () => {
    const { cardRouter } = await import("./card");
    mockCardGet.mockResolvedValue({
      id: 5,
      publicId: "card-000000001",
      listId: 20,
      list: { publicId: "list-done0001", name: "Done", isCompleted: true },
      title: "x",
      description: null,
      dueDate: null,
    });
    mockListGet.mockResolvedValue({
      id: 10,
      publicId: "list-todo0001",
      isCompleted: false,
    });

    const ctx = { user: mockUser, db: mockDb } as never;
    await cardRouter.createCaller(ctx).update({
      cardPublicId: "card-000000001",
      listPublicId: "list-todo0001",
    });

    expect(mockClearCompleted).toHaveBeenCalledWith(mockDb, { cardId: 5 });
    expect(mockSetCompleted).not.toHaveBeenCalled();
  });
});
