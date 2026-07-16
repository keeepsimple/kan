import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/client", () => ({ createDrizzleClient: () => ({}) }));
vi.mock("@kan/db/repository/card.repo", () => ({
  getStaleCompletedCards: vi.fn(() =>
    Promise.resolve([{ id: 1 }, { id: 2 }]),
  ),
  softDelete: vi.fn(() => Promise.resolve({ id: 1, listId: 3, index: 0 })),
}));
vi.mock("@kan/db/repository/cardActivity.repo", () => ({ create: vi.fn() }));

import * as cardRepo from "@kan/db/repository/card.repo";

import handler from "./archive-completed";

const mockGetStale = cardRepo.getStaleCompletedCards as ReturnType<
  typeof vi.fn
>;
const mockSoftDelete = cardRepo.softDelete as ReturnType<typeof vi.fn>;

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
}

function mockRes(): MockResponse {
  const res = {} as MockResponse;
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

function mockReq(overrides: Partial<NextApiRequest>): NextApiRequest {
  return overrides as NextApiRequest;
}

describe("archive-completed cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
  });

  it("rejects a missing/incorrect bearer token with 401", async () => {
    const req = mockReq({
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockGetStale).not.toHaveBeenCalled();
  });

  it("archives stale cards with a valid token", async () => {
    const req = mockReq({
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    });
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(mockSoftDelete).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ archived: 2 }),
    );
  });

  it("rejects non-POST methods with 405", async () => {
    const req = mockReq({ method: "GET", headers: {} });
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(mockGetStale).not.toHaveBeenCalled();
  });
});
