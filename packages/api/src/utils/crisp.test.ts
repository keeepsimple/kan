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

vi.mock("@kan/db/repository/list.repo", () => ({
  getFirstListByBoardSlug: vi.fn(),
  getWorkspaceAndListIdByListPublicId: vi.fn(),
}));

vi.mock("./discord", () => ({
  notifyCardCreated: vi.fn(() => Promise.resolve()),
}));

vi.mock("../events/boardEvents", () => ({
  emitFromList: vi.fn(),
}));

import * as cardRepo from "@kan/db/repository/card.repo";
import * as crispIntegrationRepo from "@kan/db/repository/crispIntegration.repo";
import * as listRepo from "@kan/db/repository/list.repo";

import { emitFromList } from "../events/boardEvents";
import { notifyCardCreated } from "./discord";
import {
  buildCardDescription,
  handleCrispWebhook,
  parseCardCommand,
} from "./crisp";

const mockGetActiveBySecret =
  crispIntegrationRepo.getActiveBySecret as ReturnType<typeof vi.fn>;
const mockCardCreate = cardRepo.create as ReturnType<typeof vi.fn>;
const mockGetFirstListByBoardSlug =
  listRepo.getFirstListByBoardSlug as ReturnType<typeof vi.fn>;
const mockGetListByPublicId =
  listRepo.getWorkspaceAndListIdByListPublicId as ReturnType<typeof vi.fn>;
const mockNotifyCardCreated = notifyCardCreated as ReturnType<typeof vi.fn>;
const mockEmitFromList = emitFromList as ReturnType<typeof vi.fn>;

