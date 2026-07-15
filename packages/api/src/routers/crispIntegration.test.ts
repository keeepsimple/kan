import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/repository/crispIntegration.repo", () => ({
  create: vi.fn(),
  getByWorkspaceId: vi.fn(),
  hardDeleteByWorkspaceId: vi.fn(),
}));

vi.mock("@kan/db/repository/workspace.repo", () => ({
  getByPublicId: vi.fn(),
}));

vi.mock("@kan/db/repository/list.repo", () => ({
  getWorkspaceAndListIdByListPublicId: vi.fn(),
}));

vi.mock("../utils/permissions", () => ({
  assertPermission: vi.fn(),
}));

import * as crispIntegrationRepo from "@kan/db/repository/crispIntegration.repo";
import * as listRepo from "@kan/db/repository/list.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { assertPermission } from "../utils/permissions";

const mockCreate = crispIntegrationRepo.create as ReturnType<typeof vi.fn>;
const mockGetByWorkspaceId =
  crispIntegrationRepo.getByWorkspaceId as ReturnType<typeof vi.fn>;
const mockHardDelete =
  crispIntegrationRepo.hardDeleteByWorkspaceId as ReturnType<typeof vi.fn>;
const mockWorkspaceGetByPublicId =
  workspaceRepo.getByPublicId as ReturnType<typeof vi.fn>;
const mockGetList =
  listRepo.getWorkspaceAndListIdByListPublicId as ReturnType<typeof vi.fn>;
const mockAssertPermission = assertPermission as ReturnType<typeof vi.fn>;

describe("crispIntegration router", { timeout: 30000 }, () => {
  const mockDb = {} as never;
  const mockUser = { id: "user-123", name: "Test User", email: "t@e.st" };
  const mockWorkspace = { id: 7, publicId: "ws-123456789" };
  const mockList = {
    id: 42,
    publicId: "list-abc12345",
    name: "Inbox",
    createdBy: "user-123",
    workspaceId: 7,
    boardPublicId: "board-abc123",
    boardName: "Support",
  };
  const mockStoredIntegration = {
    publicId: "ci-123456789",
    crispWebsiteId: "site-1",
    webhookSecret: "s3cret",
    active: true,
    createdAt: new Date("2026-01-01"),
    list: {
      publicId: "list-abc12345",
      name: "Inbox",
      board: { publicId: "board-abc123", name: "Support" },
    },
  };

  const ctx = { user: mockUser, db: mockDb } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BASE_URL = "https://kan.test";
    mockAssertPermission.mockResolvedValue(undefined);
    mockWorkspaceGetByPublicId.mockResolvedValue(mockWorkspace);
  });

  it("get throws UNAUTHORIZED when unauthenticated", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    await expect(
      crispIntegrationRouter
        .createCaller({ user: null, db: mockDb } as never)
        .get({ workspacePublicId: "ws-123456789" }),
    ).rejects.toThrow(TRPCError);
  });

  it("get checks workspace:manage permission", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockGetByWorkspaceId.mockResolvedValueOnce(null);

    await crispIntegrationRouter
      .createCaller(ctx)
      .get({ workspacePublicId: "ws-123456789" });

    expect(mockAssertPermission).toHaveBeenCalledWith(
      mockDb,
      "user-123",
      7,
      "workspace:manage",
    );
  });

  it("get returns null when not connected", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockGetByWorkspaceId.mockResolvedValueOnce(null);

    const result = await crispIntegrationRouter
      .createCaller(ctx)
      .get({ workspacePublicId: "ws-123456789" });

    expect(result).toBeNull();
  });

  it("get returns connection with webhook URL containing the secret", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockGetByWorkspaceId.mockResolvedValueOnce(mockStoredIntegration);

    const result = await crispIntegrationRouter
      .createCaller(ctx)
      .get({ workspacePublicId: "ws-123456789" });

    expect(result?.webhookUrl).toBe(
      "https://kan.test/api/integrations/crisp/s3cret",
    );
    expect(result?.board.name).toBe("Support");
    expect(result?.list.name).toBe("Inbox");
  });

  it("create rejects when workspace already has a connection", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockGetList.mockResolvedValueOnce(mockList);
    mockGetByWorkspaceId.mockResolvedValueOnce(mockStoredIntegration);

    await expect(
      crispIntegrationRouter.createCaller(ctx).create({
        workspacePublicId: "ws-123456789",
        crispWebsiteId: "site-1",
        listPublicId: "list-abc12345",
      }),
    ).rejects.toThrow(TRPCError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("create rejects a list from another workspace", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockGetList.mockResolvedValueOnce({ ...mockList, workspaceId: 999 });

    await expect(
      crispIntegrationRouter.createCaller(ctx).create({
        workspacePublicId: "ws-123456789",
        crispWebsiteId: "site-1",
        listPublicId: "list-abc12345",
      }),
    ).rejects.toThrow(TRPCError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("create stores the integration and returns the webhook URL", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockGetList.mockResolvedValueOnce(mockList);
    mockGetByWorkspaceId.mockResolvedValueOnce(null);
    mockCreate.mockImplementationOnce((_db, input) =>
      Promise.resolve({
        publicId: "ci-123456789",
        crispWebsiteId: input.crispWebsiteId,
        webhookSecret: input.webhookSecret,
        active: true,
        createdAt: new Date("2026-01-01"),
      }),
    );

    const result = await crispIntegrationRouter.createCaller(ctx).create({
      workspacePublicId: "ws-123456789",
      crispWebsiteId: "site-1",
      listPublicId: "list-abc12345",
    });

    const createInput = mockCreate.mock.calls[0]?.[1] as {
      webhookSecret: string;
      workspaceId: number;
      listId: number;
      createdBy: string;
    };
    expect(createInput.workspaceId).toBe(7);
    expect(createInput.listId).toBe(42);
    expect(createInput.createdBy).toBe("user-123");
    expect(createInput.webhookSecret.length).toBeGreaterThanOrEqual(32);
    expect(result.webhookUrl).toBe(
      `https://kan.test/api/integrations/crisp/${createInput.webhookSecret}`,
    );
  });

  it("disconnect deletes the workspace connection", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockHardDelete.mockResolvedValueOnce(undefined);

    const result = await crispIntegrationRouter
      .createCaller(ctx)
      .disconnect({ workspacePublicId: "ws-123456789" });

    expect(mockHardDelete).toHaveBeenCalledWith(mockDb, 7);
    expect(result).toEqual({ success: true });
  });
});
