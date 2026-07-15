import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/repository/crispIntegration.repo", () => ({
  getActiveBySecret: vi.fn(),
}));

vi.mock("@kan/db/repository/card.repo", () => ({
  create: vi.fn(),
}));

vi.mock("./webhook", () => ({
  createCardWebhookPayload: vi.fn(() => ({ event: "card.created" })),
  sendWebhooksForWorkspace: vi.fn(() => Promise.resolve()),
}));

import * as cardRepo from "@kan/db/repository/card.repo";
import * as crispIntegrationRepo from "@kan/db/repository/crispIntegration.repo";

import {
  buildCardDescription,
  handleCrispWebhook,
  parseCardCommand,
} from "./crisp";

const mockGetActiveBySecret =
  crispIntegrationRepo.getActiveBySecret as ReturnType<typeof vi.fn>;
const mockCardCreate = cardRepo.create as ReturnType<typeof vi.fn>;

describe("parseCardCommand", () => {
  it("returns null when content does not start with #card", () => {
    expect(parseCardCommand("hello world")).toBeNull();
    expect(parseCardCommand("please #card do thing")).toBeNull();
  });

  it("returns null for a bare #card with no title", () => {
    expect(parseCardCommand("#card")).toBeNull();
    expect(parseCardCommand("#card    ")).toBeNull();
  });

  it("extracts a single-line title with empty body", () => {
    expect(parseCardCommand("#card Fix login bug")).toEqual({
      title: "Fix login bug",
      body: "",
    });
  });

  it("trims surrounding whitespace before matching the prefix", () => {
    expect(parseCardCommand("  #card Fix login bug  ")).toEqual({
      title: "Fix login bug",
      body: "",
    });
  });

  it("uses the first line as title and the rest as body", () => {
    expect(
      parseCardCommand("#card Fix login bug\nUser cannot sign in\nwith SSO"),
    ).toEqual({
      title: "Fix login bug",
      body: "User cannot sign in\nwith SSO",
    });
  });

  it("truncates the title at 2000 characters", () => {
    const result = parseCardCommand(`#card ${"a".repeat(3000)}`);
    expect(result?.title).toHaveLength(2000);
  });
});

describe("buildCardDescription", () => {
  it("includes the conversation link", () => {
    const description = buildCardDescription({
      body: "",
      websiteId: "site-1",
      sessionId: "session_abc",
    });
    expect(description).toContain(
      "https://app.crisp.chat/website/site-1/inbox/session_abc/",
    );
  });

  it("includes body and operator nickname when provided", () => {
    const description = buildCardDescription({
      body: "Steps to reproduce",
      websiteId: "site-1",
      sessionId: "session_abc",
      operatorNickname: "Jane",
    });
    expect(description).toContain("Steps to reproduce");
    expect(description).toContain("Jane");
  });

  it("caps the description at 10000 characters", () => {
    const description = buildCardDescription({
      body: "x".repeat(20000),
      websiteId: "site-1",
      sessionId: "session_abc",
    });
    expect(description.length).toBeLessThanOrEqual(10000);
  });
});

describe("handleCrispWebhook", () => {
  const mockDb = {} as never;
  const mockIntegration = {
    id: 1,
    workspaceId: 7,
    crispWebsiteId: "site-1",
    listId: 42,
    createdBy: "user-123",
    list: {
      publicId: "list-abc12345",
      name: "Inbox",
      deletedAt: null,
      board: { publicId: "board-abc123", name: "Support" },
    },
  };

  const noteEvent = (content: string) => ({
    event: "message:received",
    data: {
      website_id: "site-1",
      session_id: "session_xyz",
      type: "note",
      from: "operator",
      content,
      user: { nickname: "Jane" },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCardCreate.mockResolvedValue({ id: 99, publicId: "card-abc12345" });
  });

  it("returns 404 for an unknown token", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(null);

    const result = await handleCrispWebhook(mockDb, "bad-token", noteEvent("#card X"));

    expect(result.status).toBe(404);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores non-note messages with 200", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const event = noteEvent("#card X");
    event.data.type = "text";

    const result = await handleCrispWebhook(mockDb, "secret", event);

    expect(result.status).toBe(200);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores notes from a different crisp website with 200", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const event = noteEvent("#card X");
    event.data.website_id = "other-site";

    const result = await handleCrispWebhook(mockDb, "secret", event);

    expect(result.status).toBe(200);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores notes without the #card prefix with 200", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const result = await handleCrispWebhook(mockDb, "secret", noteEvent("just a note"));

    expect(result.status).toBe(200);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores malformed payloads with 200", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const result = await handleCrispWebhook(mockDb, "secret", { nope: true });

    expect(result.status).toBe(200);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores notes when the target list is soft-deleted", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce({
      ...mockIntegration,
      list: { ...mockIntegration.list, deletedAt: new Date() },
    });

    const result = await handleCrispWebhook(mockDb, "secret", noteEvent("#card X"));

    expect(result.status).toBe(200);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("creates a card from a valid #card note", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const result = await handleCrispWebhook(
      mockDb,
      "secret",
      noteEvent("#card Fix login bug\nUser cannot sign in"),
    );

    expect(result.status).toBe(200);
    expect(mockCardCreate).toHaveBeenCalledWith(mockDb, {
      title: "Fix login bug",
      description: buildCardDescription({
        body: "User cannot sign in",
        websiteId: "site-1",
        sessionId: "session_xyz",
        operatorNickname: "Jane",
      }),
      createdBy: "user-123",
      listId: 42,
      workspaceId: 7,
      position: "end",
    });
  });

  it("returns 500 when card creation throws", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);
    mockCardCreate.mockRejectedValueOnce(new Error("db down"));

    const result = await handleCrispWebhook(mockDb, "secret", noteEvent("#card X"));

    expect(result.status).toBe(500);
  });
});
