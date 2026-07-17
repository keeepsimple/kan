import { beforeEach, describe, expect, it, vi } from "vitest";

import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as labelRepo from "@kan/db/repository/label.repo";
import * as listRepo from "@kan/db/repository/list.repo";

import {
  emitFromCard,
  emitFromLabel,
  emitFromList,
  subscribeToBoard,
} from "./boardEvents";

vi.mock("@kan/db/repository/card.repo", () => ({
  getBoardPublicIdByCardPublicId: vi.fn(),
}));
vi.mock("@kan/db/repository/list.repo", () => ({
  getBoardPublicIdByListPublicId: vi.fn(),
}));
vi.mock("@kan/db/repository/label.repo", () => ({
  getBoardPublicIdByLabelPublicId: vi.fn(),
}));

const db = {} as dbClient;
const mockByCard = cardRepo.getBoardPublicIdByCardPublicId as ReturnType<
  typeof vi.fn
>;
const mockByList = listRepo.getBoardPublicIdByListPublicId as ReturnType<
  typeof vi.fn
>;
const mockByLabel = labelRepo.getBoardPublicIdByLabelPublicId as ReturnType<
  typeof vi.fn
>;

// emit helpers are fire-and-forget; flush their internal promise chain
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("emit helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emitFromCard resolves the board and emits with cardPublicId", async () => {
    mockByCard.mockResolvedValue("board_aaaaaaaa");
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);

    emitFromCard(db, "card_11111111");
    await flush();

    expect(mockByCard).toHaveBeenCalledWith(db, "card_11111111");
    expect(listener).toHaveBeenCalledWith({
      boardPublicId: "board_aaaaaaaa",
      cardPublicId: "card_11111111",
    });
    unsubscribe();
  });

  it("emitFromList emits without cardPublicId", async () => {
    mockByList.mockResolvedValue("board_aaaaaaaa");
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);

    emitFromList(db, "list_22222222");
    await flush();

    expect(listener).toHaveBeenCalledWith({ boardPublicId: "board_aaaaaaaa" });
    unsubscribe();
  });

  it("emitFromLabel emits without cardPublicId", async () => {
    mockByLabel.mockResolvedValue("board_aaaaaaaa");
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);

    emitFromLabel(db, "label_33333333");
    await flush();

    expect(listener).toHaveBeenCalledWith({ boardPublicId: "board_aaaaaaaa" });
    unsubscribe();
  });

  it("does not emit when the entity is not found", async () => {
    mockByCard.mockResolvedValue(undefined);
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);

    emitFromCard(db, "card_missing1");
    await flush();

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("swallows repo errors (never throws into the mutation)", async () => {
    mockByCard.mockRejectedValue(new Error("db down"));

    expect(() => emitFromCard(db, "card_11111111")).not.toThrow();
    await flush(); // would surface an unhandled rejection if not caught
  });
});
