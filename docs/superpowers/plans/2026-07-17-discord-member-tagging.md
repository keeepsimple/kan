# Discord Member Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Kan @mention the real Discord user behind a workspace member so Discord notifications ping the right person — on card assignment, on @mention in a comment, and in due reminders.

**Architecture:** Store one Discord snowflake per Kan `user` (`discordUserId`), populated automatically when a user logs in with Discord (Better Auth `account` hook) or manually in Settings (pick-from-server / paste-ID). Extend `@kan/discord` to emit user mentions. At three mutation/cron hook points, resolve the affected members → their `discordUserId` → post a short ping **into the card's existing Discord thread** (so no links are needed). Every Discord/tag call is fire-and-forget.

**Tech Stack:** Drizzle/Postgres, tRPC v11, Better Auth, existing `@kan/discord` bot-token REST client, Next.js pages router, Vitest. **No new npm dependencies.**

Spec: `docs/superpowers/specs/2026-07-17-discord-member-tagging-design.md`

## Global Constraints

- **No new npm dependencies** anywhere. Reuse `@kan/discord`'s existing `discordFetch` pattern and the existing tRPC/Drizzle/Better Auth stack.
- **All DB access goes through `packages/db/src/repository/*.repo.ts`** functions — routers/hooks/cron never touch Drizzle directly.
- **Every Discord/tag call is fire-and-forget**: a Discord failure or a missing mapping must NEVER throw into, fail, or slow the originating mutation, the auth flow, or the cron batch. Wrap in `try/catch` (helper internals) or `.catch(...)` (call sites), matching the existing `notifyCardUpdated(...).catch(...)` pattern in `card.ts`.
- **A tag only pings if the member is in the guild the message posts into.** We store the per-user snowflake and skip any member without a `discordUserId` silently. No opt-out toggle (not linking is the opt-out).
- **All pings post into the card's own thread** (`card.discordThreadId`); if a card has no thread, skip. No URLs in ping text.
- **publicId vs id**: never expose numeric `id`; API inputs/outputs use 12-char `publicId`.
- **Discord `allowed_mentions`** must list exactly the ids to ping (`{ parse: [], roles: [...], users: [...] }`) — never `parse: ["users"]` (would allow stray/@everyone pings).
- **Match each router's local convention**: `discordRouter` procedures use NO `.meta({ openapi })` and are workspace-scoped via `getAuthorizedWorkspace`; `userRouter` procedures DO use `.meta({ openapi })` and are self-scoped via `ctx.user.id`.
- **Conventional commits** (`feat:`, `test:`, `chore:`). Every commit message ends with the trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Work happens on branch `feat/discord-member-tagging` (already created; spec committed there as `570b11c`).
- Tests: Vitest. Run a single file with `pnpm --filter @kan/<pkg> exec vitest run <path>` from repo root. Postgres (Docker `kan-analytics-pg`) must be running for `db:migrate` and integration tests.
- Only `git add` the files each task names — never `git add -A` (the tree may hold unrelated scratch under `.superpowers/`).

---

## Phase 1 — Mapping infrastructure

### Task 1: Schema columns + migration + env passthrough

**Files:**
- Modify: `packages/db/src/schema/users.ts` (add 2 columns to the `user` table)
- Create: `packages/db/migrations/<timestamp>_discord_user_mapping.sql` (generated)
- Modify: `packages/db/migrations/meta/*` (generated snapshot — commit as-is)
- Modify: `turbo.json` (add the two bot env vars to `globalEnv`)

**Interfaces:**
- Produces (used by Tasks 3, 4, 5): `users.discordUserId` (`varchar(32)`, nullable) and `users.discordUsername` (`varchar(64)`, nullable) columns on the `user` table.

- [ ] **Step 1: Add the columns**

In `packages/db/src/schema/users.ts`, inside `export const users = pgTable("user", { ... })`, add the two columns immediately after `stripeCustomerId` (currently the last column, ~line 29), matching the existing `varchar` style used for `card.discordThreadId`:

```ts
  stripeCustomerId: varchar("stripeCustomerId", { length: 255 }),
  discordUserId: varchar("discordUserId", { length: 32 }),
  discordUsername: varchar("discordUsername", { length: 64 }),
}).enableRLS();
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @kan/db exec drizzle-kit generate --name discord_user_mapping`
Expected: a new file `packages/db/migrations/<timestamp>_discord_user_mapping.sql` containing:

```sql
ALTER TABLE "user" ADD COLUMN "discordUserId" varchar(32);--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "discordUsername" varchar(64);
```

Open the generated `.sql` and confirm it contains ONLY those two `ADD COLUMN` statements (no unrelated diffs). If it contains unrelated changes, stop and report — the schema drifted.

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:migrate`
Expected: applies cleanly. Verify the columns exist:
`docker exec -i kan-analytics-pg psql -U postgres -d kan -c '\d "user"' | grep discord`
Expected: two rows, `discordUserId | character varying(32)` and `discordUsername | character varying(64)`.

- [ ] **Step 4: Add the bot env vars to turbo globalEnv**

`packages/discord/src/index.ts` reads `DISCORD_BOT_TOKEN` and `DISCORD_BOT_CLIENT_ID`, but `turbo.json` `globalEnv` currently lists neither (pre-existing gap; this feature now depends on the bot at runtime for member search). In `turbo.json`, inside the `globalEnv` array, next to the existing `"DISCORD_CLIENT_ID"` / `"DISCORD_CLIENT_SECRET"` entries, add:

```json
      "DISCORD_BOT_TOKEN",
      "DISCORD_BOT_CLIENT_ID",
```

(Keep valid JSON — comma-separated array entries.)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @kan/db typecheck`
Expected: clean (exit 0).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/users.ts packages/db/migrations/ turbo.json
git commit -m "feat(db): add discordUserId/discordUsername to user

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `@kan/discord` user-mention helpers

**Files:**
- Modify: `packages/discord/src/index.ts`
- Modify: `packages/discord/src/index.test.ts`

