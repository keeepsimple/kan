import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardNotifierDeps } from "./boardNotifier";
import { createBoardNotifier, THROTTLE_MS } from "./boardNotifier";

function setup(overrides: Partial<BoardNotifierDeps> = {}) {
  const state = { time: 0, hidden: true, enabled: true };
  const deps = {
    now: () => state.time,
    isHidden: () => state.hidden,
    isEnabled: () => state.enabled,
    permission: () => "granted" as const,
    playSound: vi.fn(),
    showDesktop: vi.fn(),
    onUnreadChange: vi.fn(),
    ...overrides,
  };
  return { state, deps, notifier: createBoardNotifier(deps) };
}

const EVENT = {
  boardPublicId: "board_aaaaaaaa",
  boardName: "Support",
  body: "This board has new changes",
};

describe("createBoardNotifier", () => {
  beforeEach(() => vi.clearAllMocks());

  it("plays a sound, counts unread, and shows a desktop notification", () => {
    const { deps, notifier } = setup();

    notifier.notify(EVENT);

    expect(deps.playSound).toHaveBeenCalledTimes(1);
    expect(deps.onUnreadChange).toHaveBeenCalledWith(1);
    expect(deps.showDesktop).toHaveBeenCalledWith({
      title: "Support",
      body: "This board has new changes",
      tag: "kan-board-board_aaaaaaaa",
    });
  });

  it("does nothing at all when disabled", () => {
    const { state, deps, notifier } = setup();
    state.enabled = false;

    notifier.notify(EVENT);

    expect(deps.playSound).not.toHaveBeenCalled();
    expect(deps.showDesktop).not.toHaveBeenCalled();
    expect(deps.onUnreadChange).not.toHaveBeenCalled();
  });

  it("throttles a second notification inside the window", () => {
    const { state, deps, notifier } = setup();

    notifier.notify(EVENT);
    state.time += THROTTLE_MS - 1;
    notifier.notify(EVENT);

    expect(deps.playSound).toHaveBeenCalledTimes(1);
  });

  it("notifies again once the throttle window has passed", () => {
    const { state, deps, notifier } = setup();

    notifier.notify(EVENT);
    state.time += THROTTLE_MS;
    notifier.notify(EVENT);

    expect(deps.playSound).toHaveBeenCalledTimes(2);
    expect(deps.onUnreadChange).toHaveBeenLastCalledWith(2);
  });

  it("plays sound but does not count unread while the tab is visible", () => {
    const { state, deps, notifier } = setup();
    state.hidden = false;

    notifier.notify(EVENT);

    expect(deps.playSound).toHaveBeenCalledTimes(1);
    expect(deps.onUnreadChange).not.toHaveBeenCalled();
    expect(deps.showDesktop).not.toHaveBeenCalled();
  });

  it("still plays sound and counts unread when permission is denied", () => {
    const { deps, notifier } = setup({ permission: () => "denied" as const });

    notifier.notify(EVENT);

    expect(deps.playSound).toHaveBeenCalledTimes(1);
    expect(deps.onUnreadChange).toHaveBeenCalledWith(1);
    expect(deps.showDesktop).not.toHaveBeenCalled();
  });

  it("skips the desktop notification when Notification is unsupported", () => {
    const { deps, notifier } = setup({
      permission: () => "unsupported" as const,
    });

    notifier.notify(EVENT);

    expect(deps.showDesktop).not.toHaveBeenCalled();
  });

  it("reset clears the unread count", () => {
    const { deps, notifier } = setup();

    notifier.notify(EVENT);
    notifier.reset();

    expect(deps.onUnreadChange).toHaveBeenLastCalledWith(0);
  });

  it("reset does not fire onUnreadChange when already zero", () => {
    const { deps, notifier } = setup();

    notifier.reset();

    expect(deps.onUnreadChange).not.toHaveBeenCalled();
  });
});
