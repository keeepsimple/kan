import { beforeEach, describe, expect, it, vi } from "vitest";

import * as analyticsRepo from "@kan/db/repository/analytics.repo";
import * as boardRepo from "@kan/db/repository/board.repo";
import * as memberRepo from "@kan/db/repository/member.repo";
import * as permissionRepo from "@kan/db/repository/permission.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";

import { memberHasPermission } from "../utils/permissions";

vi.mock("@kan/db/repository/analytics.repo", () => ({
  getActivityCountsByMember: vi.fn(() => []),
  getCompletedCountByMember: vi.fn(() => []),
  getOnTimeStatsByMember: vi.fn(() => []),
  getCurrentlyOverdueByMember: vi.fn(() => []),
  getAvgCycleTimeByMember: vi.fn(() => []),
  getActivityTimeSeries: vi.fn(() => []),
  getOverviewOutcomeTotals: vi.fn(() => []),
}));
vi.mock("@kan/db/repository/workspace.repo", () => ({
  getByPublicId: vi.fn(),
}));
vi.mock("@kan/db/repository/member.repo", () => ({
  getByPublicId: vi.fn(),
  getAllByWorkspaceId: vi.fn(() => []),
}));
vi.mock("@kan/db/repository/permission.repo", () => ({
  getMemberWithRole: vi.fn(),
}));
vi.mock("@kan/db/repository/board.repo", () => ({
  getWorkspaceAndBoardIdByBoardPublicId: vi.fn(),
}));
vi.mock("../utils/permissions", () => ({
  memberHasPermission: vi.fn(),
}));

const mockWsGet = workspaceRepo.getByPublicId as ReturnType<typeof vi.fn>;
const mockGetMemberWithRole = permissionRepo.getMemberWithRole as ReturnType<
  typeof vi.fn
>;
const mockMemberHasPermission = memberHasPermission as ReturnType<
  typeof vi.fn
>;
const mockCompleted = analyticsRepo.getCompletedCountByMember as ReturnType<
  typeof vi.fn
>;
const mockMemberGetByPublicId = memberRepo.getByPublicId as ReturnType<
  typeof vi.fn
>;
const mockMemberGetAllByWorkspaceId =
  memberRepo.getAllByWorkspaceId as ReturnType<typeof vi.fn>;
const mockBoardGetWorkspaceAndBoardId =
  boardRepo.getWorkspaceAndBoardIdByBoardPublicId as ReturnType<typeof vi.fn>;

describe("analytics.getMemberBreakdown access control", () => {
  const mockDb = {} as never;
  const mockUser = { id: "user-1", name: "T", email: "t@e.com" };
  const input = {
    workspacePublicId: "ws-0000000001",
    from: new Date("2026-06-01"),
    to: new Date("2026-07-01"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockWsGet.mockResolvedValue({ id: 7, publicId: "ws-0000000001" });
    mockGetMemberWithRole.mockResolvedValue({
      id: 99,
      publicId: "mem-self0001",
      role: "member",
      roleId: null,
    });
  });

  it("forces a non-admin member to their own memberId", async () => {
    const { analyticsRouter } = await import("./analytics");
    // lacks analytics:view:all, has analytics:view
    mockMemberHasPermission.mockImplementation((_db, _wmId, _roleId, _role, permission) =>
      Promise.resolve(permission === "analytics:view"),
    );
    const ctx = { user: mockUser, db: mockDb } as never;

    await analyticsRouter.createCaller(ctx).getMemberBreakdown(input);

    // repo was called scoped to the caller's own member id (99), ignoring any memberPublicId
    expect(mockCompleted).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ workspaceId: 7, memberId: 99 }),
    );
  });

  it("lets an admin with view:all query the whole team (no member filter)", async () => {
    const { analyticsRouter } = await import("./analytics");
    mockMemberHasPermission.mockResolvedValue(true);
    const ctx = { user: mockUser, db: mockDb } as never;

    await analyticsRouter.createCaller(ctx).getMemberBreakdown(input);

    expect(mockCompleted).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ workspaceId: 7, memberId: undefined }),
    );
  });

  it("rejects unauthenticated callers", async () => {
    const { analyticsRouter } = await import("./analytics");
    const ctx = { user: null, db: mockDb } as never;
    await expect(
      analyticsRouter.createCaller(ctx).getMemberBreakdown(input),
    ).rejects.toThrow();
  });

  it("rejects a memberPublicId that resolves to a different workspace", async () => {
    const { analyticsRouter } = await import("./analytics");
    mockMemberHasPermission.mockResolvedValue(true); // admin, view + view:all
    mockMemberGetByPublicId.mockResolvedValue({
      id: 123,
      workspaceId: 999, // different workspace than caller's (7)
      deletedAt: null,
    });
    const ctx = { user: mockUser, db: mockDb } as never;

    const call = analyticsRouter
      .createCaller(ctx)
      .getMemberBreakdown({ ...input, memberPublicId: "mem-other0001" });

    await expect(call).rejects.toThrow();
    await expect(call).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a memberPublicId of a soft-deleted member in the same workspace", async () => {
    const { analyticsRouter } = await import("./analytics");
    mockMemberHasPermission.mockResolvedValue(true); // admin, view + view:all
    mockMemberGetByPublicId.mockResolvedValue({
      id: 123,
      workspaceId: 7, // same workspace as caller
      deletedAt: new Date(), // but removed
    });
    const ctx = { user: mockUser, db: mockDb } as never;

    const call = analyticsRouter
      .createCaller(ctx)
      .getMemberBreakdown({ ...input, memberPublicId: "mem-gone00001" });

    await expect(call).rejects.toThrow();
    await expect(call).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a boardPublicId that resolves to a different workspace", async () => {
    const { analyticsRouter } = await import("./analytics");
    mockMemberHasPermission.mockResolvedValue(true); // admin, view + view:all
    mockBoardGetWorkspaceAndBoardId.mockResolvedValue({
      id: 456,
      workspaceId: 999, // different workspace than caller's (7)
    });
    const ctx = { user: mockUser, db: mockDb } as never;

    const call = analyticsRouter
      .createCaller(ctx)
      .getMemberBreakdown({ ...input, boardPublicId: "brd-other0001" });

    await expect(call).rejects.toThrow();
    await expect(call).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects getMembers for a caller without analytics:view:all", async () => {
    const { analyticsRouter } = await import("./analytics");
    // has analytics:view but lacks analytics:view:all
    mockMemberHasPermission.mockImplementation(
      (_db, _wmId, _roleId, _role, permission) =>
        Promise.resolve(permission === "analytics:view"),
    );
    mockMemberGetAllByWorkspaceId.mockResolvedValue([
      { id: 99, publicId: "mem-self0001", email: "self@e.com" },
    ]);
    const ctx = { user: mockUser, db: mockDb } as never;

    const call = analyticsRouter.createCaller(ctx).getMembers(input);

    await expect(call).rejects.toThrow();
    await expect(call).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mockMemberGetAllByWorkspaceId).not.toHaveBeenCalled();
  });
});