describe("parseCardCommand", () => {
  it("returns null when content does not start with the prefix", () => {
    expect(parseCardCommand("hello world")).toBeNull();
    expect(parseCardCommand("please !create-sp do thing")).toBeNull();
  });

  it("no longer accepts the old #card prefix", () => {
    expect(parseCardCommand("#card Fix login bug")).toBeNull();
  });

  it("returns null for a bare prefix with no title", () => {
    expect(parseCardCommand("!create-sp")).toBeNull();
    expect(parseCardCommand("!create-sp    ")).toBeNull();
  });

  it("extracts a single-line title with empty body and no slug", () => {
    expect(parseCardCommand("!create-sp Fix login bug")).toEqual({
      boardSlug: null,
      title: "Fix login bug",
      rawTitle: "Fix login bug",
      body: "",
    });
  });

  it("trims surrounding whitespace before matching the prefix", () => {
    expect(parseCardCommand("  !create-sp Fix login bug  ")).toEqual({
      boardSlug: null,
      title: "Fix login bug",
      rawTitle: "Fix login bug",
      body: "",
    });
  });

  it("uses the first line as title and the rest as body", () => {
    expect(
      parseCardCommand(
        "!create-sp Fix login bug\nUser cannot sign in\nwith SSO",
      ),
    ).toEqual({
      boardSlug: null,
      title: "Fix login bug",
      rawTitle: "Fix login bug",
      body: "User cannot sign in\nwith SSO",
    });
  });

  it("extracts a board slug from the first token", () => {
    expect(parseCardCommand("!create-sp #support Fix login bug\nbody")).toEqual({
      boardSlug: "support",
      title: "Fix login bug",
      rawTitle: "#support Fix login bug",
      body: "body",
    });
  });

  it("lowercases the slug and accepts hyphens and digits", () => {
    expect(parseCardCommand("!create-sp #Bug-Tracker-2 Crash")).toEqual({
      boardSlug: "bug-tracker-2",
      title: "Crash",
      rawTitle: "#Bug-Tracker-2 Crash",
      body: "",
    });
  });

  it("preserves internal spacing of the title after a slug", () => {
    expect(parseCardCommand("!create-sp #support Fix   login  bug")).toEqual({
      boardSlug: "support",
      title: "Fix   login  bug",
      rawTitle: "#support Fix   login  bug",
      body: "",
    });
  });

  it("returns null for a slug with no title after it", () => {
    expect(parseCardCommand("!create-sp #support")).toBeNull();
    expect(parseCardCommand("!create-sp #support   ")).toBeNull();
  });

  it("keeps a non-slug-shaped # token as part of the title", () => {
    expect(parseCardCommand("!create-sp #lỗi nặng ở checkout")).toEqual({
      boardSlug: null,
      title: "#lỗi nặng ở checkout",
      rawTitle: "#lỗi nặng ở checkout",
      body: "",
    });
  });

  it("caps the title at 2000 characters", () => {
    const long = "a".repeat(2500);
    const parsed = parseCardCommand(`!create-sp ${long}`);
    expect(parsed?.title).toHaveLength(2000);
    expect(parsed?.rawTitle).toHaveLength(2000);
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
    mockGetListByPublicId.mockResolvedValue({
      id: 42,
      publicId: "list-abc12345",
      name: "Inbox",
      createdBy: "user-123",
      workspaceId: 7,
      boardPublicId: "board-abc123",
      boardName: "Support",
      discordBehaviour: null,
      discordRoleIds: null,
      boardDiscordChannelId: null,
    });
  });

  it("returns 404 for an unknown token", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(null);

    const result = await handleCrispWebhook(mockDb, "bad-token", noteEvent("!create-sp X"));

    expect(result.status).toBe(404);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores non-note messages with 200", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const event = noteEvent("!create-sp X");
    event.data.type = "text";

    const result = await handleCrispWebhook(mockDb, "secret", event);

    expect(result.status).toBe(200);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores notes not sent by an operator with 200", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const event = noteEvent("!create-sp X");
    event.data.from = "user";

    const result = await handleCrispWebhook(mockDb, "secret", event);

    expect(result.status).toBe(200);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores notes from a different crisp website with 200", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const event = noteEvent("!create-sp X");
    event.data.website_id = "other-site";

    const result = await handleCrispWebhook(mockDb, "secret", event);

    expect(result.status).toBe(200);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores notes without the command prefix with 200", async () => {
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

  it("creates a card from a valid !create-sp note", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const result = await handleCrispWebhook(
      mockDb,
      "secret",
      noteEvent("!create-sp Fix login bug\nUser cannot sign in"),
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

    const result = await handleCrispWebhook(mockDb, "secret", noteEvent("!create-sp X"));

    expect(result.status).toBe(500);
  });
});

describe("handleCrispWebhook target resolution", () => {
  const DEFAULT_LIST = {
    id: 10,
    publicId: "list_default",
    name: "Inbox",
    createdBy: "user-1",
    workspaceId: 1,
    boardPublicId: "board_default",
    boardName: "Default Board",
    discordBehaviour: null,
    discordRoleIds: null,
    boardDiscordChannelId: null,
  };

  const SLUG_LIST = {
    id: 20,
    publicId: "list_support",
    name: "Triage",
    createdBy: "user-1",
    workspaceId: 1,
    boardPublicId: "board_support",
    boardName: "Support",
    discordBehaviour: "create_thread",
    discordRoleIds: '["123"]',
    boardDiscordChannelId: "999",
  };

  const noteBody = (content: string) => ({
    event: "message:received",
    data: {
      website_id: "site-1",
      session_id: "session-1",
      type: "note",
      from: "operator",
      content,
      user: { nickname: "Alice" },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveBySecret.mockResolvedValue({
      id: 1,
      workspaceId: 1,
      crispWebsiteId: "site-1",
      listId: 10,
      createdBy: "user-1",
      list: {
        publicId: "list_default",
        name: "Inbox",
        deletedAt: null,
        board: { publicId: "board_default", name: "Default Board" },
      },
    });
    mockGetListByPublicId.mockResolvedValue(DEFAULT_LIST);
    mockGetFirstListByBoardSlug.mockResolvedValue(SLUG_LIST);
    mockCardCreate.mockResolvedValue({ id: 77, publicId: "card_abc" });
  });

  it("creates the card in the slug board's first list", async () => {
    const result = await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp #support Payment fails"),
    );

    expect(result).toEqual({ status: 200, message: "Card created" });
    expect(mockGetFirstListByBoardSlug).toHaveBeenCalledWith({}, {
      boardSlug: "support",
      workspaceId: 1,
    });
    expect(mockCardCreate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ listId: 20, title: "Payment fails" }),
    );
  });

  it("falls back to the default list and keeps the #slug in the title", async () => {
    mockGetFirstListByBoardSlug.mockResolvedValue(null);

    await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp #nope Payment fails"),
    );

    expect(mockCardCreate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ listId: 10, title: "#nope Payment fails" }),
    );
  });

  it("uses the default list when no slug is given", async () => {
    await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp Payment fails"),
    );

    expect(mockGetFirstListByBoardSlug).not.toHaveBeenCalled();
    expect(mockCardCreate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ listId: 10, title: "Payment fails" }),
    );
  });

  it("ignores the note when the default list is soft-deleted", async () => {
    mockGetListByPublicId.mockResolvedValue(null);

    const result = await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp Payment fails"),
    );

    expect(result).toEqual({ status: 200, message: "Ignored" });
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("refuses to create a card in a Discord notify list", async () => {
    mockGetFirstListByBoardSlug.mockResolvedValue({
      ...SLUG_LIST,
      discordBehaviour: "notify",
    });

    const result = await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp #support Payment fails"),
    );

    expect(result).toEqual({ status: 200, message: "Ignored" });
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("notifies Discord with the resolved list's config and the operator name", async () => {
    await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp #support Payment fails"),
    );

    expect(mockNotifyCardCreated).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        cardId: 77,
        cardPublicId: "card_abc",
        cardTitle: "Payment fails",
        boardName: "Support",
        workspaceId: 1,
        discordChannelId: "999",
        discordBehaviour: "create_thread",
        discordRoleIds: '["123"]',
        listName: "Triage",
        createdBy: "Alice",
      }),
    );
  });

  it("emits an SSE event for the resolved list with a null actor", async () => {
    await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp #support Payment fails"),
    );

    expect(mockEmitFromList).toHaveBeenCalledWith({}, "list_support", null);
  });
});
