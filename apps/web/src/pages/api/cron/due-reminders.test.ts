import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as cardRepo from "@kan/db/repository/card.repo";
import { postMessage } from "@kan/discord";

import handler from "./due-reminders";

vi.mock("@kan/db/client", () => ({ createDrizzleClient: () => ({}) }));
vi.mock("@kan/db/repository/card.repo", () => ({
  getCardsNeedingDueSoonReminder: vi.fn(() => Promise.resolve([])),
  getCardsNeedingDueNowReminder: vi.fn(() => Promise.resolve([])),
  markDueReminderSent: vi.fn(),
  markDueArrivedReminderSent: vi.fn(),
}));
vi.mock("@kan/discord", () => ({
  postMessage: vi.fn(),
  buildUserMentions: (ids: string[]) => ids.map((id) => `<@${id}>`).join(" "),
}));

const mockGetDueSoon = cardRepo.getCardsNeedingDueSoonReminder as ReturnType<
  typeof vi.fn
>;
const mockGetDueNow = cardRepo.getCardsNeedingDueNowReminder as ReturnType<
  typeof vi.fn
>;
const mockMarkSoon = cardRepo.markDueReminderSent as ReturnType<typeof vi.fn>;
const mockMarkNow = cardRepo.markDueArrivedReminderSent as ReturnType<
  typeof vi.fn
>;
const mockPostMessage = postMessage as ReturnType<typeof vi.fn>;

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

describe("due-reminders cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDueSoon.mockResolvedValue([]);
    mockGetDueNow.mockResolvedValue([]);
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
    expect(mockGetDueSoon).not.toHaveBeenCalled();
  });

  it("posts a due-soon reminder and marks the card", async () => {
    const due = new Date("2026-07-17T02:00:00Z");
    mockGetDueSoon.mockResolvedValue([
      {
        id: 1,
        title: "Test",
        dueDate: due,
        discordThreadId: "t1",
        members: [],
      },
    ]);
    mockPostMessage.mockResolvedValue({ success: true, data: { id: "m1" } });

    const req = mockReq({
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    });
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);

    const unix = Math.floor(due.getTime() / 1000);
    expect(mockPostMessage).toHaveBeenCalledWith(
      "t1",
      "",
      [],
      [
        expect.objectContaining({
          title: "⏰ Due soon",
          description: `**Test** — <t:${unix}:R> (<t:${unix}:f>)`,
        }),
      ],
      [],
    );
    expect(mockMarkSoon).toHaveBeenCalledWith(expect.anything(), 1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ reminded: 1 }),
    );
  });

  it("posts a due-now reminder and marks the card", async () => {
    const due = new Date("2026-07-17T02:00:00Z");
    mockGetDueNow.mockResolvedValue([
      {
        id: 2,
        title: "Test",
        dueDate: due,
        discordThreadId: "t1",
        members: [],
      },
    ]);
    mockPostMessage.mockResolvedValue({ success: true, data: { id: "m1" } });

    const req = mockReq({
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    });
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);

    const unix = Math.floor(due.getTime() / 1000);
    expect(mockPostMessage).toHaveBeenCalledWith(
      "t1",
      "",
      [],
      [
        expect.objectContaining({
          title: "🔔 Due now",
          description: `**Test** — <t:${unix}:f>`,
        }),
      ],
      [],
    );
    expect(mockMarkNow).toHaveBeenCalledWith(expect.anything(), 2);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ reminded: 1 }),
    );
  });

  it("does not mark the card when Discord rejects the message", async () => {
    mockGetDueSoon.mockResolvedValue([
      {
        id: 1,
        title: "Test",
        dueDate: new Date(),
        discordThreadId: "t1",
        members: [],
      },
    ]);
    mockPostMessage.mockResolvedValue({ success: false, error: "403" });

    const req = mockReq({
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    });
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);

    expect(mockMarkSoon).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ reminded: 0 }),
    );
  });

  it("pings assignees with linked discord ids", async () => {
    mockGetDueSoon.mockResolvedValue([
      {
        id: 1,
        title: "Ship it",
        dueDate: new Date(),
        discordThreadId: "thread1",
        members: [{ member: { user: { discordUserId: "111" } } }],
      },
    ]);
    mockPostMessage.mockResolvedValue({ success: true, data: { id: "m1" } });

    const req = mockReq({
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    });
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);

    expect(mockPostMessage).toHaveBeenCalledWith(
      "thread1",
      expect.stringContaining("<@111>"), // content
      [],
      expect.any(Array),
      ["111"], // mentionUserIds
    );
  });
});
