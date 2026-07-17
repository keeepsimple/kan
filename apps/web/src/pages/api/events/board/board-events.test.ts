import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeToBoard } from "@kan/api/events/boardEvents";
import { hasPermission } from "@kan/api/utils/permissions";
import * as boardRepo from "@kan/db/repository/board.repo";

import handler from "./[boardPublicId]";

// vi.hoisted: vi.mock factories are hoisted above top-level consts, so a
// plain `const mockGetSession = vi.fn()` would hit a TDZ error here.
const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }));
vi.mock("@kan/auth/server", () => ({
  initAuth: () => ({ api: { getSession: mockGetSession } }),
}));
vi.mock("@kan/db/client", () => ({ createDrizzleClient: () => ({}) }));
vi.mock("@kan/db/repository/board.repo", () => ({
  getWorkspaceAndBoardIdByBoardPublicId: vi.fn(),
}));
vi.mock("@kan/api/utils/permissions", () => ({
  hasPermission: vi.fn(),
}));
vi.mock("@kan/api/events/boardEvents", () => ({
  subscribeToBoard: vi.fn(() => vi.fn()),
}));

const mockGetBoard =
  boardRepo.getWorkspaceAndBoardIdByBoardPublicId as ReturnType<typeof vi.fn>;
const mockHasPermission = hasPermission as ReturnType<typeof vi.fn>;
const mockSubscribe = subscribeToBoard as ReturnType<typeof vi.fn>;

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  writeHead: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
}

function mockRes(): MockResponse {
  const res = {} as MockResponse;
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  res.writeHead = vi.fn(() => res);
  res.write = vi.fn(() => true);
  return res;
}

function mockReq(overrides: Partial<NextApiRequest>): {
  req: NextApiRequest;
  close: () => void;
} {
  const closeHandlers: (() => void)[] = [];
  const req = {
    method: "GET",
    query: { boardPublicId: "board_aaaaaaaa" },
    headers: {},
    on: vi.fn((event: string, cb: () => void) => {
      if (event === "close") closeHandlers.push(cb);
    }),
    ...overrides,
  } as unknown as NextApiRequest;
  return { req, close: () => closeHandlers.forEach((cb) => cb()) };
}

describe("board events SSE endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("rejects non-GET with 405", async () => {
    const { req } = mockReq({ method: "POST" });
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("rejects a missing session with 401", async () => {
    mockGetSession.mockResolvedValue(null);
    const { req } = mockReq({});
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("rejects an unknown board with 404", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user_1" } });
    mockGetBoard.mockResolvedValue(undefined);
    const { req } = mockReq({});
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("rejects a member without board:view with 403", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user_1" } });
    mockGetBoard.mockResolvedValue({ id: 1, workspaceId: 7, createdBy: "u" });
    mockHasPermission.mockResolvedValue(false);
    const { req } = mockReq({});
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(mockHasPermission).toHaveBeenCalledWith(
      {},
      "user_1",
      7,
      "board:view",
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("opens a stream, forwards events, and cleans up on close", async () => {
    vi.useFakeTimers();
    mockGetSession.mockResolvedValue({ user: { id: "user_1" } });
    mockGetBoard.mockResolvedValue({ id: 1, workspaceId: 7, createdBy: "u" });
    mockHasPermission.mockResolvedValue(true);
    const unsubscribe = vi.fn();
    mockSubscribe.mockReturnValue(unsubscribe);

    const { req, close } = mockReq({});
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "text/event-stream" }),
    );
    expect(mockSubscribe).toHaveBeenCalledWith(
      "board_aaaaaaaa",
      expect.any(Function),
    );

    // forward an event through the captured listener
    const [, listener] = mockSubscribe.mock.calls[0] as [
      string,
      (e: unknown) => void,
    ];
    listener({ boardPublicId: "board_aaaaaaaa", cardPublicId: "card_1" });
    expect(res.write).toHaveBeenCalledWith(
      `data: ${JSON.stringify({ boardPublicId: "board_aaaaaaaa", cardPublicId: "card_1" })}\n\n`,
    );

    // heartbeat fires
    const writesBefore = res.write.mock.calls.length;
    vi.advanceTimersByTime(25_000);
    expect(res.write.mock.calls.length).toBeGreaterThan(writesBefore);

    // close cleans up: unsubscribes and stops the heartbeat
    close();
    expect(unsubscribe).toHaveBeenCalled();
    const writesAfterClose = res.write.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(res.write.mock.calls.length).toBe(writesAfterClose);
  });
});
