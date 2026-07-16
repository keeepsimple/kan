import { beforeEach, describe, expect, it, vi } from "vitest";

import * as analyticsRepo from "@kan/db/repository/analytics.repo";
import * as permissionRepo from "@kan/db/repository/permission.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";

import { hasPermission } from "../utils/permissions";

vi.mock("@kan/db/repository/analytics.repo", () => ({
  getActivityCountsByMember: vi.fn(() => []),
  getCompletedCountByMember: vi.fn(() => []),
  getOnTimeStatsByMember: vi.fn(() => []),
  getCurrentlyOverdueByMember: vi.fn(() => []),
  getAvgCycleTimeByMember: vi.fn(() => []),
  getActivityTimeSeries: vi.fn(() => []),
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
  assertPermission: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockWsGet = workspaceRepo.getByPublicId as ReturnType<typeof vi.fn>;
const mockGetMemberWithRole = permissionRepo.getMemberWithRole as ReturnType<
  typeof vi.fn
>;
const mockHasPermission = hasPermission as ReturnType<typeof vi.fn>;
const mockCompleted = analyticsRepo.getCompletedCountByMember as ReturnType<
  typeof vi.fn
>;

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
    mockHasPermission.mockResolvedValue(false); // lacks analytics:view:all
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
    mockHasPermission.mockResolvedValue(true);
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
});
