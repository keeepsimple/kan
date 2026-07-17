import { describe, expect, it, vi } from "vitest";

import { emitBoardEvent, subscribeToBoard } from "./boardEvents";

describe("boardEvents bus", () => {
  it("delivers events to subscribers of the same board", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);

    emitBoardEvent({ boardPublicId: "board_aaaaaaaa", cardPublicId: "card_11111111" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      boardPublicId: "board_aaaaaaaa",
      cardPublicId: "card_11111111",
    });
    unsubscribe();
  });

  it("does not deliver events for other boards", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);

    emitBoardEvent({ boardPublicId: "board_bbbbbbbb" });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);
    unsubscribe();

    emitBoardEvent({ boardPublicId: "board_aaaaaaaa" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers on one board", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeToBoard("board_aaaaaaaa", a);
    const unsubB = subscribeToBoard("board_aaaaaaaa", b);

    emitBoardEvent({ boardPublicId: "board_aaaaaaaa" });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });
});