**Interfaces:**
- Consumes: nothing new (uses the existing `discordFetch`).
- Produces (used by Tasks 4, 5, 7, 8, 9):
  - `buildUserMentions(userIds: string[]): string` → space-joined `<@id>`.
  - `postMessage(channelOrThreadId, content, mentionRoleIds?, embeds?, mentionUserIds?: string[])` — new 5th param; adds `users: mentionUserIds` to `allowed_mentions`.
  - `searchGuildMembers(guildId: string, query: string): Promise<DiscordResult<{ id: string; username: string; displayName: string }[]>>`.
  - `getUser(userId: string): Promise<DiscordResult<{ id: string; username: string; displayName: string }>>`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/discord/src/index.test.ts` (import the new symbols in the existing top import block: add `buildUserMentions`, `searchGuildMembers`, `getUser`):

```ts
describe("buildUserMentions", () => {
  it("formats user ids as <@id> joined by spaces", () => {
    expect(buildUserMentions(["111", "222"])).toBe("<@111> <@222>");
  });
  it("returns empty string for no ids", () => {
    expect(buildUserMentions([])).toBe("");
  });
});

describe("postMessage user mentions", () => {
  it("adds mentionUserIds to allowed_mentions.users", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "m1" }));
    await postMessage("chan1", "<@111> hi", [], [], ["111"]);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.allowed_mentions).toEqual({ parse: [], roles: [], users: ["111"] });
  });
  it("defaults users to [] when omitted", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "m1" }));
    await postMessage("chan1", "hi");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.allowed_mentions).toEqual({ parse: [], roles: [], users: [] });
  });
});

describe("searchGuildMembers", () => {
  it("calls the search endpoint and maps results", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        { user: { id: "111", username: "alice", global_name: "Alice A" }, nick: null },
        { user: { id: "222", username: "bob", global_name: null }, nick: "Bobby" },
      ]),
    );
    const res = await searchGuildMembers("guild1", "a");
    expect(mockFetch.mock.calls[0][0]).toContain("/guilds/guild1/members/search?query=a");
    expect(res.success).toBe(true);
    expect(res.data).toEqual([
      { id: "111", username: "alice", displayName: "Alice A" },
      { id: "222", username: "bob", displayName: "Bobby" },
    ]);
  });
});

describe("getUser", () => {
  it("fetches a user by id and maps the handle", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ id: "111", username: "alice", global_name: "Alice A" }),
    );
    const res = await getUser("111");
    expect(mockFetch.mock.calls[0][0]).toContain("/users/111");
    expect(res.data).toEqual({ id: "111", username: "alice", displayName: "Alice A" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kan/discord exec vitest run src/index.test.ts`
Expected: FAIL — `buildUserMentions`/`searchGuildMembers`/`getUser` not exported; `postMessage` body has no `users` key.

- [ ] **Step 3: Implement**

In `packages/discord/src/index.ts`:

(a) Update `postMessage` to add the `mentionUserIds` param and `users` key:

```ts
export const postMessage = (
  channelOrThreadId: string,
  content: string,
  mentionRoleIds: string[] = [],
  embeds: DiscordEmbed[] = [],
  mentionUserIds: string[] = [],
) =>
  discordFetch<DiscordMessage>(`/channels/${channelOrThreadId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [], roles: mentionRoleIds, users: mentionUserIds },
      ...(embeds.length ? { embeds } : {}),
    }),
  });
```

(b) Add `buildUserMentions` next to `buildRoleMentions`:

```ts
export const buildUserMentions = (userIds: string[]) =>
  userIds.map((id) => `<@${id}>`).join(" ");
```

(c) Add the two REST helpers (near `getRoles`). Note the raw Discord shapes and the mapping to Kan's clean shape:

```ts
interface DiscordGuildMember {
  user: { id: string; username: string; global_name: string | null };
  nick: string | null;
}

export const searchGuildMembers = async (
  guildId: string,
  query: string,
): Promise<DiscordResult<{ id: string; username: string; displayName: string }[]>> => {
  const res = await discordFetch<DiscordGuildMember[]>(
    `/guilds/${guildId}/members/search?query=${encodeURIComponent(query)}&limit=25`,
  );
  if (!res.success || !res.data) return { success: false, error: res.error };
  return {
    success: true,
    data: res.data.map((m) => ({
      id: m.user.id,
      username: m.user.username,
      displayName: m.nick ?? m.user.global_name ?? m.user.username,
    })),
  };
};

export const getUser = async (
  userId: string,
): Promise<DiscordResult<{ id: string; username: string; displayName: string }>> => {
  const res = await discordFetch<{ id: string; username: string; global_name: string | null }>(
    `/users/${userId}`,
  );
  if (!res.success || !res.data) return { success: false, error: res.error };
  return {
    success: true,
    data: {
      id: res.data.id,
      username: res.data.username,
      displayName: res.data.global_name ?? res.data.username,
    },
  };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @kan/discord exec vitest run src/index.test.ts`
Expected: PASS (all prior tests + the 6 new ones). Confirm output is pristine.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @kan/discord typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/discord/src/index.ts packages/discord/src/index.test.ts
git commit -m "feat(discord): user-mention helpers, member search, getUser

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Repository layer for the Discord mapping

**Files:**
- Modify: `packages/db/src/repository/user.repo.ts` (add set/clear + include new fields where the user is read for the account UI)
- Modify: `packages/db/src/repository/member.repo.ts` (add `discordUserId` to the user selection in `getByPublicIdsWithUsers`)
- Create: `packages/db/src/repository/user-discord.integration.test.ts`

**Interfaces:**
- Consumes: `users.discordUserId`/`discordUsername` (Task 1); `dbClient`.
- Produces (used by Tasks 4, 5, 7, 8):
  - `userRepo.setDiscordMapping(db, userId: string, mapping: { discordUserId: string; discordUsername: string | null }): Promise<void>`
  - `userRepo.clearDiscordMapping(db, userId: string): Promise<void>`
  - `memberRepo.getByPublicIdsWithUsers(...)` — each returned member's `.user` now also carries `discordUserId`.

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/src/repository/user-discord.integration.test.ts` (seeds a user row directly — the `user` table has no outbound FK requirement for insert):

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDrizzleClient } from "../client";
import { users } from "../schema/users";
import { eq } from "drizzle-orm";
import { setDiscordMapping, clearDiscordMapping } from "./user.repo";

const db = createDrizzleClient();
const email = `discordtest_${Date.now()}@example.com`;
let userId: string;

beforeAll(async () => {
  const [row] = await db
    .insert(users)
    .values({ email, emailVerified: false })
    .returning({ id: users.id });
  userId = row!.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("user discord mapping repo", () => {
  it("setDiscordMapping writes both columns", async () => {
    await setDiscordMapping(db, userId, { discordUserId: "123456789", discordUsername: "alice" });
    const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(row?.discordUserId).toBe("123456789");
    expect(row?.discordUsername).toBe("alice");
  });

  it("clearDiscordMapping nulls both columns", async () => {
    await clearDiscordMapping(db, userId);
    const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(row?.discordUserId).toBeNull();
    expect(row?.discordUsername).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kan/db exec vitest run src/repository/user-discord.integration.test.ts`
Expected: FAIL — `setDiscordMapping`/`clearDiscordMapping` not exported.

- [ ] **Step 3: Add the repo functions**

Append to `packages/db/src/repository/user.repo.ts` (reuse the file's existing `dbClient`, `users`, `eq` imports; add any missing to the existing import lines):

```ts
export const setDiscordMapping = async (
  db: dbClient,
  userId: string,
  mapping: { discordUserId: string; discordUsername: string | null },
): Promise<void> => {
  await db
    .update(users)
    .set({
      discordUserId: mapping.discordUserId,
      discordUsername: mapping.discordUsername,
    })
    .where(eq(users.id, userId));
};

export const clearDiscordMapping = async (
  db: dbClient,
  userId: string,
): Promise<void> => {
  await db
    .update(users)
    .set({ discordUserId: null, discordUsername: null })
    .where(eq(users.id, userId));
};
```

- [ ] **Step 4: Add `discordUserId` to the member mention selection**

In `packages/db/src/repository/member.repo.ts`, in `getByPublicIdsWithUsers`, extend the `user` columns selection:

```ts
    with: {
      user: {
        columns: { id: true, name: true, email: true, discordUserId: true },
      },
    },
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter @kan/db exec vitest run src/repository/user-discord.integration.test.ts`
Expected: PASS (2 tests).
Run: `pnpm --filter @kan/db typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repository/user.repo.ts packages/db/src/repository/member.repo.ts packages/db/src/repository/user-discord.integration.test.ts
git commit -m "feat(db): repo helpers for user discord mapping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Auto-link via Better Auth `account` hook

**Files:**
- Modify: `packages/auth/src/hooks.ts` (add an `account` hook to `createDatabaseHooks`)
- Create: `packages/auth/src/discord-account-hook.test.ts`

**Interfaces:**
- Consumes: `userRepo.setDiscordMapping` (Task 3); `discordClient.getUser` (Task 2).
- Produces: on a Discord `account` create, `user.discordUserId` is set from `account.accountId`; `discordUsername` best-effort from the bot.

- [ ] **Step 1: Write the failing test**

Create `packages/auth/src/discord-account-hook.test.ts`. It extracts the hook logic into a testable unit; mock the repo + discord client:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/repository/user.repo", () => ({ setDiscordMapping: vi.fn() }));
vi.mock("@kan/discord", () => ({ getUser: vi.fn() }));

import type { dbClient } from "@kan/db/client";
import * as userRepo from "@kan/db/repository/user.repo";
import { getUser } from "@kan/discord";

import { handleDiscordAccountLink } from "./hooks";

const db = {} as dbClient;
const mockSet = userRepo.setDiscordMapping as ReturnType<typeof vi.fn>;
const mockGetUser = getUser as ReturnType<typeof vi.fn>;

describe("handleDiscordAccountLink", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps a discord account to the user with a resolved username", async () => {
    mockGetUser.mockResolvedValue({ success: true, data: { id: "snow1", username: "alice", displayName: "Alice" } });
    await handleDiscordAccountLink(db, { providerId: "discord", accountId: "snow1", userId: "user1" });
    expect(mockSet).toHaveBeenCalledWith(db, "user1", { discordUserId: "snow1", discordUsername: "alice" });
  });

  it("ignores non-discord providers", async () => {
    await handleDiscordAccountLink(db, { providerId: "google", accountId: "g1", userId: "user1" });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("still maps with null username when the bot lookup fails", async () => {
    mockGetUser.mockResolvedValue({ success: false, error: "no token" });
    await handleDiscordAccountLink(db, { providerId: "discord", accountId: "snow1", userId: "user1" });
    expect(mockSet).toHaveBeenCalledWith(db, "user1", { discordUserId: "snow1", discordUsername: null });
  });

  it("never throws when the repo write fails", async () => {
    mockGetUser.mockResolvedValue({ success: true, data: { id: "snow1", username: "alice", displayName: "Alice" } });
    mockSet.mockRejectedValue(new Error("db down"));
    await expect(handleDiscordAccountLink(db, { providerId: "discord", accountId: "snow1", userId: "user1" })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kan/auth exec vitest run src/discord-account-hook.test.ts`
Expected: FAIL — `handleDiscordAccountLink` not exported. (If `@kan/auth` has no `test` script/vitest config, add one mirroring `@kan/discord`'s `"test": "vitest run"` and a minimal `vitest.config.ts`; commit that as part of this task.)

- [ ] **Step 3: Implement the hook helper + wire it**

In `packages/auth/src/hooks.ts`, add the exported helper (imports at top: `import * as userRepo from "@kan/db/repository/user.repo";` and `import { getUser } from "@kan/discord";`):

```ts
export async function handleDiscordAccountLink(
  db: dbClient,
  account: { providerId: string; accountId: string; userId: string },
): Promise<void> {
  if (account.providerId !== "discord") return;
  try {
    const info = await getUser(account.accountId);
    await userRepo.setDiscordMapping(db, account.userId, {
      discordUserId: account.accountId,
      discordUsername: info.success && info.data ? info.data.username : null,
    });
  } catch (error) {
    console.error("Discord account link failed:", error);
  }
}
```

Then register the `account` hook inside the object returned by `createDatabaseHooks(db)`, as a sibling of the existing `user` key:

```ts
    account: {
      create: {
        async after(account: { providerId: string; accountId: string; userId: string }, _context: unknown) {
          await handleDiscordAccountLink(db, account);
        },
      },
    },
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @kan/auth exec vitest run src/discord-account-hook.test.ts`
Expected: PASS (4 tests).
Run: `pnpm --filter @kan/auth typecheck`
Expected: no NEW errors vs the package baseline (check pre-existing errors reference files you did not touch).

- [ ] **Step 5: Commit**

```bash
git add packages/auth/src/hooks.ts packages/auth/src/discord-account-hook.test.ts
# also add packages/auth/vitest.config.ts + package.json if you added a test script
git commit -m "feat(auth): auto-link discord account id to user on login

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: tRPC procedures (link/unlink + member search)

**Files:**
- Modify: `packages/api/src/routers/user.ts` (add `linkDiscord`, `unlinkDiscord`; ensure `getUser` returns the new fields)
- Modify: `packages/api/src/routers/discord.ts` (add `searchWorkspaceDiscordMembers`)
- Create: `packages/api/src/routers/user-discord.test.ts`

**Interfaces:**
- Consumes: `userRepo.setDiscordMapping`/`clearDiscordMapping` (Task 3); `discordClient.getUser`/`searchGuildMembers` (Task 2); `discordRepo.getByWorkspaceId` + `getAuthorizedWorkspace` (existing in `discord.ts`).
- Produces (used by Task 6): `api.user.linkDiscord`, `api.user.unlinkDiscord`, `api.user.getUser` (now includes `discordUserId`/`discordUsername`), `api.discord.searchWorkspaceDiscordMembers`.

- [ ] **Step 1: Write the failing tests**

Create `packages/api/src/routers/user-discord.test.ts`. Mock the repos + discord client; build a minimal caller with `ctx.user.id`. Match the mocking/caller style already used in `packages/api/src/routers/*.test.ts` (e.g. `card-completion.test.ts`). Cover: link resolves the username and writes for the CURRENT user only; link with an explicit id skips the guild and validates; unlink clears; search is permission-gated.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/repository/user.repo", () => ({
  setDiscordMapping: vi.fn(),
  clearDiscordMapping: vi.fn(),
  getById: vi.fn(),
}));
vi.mock("@kan/discord", () => ({ getUser: vi.fn(), searchGuildMembers: vi.fn() }));

import * as userRepo from "@kan/db/repository/user.repo";
import { getUser } from "@kan/discord";
import { createCaller } from "../root"; // or the project's test-caller helper; mirror an existing router test's setup
// NOTE: follow the EXACT caller/context construction used by card-completion.test.ts — build ctx with { db, user: { id } }.

const mockSet = userRepo.setDiscordMapping as ReturnType<typeof vi.fn>;
const mockGetUser = getUser as ReturnType<typeof vi.fn>;

// ...construct `caller` for user "user1" per the existing test harness...

describe("user.linkDiscord", () => {
  beforeEach(() => vi.clearAllMocks());

  it("links a pasted discord id to the calling user and resolves the handle", async () => {
    mockGetUser.mockResolvedValue({ success: true, data: { id: "123456789012", username: "alice", displayName: "Alice" } });
    await caller.user.linkDiscord({ discordUserId: "123456789012" });
    expect(mockSet).toHaveBeenCalledWith(expect.anything(), "user1", { discordUserId: "123456789012", discordUsername: "alice" });
  });

  it("rejects a non-numeric discord id", async () => {
    await expect(caller.user.linkDiscord({ discordUserId: "not-a-snowflake" })).rejects.toThrow();
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe("user.unlinkDiscord", () => {
  it("clears the calling user's mapping", async () => {
    await caller.user.unlinkDiscord();
    expect(userRepo.clearDiscordMapping).toHaveBeenCalledWith(expect.anything(), "user1");
  });
});
```

(If the repo `user.repo` has no `getById`, drop that mock line — it is only listed to keep the factory complete if the router imports it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kan/api exec vitest run src/routers/user-discord.test.ts`
Expected: FAIL — `linkDiscord`/`unlinkDiscord` not defined.

- [ ] **Step 3: Add `linkDiscord`/`unlinkDiscord` to `userRouter`**

In `packages/api/src/routers/user.ts` (self-scoped; `protectedProcedure` exposes `ctx.user`). Add:

```ts
  linkDiscord: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/user/discord/link",
        summary: "Link a Discord account to the current user",
        tags: ["User"],
        protect: true,
      },
    })
    .input(z.object({ discordUserId: z.string().regex(/^\d{15,20}$/) }))
    .output(z.object({ discordUserId: z.string(), discordUsername: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const info = await discordClient.getUser(input.discordUserId);
      const discordUsername = info.success && info.data ? info.data.username : null;
      await userRepo.setDiscordMapping(ctx.db, ctx.user.id, {
        discordUserId: input.discordUserId,
        discordUsername,
      });
      return { discordUserId: input.discordUserId, discordUsername };
    }),

  unlinkDiscord: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/user/discord/unlink",
        summary: "Unlink the current user's Discord account",
        tags: ["User"],
        protect: true,
      },
    })
    .input(z.object({}))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx }) => {
      await userRepo.clearDiscordMapping(ctx.db, ctx.user.id);
      return { success: true };
    }),
```

Add imports at the top of `user.ts` if missing: `import * as discordClient from "@kan/discord";` and `import * as userRepo from "@kan/db/repository/user.repo";` (match the file's existing import style — it already imports repos and zod).

- [ ] **Step 4: Ensure `getUser` returns the new fields**

Still in `user.ts`, locate the `getUser` procedure. Add `discordUserId` and `discordUsername` to (a) the repo selection it uses (if it selects explicit columns — add them there in `user.repo.ts`'s corresponding read function) and (b) its `.output(...)` zod schema, e.g. add `discordUserId: z.string().nullable(), discordUsername: z.string().nullable()`. If `getUser` returns the whole user row without an explicit column list, only the `.output` schema needs the two nullable fields.

- [ ] **Step 5: Add `searchWorkspaceDiscordMembers` to `discordRouter`**

In `packages/api/src/routers/discord.ts`, following the exact shape of `listRoles` (workspace-scoped, `getAuthorizedWorkspace(ctx, input.workspacePublicId, "board:view")`, `discordRepo.getByWorkspaceId`, NO `.meta`):

```ts
  searchWorkspaceDiscordMembers: protectedProcedure
    .input(workspaceInput.extend({ query: z.string().min(1).max(100) }))
    .output(z.array(z.object({ id: z.string(), username: z.string(), displayName: z.string() })))
    .query(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(ctx, input.workspacePublicId, "board:view");
      const connection = await discordRepo.getByWorkspaceId(ctx.db, workspace.id);
      if (!connection)
        throw new TRPCError({ message: "Discord is not connected for this workspace", code: "NOT_FOUND" });
      const members = await discordClient.searchGuildMembers(connection.guildId, input.query);
      if (!members.success || !members.data)
        throw new TRPCError({ message: members.error ?? "Failed to search Discord members", code: "INTERNAL_SERVER_ERROR" });
      return members.data;
    }),
```

- [ ] **Step 6: Run tests + typecheck + full api suite**

Run: `pnpm --filter @kan/api exec vitest run src/routers/user-discord.test.ts`
Expected: PASS.
Run: `pnpm --filter @kan/api typecheck && pnpm --filter @kan/api test`
Expected: typecheck clean; all existing router tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routers/user.ts packages/api/src/routers/discord.ts packages/api/src/routers/user-discord.test.ts packages/db/src/repository/user.repo.ts
git commit -m "feat(api): link/unlink discord + workspace member search

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Settings UI — link your Discord

**Files:**
- Create: `apps/web/src/views/settings/components/DiscordAccountLink.tsx`
- Modify: `apps/web/src/views/settings/AccountSettings.tsx` (import + render the section)

**Interfaces:**
- Consumes: `api.user.getUser` (now returns `discordUserId`/`discordUsername`), `api.user.linkDiscord`, `api.user.unlinkDiscord` (Task 5).
- Produces: a self-service "Discord" account section.

- [ ] **Step 1: Build the component**

No unit test — jsdom-mocking tRPC/EventSource-style UI tests only exercise the mock (covered by Task 10 manual E2E). Create `apps/web/src/views/settings/components/DiscordAccountLink.tsx`, following the `useMutation`/`showPopup`/`utils.user.getUser.refetch()` pattern from `UpdateDisplayNameForm.tsx`. It shows the current link status from `api.user.getUser.useQuery()` (`discordUsername`/`discordUserId`), a text input to paste a Discord user ID → `api.user.linkDiscord.useMutation()`, and an Unlink button → `api.user.unlinkDiscord.useMutation()`. On success of either, `await utils.user.getUser.refetch()`. Use the existing `t\`...\`` Lingui macro for copy and the shared form/input components used by `UpdateDisplayNameForm.tsx`.

```tsx
import { useState } from "react";
import { t } from "@lingui/core/macro";

import { api } from "~/utils/api";
import { usePopup } from "~/providers/popup"; // match the import path used by UpdateDisplayNameForm.tsx

export function DiscordAccountLink() {
  const { showPopup } = usePopup();
  const utils = api.useUtils();
  const { data: user } = api.user.getUser.useQuery();
  const [discordUserId, setDiscordUserId] = useState("");

  const link = api.user.linkDiscord.useMutation({
    onSuccess: async () => {
      showPopup({ header: t`Discord linked`, message: t`Your Discord account has been linked.`, icon: "success" });
      setDiscordUserId("");
      try { await utils.user.getUser.refetch(); } catch (e) { console.error(e); }
    },
    onError: () => {
      showPopup({ header: t`Error linking Discord`, message: t`Check the ID and try again.`, icon: "error" });
    },
  });

  const unlink = api.user.unlinkDiscord.useMutation({
    onSuccess: async () => {
      showPopup({ header: t`Discord unlinked`, message: t`Your Discord account has been unlinked.`, icon: "success" });
      try { await utils.user.getUser.refetch(); } catch (e) { console.error(e); }
    },
  });

  const linked = Boolean(user?.discordUserId);

  return (
    <div className="mb-4">
      <h3 className="text-sm font-medium">{t`Discord`}</h3>
      {linked ? (
        <div className="flex items-center gap-2">
          <span>{user?.discordUsername ?? user?.discordUserId}</span>
          <button onClick={() => unlink.mutate({})} disabled={unlink.isPending}>{t`Unlink`}</button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            value={discordUserId}
            onChange={(e) => setDiscordUserId(e.target.value)}
            placeholder={t`Discord user ID`}
          />
          <button
            onClick={() => link.mutate({ discordUserId })}
            disabled={link.isPending || !/^\d{15,20}$/.test(discordUserId)}
          >
            {t`Link`}
          </button>
        </div>
      )}
    </div>
  );
}
```

(Match the ACTUAL shared button/input components and the `usePopup`/`showPopup` import path used by `UpdateDisplayNameForm.tsx` — read that file and mirror it rather than hand-rolling raw `<button>`/`<input>` if the codebase has shared primitives. The "pick from server" dropdown via `api.discord.searchWorkspaceDiscordMembers` is an optional enhancement to this same component; the paste-ID + auto-from-login paths already deliver the feature.)

- [ ] **Step 2: Mount in AccountSettings**

In `apps/web/src/views/settings/AccountSettings.tsx`, add the import next to the other section imports (e.g. near `UpdateDisplayNameForm`):

```tsx
import { DiscordAccountLink } from "./components/DiscordAccountLink";
```

And render it in the sections list (in a `<div className="mb-4">` block alongside `UpdateDisplayNameForm`):

```tsx
        <DiscordAccountLink />
```

- [ ] **Step 3: Typecheck + per-file lint/format**

Run:
```
pnpm --filter @kan/web typecheck
pnpm --filter @kan/web exec eslint src/views/settings/components/DiscordAccountLink.tsx src/views/settings/AccountSettings.tsx
pnpm --filter @kan/web exec prettier --check src/views/settings/components/DiscordAccountLink.tsx src/views/settings/AccountSettings.tsx
```
Expected: no NEW typecheck errors from these two files; eslint 0 errors on them; prettier clean (run `prettier --write` on them if needed). (Whole-package `@kan/web lint` is known to crash on an unrelated plugin issue — lint per-file.)

- [ ] **Step 4: Extract i18n strings**

Run: `pnpm --filter @kan/web lingui:extract` then `pnpm --filter @kan/web lingui:compile`
(Commit the updated catalogs under `apps/web/src/locales/`.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/views/settings/components/DiscordAccountLink.tsx apps/web/src/views/settings/AccountSettings.tsx apps/web/src/locales/
git commit -m "feat(web): settings section to link a discord account

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Enable tags

### Task 7: Discord mention helper + assignment ping

**Files:**
- Create: `packages/api/src/utils/discordMentions.ts`
- Create: `packages/api/src/utils/discordMentions.test.ts`
- Modify: `packages/api/src/routers/card.ts` (wire into `addOrRemoveMember` add branch + card-create-with-members)

**Interfaces:**
- Consumes: `cardRepo.getDiscordContextByPublicId` (existing — returns `discordThreadId`); `memberRepo.getByPublicIdsWithUsers` (now includes `discordUserId`, Task 3); `buildUserMentions`/`postMessage` (Task 2).
- Produces (used by Task 8): `notifyAssigned(db, cardPublicId, memberPublicIds: string[]): Promise<void>` and the shared internal `resolveDiscordIds`.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/utils/discordMentions.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/repository/card.repo", () => ({ getDiscordContextByPublicId: vi.fn() }));
vi.mock("@kan/db/repository/member.repo", () => ({ getByPublicIdsWithUsers: vi.fn() }));
vi.mock("@kan/discord", () => ({
  postMessage: vi.fn(() => Promise.resolve({ success: true })),
  buildUserMentions: (ids: string[]) => ids.map((id) => `<@${id}>`).join(" "),
}));

import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as memberRepo from "@kan/db/repository/member.repo";
import { postMessage } from "@kan/discord";

import { notifyAssigned } from "./discordMentions";

const db = {} as dbClient;
const mockCtx = cardRepo.getDiscordContextByPublicId as ReturnType<typeof vi.fn>;
const mockMembers = memberRepo.getByPublicIdsWithUsers as ReturnType<typeof vi.fn>;
const mockPost = postMessage as ReturnType<typeof vi.fn>;

describe("notifyAssigned", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pings the assigned member's discord id in the card thread", async () => {
    mockCtx.mockResolvedValue({ discordThreadId: "thread1" });
    mockMembers.mockResolvedValue([{ user: { discordUserId: "111" } }]);
    await notifyAssigned(db, "card_1", ["mem_1"]);
    expect(mockPost).toHaveBeenCalledWith("thread1", expect.stringContaining("<@111>"), [], [], ["111"]);
  });

  it("does nothing when the card has no thread", async () => {
    mockCtx.mockResolvedValue({ discordThreadId: null });
    await notifyAssigned(db, "card_1", ["mem_1"]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("does nothing when the member has no linked discord id", async () => {
    mockCtx.mockResolvedValue({ discordThreadId: "thread1" });
    mockMembers.mockResolvedValue([{ user: { discordUserId: null } }]);
    await notifyAssigned(db, "card_1", ["mem_1"]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("never throws when a repo call rejects", async () => {
    mockCtx.mockRejectedValue(new Error("db down"));
    await expect(notifyAssigned(db, "card_1", ["mem_1"])).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kan/api exec vitest run src/utils/discordMentions.test.ts`
Expected: FAIL — `notifyAssigned` not exported.

- [ ] **Step 3: Implement the helper**

Create `packages/api/src/utils/discordMentions.ts`:

```ts
import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as memberRepo from "@kan/db/repository/member.repo";
import { buildUserMentions, postMessage } from "@kan/discord";

async function resolveDiscordIds(
  db: dbClient,
  memberPublicIds: string[],
): Promise<string[]> {
  if (!memberPublicIds.length) return [];
  const members = await memberRepo.getByPublicIdsWithUsers(db, memberPublicIds);
  return members
    .map((m) => m.user?.discordUserId ?? null)
    .filter((id): id is string => !!id);
}

export async function notifyAssigned(
  db: dbClient,
  cardPublicId: string,
  memberPublicIds: string[],
): Promise<void> {
  try {
    const ctx = await cardRepo.getDiscordContextByPublicId(db, cardPublicId);
    if (!ctx?.discordThreadId) return;
    const ids = await resolveDiscordIds(db, memberPublicIds);
    if (!ids.length) return;
    await postMessage(
      ctx.discordThreadId,
      `${buildUserMentions(ids)} you were assigned to this card.`,
      [],
      [],
      ids,
    );
  } catch (error) {
    console.error("Discord assignment ping failed:", error);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kan/api exec vitest run src/utils/discordMentions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into `card.ts`**

Add the import at the top of `packages/api/src/routers/card.ts` (with the other `../` imports):

```ts
import { notifyAssigned } from "../utils/discordMentions";
```

In `addOrRemoveMember`, in the **add** branch, immediately after the existing `notifyCardUpdated(ctx.db, input.cardPublicId).catch(...)` and before `emitFromCard(...)`/`return { newMember: true }`:

```ts
      notifyAssigned(ctx.db, input.cardPublicId, [input.workspaceMemberPublicId]).catch(
        (error) => console.error("Discord assignment ping failed:", error),
      );
```

(Use the actual input field name for the toggled member publicId — confirm it against the procedure's `.input(...)` schema; it is the same value passed to `createCardMemberRelationship`.)

In card-create-with-members, immediately after `notifyCardCreated(...)` is fired (the success path, ~line 232), add (only when the create input included members):

```ts
      if (input.memberPublicIds?.length) {
        notifyAssigned(ctx.db, newCard.publicId, input.memberPublicIds).catch((error) =>
          console.error("Discord assignment ping failed:", error),
        );
      }
```

(Confirm the create input's member-list field name and the created card's publicId variable against the actual procedure.)

- [ ] **Step 6: Typecheck + full api suite**

Run: `pnpm --filter @kan/api typecheck && pnpm --filter @kan/api test`
Expected: clean; all tests pass. If a `card.ts` test mocks `@kan/db/repository/card.repo` or `member.repo` without the functions `notifyAssigned` reaches, the fire-and-forget `.catch` swallows it — but add the missing mock fn (`getDiscordContextByPublicId: vi.fn(() => Promise.resolve(null))`) to any test that reports an unhandled rejection.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/utils/discordMentions.ts packages/api/src/utils/discordMentions.test.ts packages/api/src/routers/card.ts
git commit -m "feat(api): ping assigned members on discord

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Comment @mention ping

**Files:**
- Modify: `packages/api/src/utils/discordMentions.ts` (add `notifyCommentMentions`)
- Modify: `packages/api/src/utils/discordMentions.test.ts` (add tests)
- Modify: `packages/api/src/routers/card.ts` (wire into `addComment` + `updateComment`)

**Interfaces:**
- Consumes: `parseMentionsFromHTML` (`@kan/shared/utils/mentions`); the internals from Task 7.
- Produces: `notifyCommentMentions(db, cardPublicId, commentHtml, authorName): Promise<void>`.

- [ ] **Step 1: Add the failing tests**

Append to `packages/api/src/utils/discordMentions.test.ts` (add `notifyCommentMentions` to the import):

```ts
describe("notifyCommentMentions", () => {
  const html = '<span data-type="mention" data-id="mem_000000001">@Alice</span> hi';

  beforeEach(() => vi.clearAllMocks());

  it("pings mentioned members with the author name", async () => {
    mockCtx.mockResolvedValue({ discordThreadId: "thread1" });
    mockMembers.mockResolvedValue([{ user: { discordUserId: "111" } }]);
    await notifyCommentMentions(db, "card_1", html, "Bob");
    expect(mockPost).toHaveBeenCalledWith(
      "thread1",
      expect.stringMatching(/<@111>.*Bob/),
      [],
      [],
      ["111"],
    );
  });

  it("does nothing when the comment has no mentions", async () => {
    await notifyCommentMentions(db, "card_1", "<p>plain comment</p>", "Bob");
    expect(mockCtx).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kan/api exec vitest run src/utils/discordMentions.test.ts`
Expected: FAIL — `notifyCommentMentions` not exported.

- [ ] **Step 3: Implement**

Add to `packages/api/src/utils/discordMentions.ts` (import at top: `import { parseMentionsFromHTML } from "@kan/shared/utils/mentions";`):

```ts
export async function notifyCommentMentions(
  db: dbClient,
  cardPublicId: string,
  commentHtml: string,
  authorName: string,
): Promise<void> {
  try {
    const memberPublicIds = parseMentionsFromHTML(commentHtml);
    if (!memberPublicIds.length) return;
    const ctx = await cardRepo.getDiscordContextByPublicId(db, cardPublicId);
    if (!ctx?.discordThreadId) return;
    const ids = await resolveDiscordIds(db, memberPublicIds);
    if (!ids.length) return;
    await postMessage(
      ctx.discordThreadId,
      `${buildUserMentions(ids)} — mentioned by ${authorName}`,
      [],
      [],
      ids,
    );
  } catch (error) {
    console.error("Discord comment mention ping failed:", error);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @kan/api exec vitest run src/utils/discordMentions.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Wire into `addComment`/`updateComment`**

In `packages/api/src/routers/card.ts`, add `notifyCommentMentions` to the existing `../utils/discordMentions` import. In `addComment`, right after the existing `sendMentionEmails({...}).catch(...)` (~line 321-329):

```ts
      notifyCommentMentions(
        ctx.db,
        input.cardPublicId,
        input.comment, // the comment HTML — use the same field passed to sendMentionEmails
        ctx.user.name ?? ctx.user.email ?? "Someone",
      ).catch((error) => console.error("Discord comment mention ping failed:", error));
```

(Confirm the comment-HTML input field name and the author-name source against the actual `addComment` handler — use exactly what `sendMentionEmails` is given.) Add the same call in `updateComment` after its `sendMentionEmails` call.

- [ ] **Step 6: Typecheck + full api suite**

Run: `pnpm --filter @kan/api typecheck && pnpm --filter @kan/api test`
Expected: clean; all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/utils/discordMentions.ts packages/api/src/utils/discordMentions.test.ts packages/api/src/routers/card.ts
git commit -m "feat(api): ping comment @mentions on discord

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Due-reminder assignee ping

**Files:**
- Modify: `packages/db/src/repository/card.repo.ts` (`getCardsNeedingDueSoonReminder` + `getCardsNeedingDueNowReminder`: include assignees' `discordUserId`)
- Modify: `apps/web/src/pages/api/cron/due-reminders.ts` (build `mentionUserIds`, pass to `postMessage`)
- Modify: `apps/web/src/pages/api/cron/due-reminders.test.ts` (assert mentions passed)

**Interfaces:**
- Consumes: the extended reminder repo selects; `buildUserMentions`/`postMessage` (Task 2).
- Produces: due reminders that ping the card's assignees.

- [ ] **Step 1: Extend the repo selects**

In `packages/db/src/repository/card.repo.ts`, in BOTH `getCardsNeedingDueSoonReminder` and `getCardsNeedingDueNowReminder`, add a `with` clause selecting assignees' discord ids (follow the nesting already used at ~lines 752-762):

```ts
  return db.query.cards.findMany({
    columns: { id: true, title: true, dueDate: true, discordThreadId: true },
    with: {
      members: {
        with: {
          member: { with: { user: { columns: { discordUserId: true } } } },
        },
      },
    },
    where: and( /* unchanged */ ),
  });
```

(Confirm the relation names — `members` → `member` → `user` — against the schema; they are the same ones `getDiscordContextByPublicId` uses.)

- [ ] **Step 2: Update the failing test**

In `apps/web/src/pages/api/cron/due-reminders.test.ts`, update the mocked `getCardsNeedingDueSoonReminder` to return a card whose `members` carry `discordUserId`, and assert `postMessage` is called with `mentionUserIds` (5th arg) and content containing the mention. Add:

```ts
  it("pings assignees with linked discord ids", async () => {
    mockGetSoon.mockResolvedValue([
      {
        id: 1,
        title: "Ship it",
        dueDate: new Date(),
        discordThreadId: "thread1",
        members: [{ member: { user: { discordUserId: "111" } } }],
      },
    ]);
    mockGetNow.mockResolvedValue([]);
    await sendDueReminders(dbStub);
    const call = mockPost.mock.calls[0];
    expect(call[4]).toEqual(["111"]); // mentionUserIds
    expect(call[1]).toContain("<@111>"); // content
  });
```

(Mirror the file's existing mocking of `@kan/db/repository/card.repo` and `@kan/discord`; add mocks for the two `getCardsNeeding*` fns and `postMessage`/`buildUserMentions` if not already present.)

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @kan/web exec vitest run src/pages/api/cron/due-reminders.test.ts`
Expected: FAIL — current code passes `[]`/no user mentions.

- [ ] **Step 4: Implement in the cron**

In `apps/web/src/pages/api/cron/due-reminders.ts`, add `buildUserMentions` to the `@kan/discord` import. In BOTH loops, before calling `postMessage`, compute the assignee mentions and pass them:

```ts
    const mentionUserIds = (card.members ?? [])
      .map((m) => m.member.user?.discordUserId ?? null)
      .filter((id): id is string => !!id);
    const mention = buildUserMentions(mentionUserIds);

    const result = await postMessage(
      card.discordThreadId,
      mention, // was "" — now pings assignees
      [],
      [
        { color: 0xf59e0b, title: "⏰ Due soon", description: `**${card.title}** — <t:${unix}:R> (<t:${unix}:f>)` },
      ],
      mentionUserIds,
    );
```

(Do the analogous change in the "Due now" loop with its red embed. `mention` is `""` when no assignee is linked — Discord accepts an empty content alongside an embed, preserving today's behaviour.)

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter @kan/web exec vitest run src/pages/api/cron/due-reminders.test.ts`
Expected: PASS.
Run: `pnpm --filter @kan/db typecheck && pnpm --filter @kan/web typecheck`
Expected: `@kan/db` clean; `@kan/web` no NEW errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repository/card.repo.ts apps/web/src/pages/api/cron/due-reminders.ts apps/web/src/pages/api/cron/due-reminders.test.ts
git commit -m "feat(web): ping assignees in discord due reminders

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full suites + typecheck**

Run from repo root:
```bash
pnpm --filter @kan/discord test
pnpm --filter @kan/auth test
pnpm --filter @kan/api test
pnpm --filter @kan/web test
pnpm --filter @kan/db typecheck && pnpm --filter @kan/api typecheck && pnpm --filter @kan/discord typecheck && pnpm --filter @kan/auth typecheck && pnpm --filter @kan/web typecheck
```
Expected: all PASS; typechecks add no new errors.

- [ ] **Step 2: Manual E2E (real bot + guild)**

Prerequisites: bot has the **GUILD_MEMBERS** privileged intent enabled; the workspace is connected to a Discord server (`workspace_discord.guildId`); a board/list has `discordBehaviour = "create_thread"` so cards get threads; the tester's Kan user is linked (Settings → Discord → paste ID, or log in with Discord after setting `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`); the linked Discord user is a member of that server.

1. In Settings, link your Discord user ID; confirm `user.discordUserId`/`discordUsername` are stored (`docker exec -i kan-analytics-pg psql -U postgres -d kan -c 'select "discordUserId","discordUsername" from "user" where email=...'`).
2. Create a card on the thread-enabled list, assign yourself → within a moment the card's Discord thread shows a message that pings you (`<@yourId>`), and Discord actually notifies you.
3. On that card, post a comment that @mentions a linked member → the thread posts a "mentioned by …" ping tagging them.
4. Set the card due within 10 minutes, trigger the due-reminders cron (`curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/due-reminders`) → the reminder message pings the assignees.
5. Negative: assign/comment/due for a member with NO linked Discord → no ping, no error, mutation succeeds normally.

- [ ] **Step 3: Report results**

Report each check pass/fail. Include this operator note for the user: the tag only pushes a real notification if the mapped Discord user is a member of the server the bot posts into; `searchWorkspaceDiscordMembers` and auto-from-login both require the corresponding Discord app configuration (GUILD_MEMBERS intent for the bot; `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` for login).

---

## Explicit non-goals (do not build)

- No per-user opt-out toggle — not linking a Discord account is the opt-out.
- No admin-maps-others flow — linking is self-service only.
- No real-time guild-membership re-verification on every tag (best-effort ping).
- No syncing of Discord display name/avatar into Kan beyond the cached `discordUsername`.
- No change to the existing role-mention behaviour (`list.discordRoleIds`).
- The "pick from server members" dropdown in Settings (using `searchWorkspaceDiscordMembers`) is optional polish on top of Task 6 — paste-ID + auto-from-login already deliver the mapping.
