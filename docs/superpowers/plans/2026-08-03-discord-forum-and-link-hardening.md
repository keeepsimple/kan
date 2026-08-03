# Discord Forum Support + Link Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate Discord-ID links, stop comment-edit ping spam, and let a board link to a Discord **forum** channel so cards become forum posts.

**Architecture:** Reuse the existing thread pipeline — a forum post *is* a thread, so embed-sync / due-reminders / mention & assignee pings all work unchanged once the post exists; only card-creation branches on channel type. Link hardening adds a partial unique index + a conflict check. Mention dedup diffs the new comment against the previous one.

**Tech Stack:** tRPC v11, Drizzle ORM (Postgres), Vitest, Discord REST API v10, Next.js (pages router), Lingui.

## Global Constraints

- publicId (12-char) in all API I/O; repos resolve publicId → numeric id. Never expose numeric ids.
- Data access only through `packages/db/repository/*.repo.ts`; routers never touch Drizzle directly.
- Discord side-effects are fire-and-forget: never throw into the request path; log and swallow.
- `postMessage`/forum `message` always set `allowed_mentions.parse: []` (explicit roles/users only).
- Discord limits: thread/post name ≤ 100 chars; embed title ≤ 256; ≤ 25 fields; forum `applied_tags` ≤ 5.
- Run tests with: `pnpm --filter @kan/api exec vitest run <file>`, `pnpm --filter @kan/web exec vitest run <file>`, `pnpm --filter @kan/discord exec vitest run <file>`.
- Conventional commits. End commit messages with the repo's Co-Authored-By trailer.

---

## File Structure

- `packages/db/src/schema/users.ts` — add partial unique index on `discordUserId`.
- `packages/db/migrations/<ts>_AddUniqueIndexToDiscordUserId.sql` (+ meta) — generated migration.
- `packages/db/src/repository/user.repo.ts` — add `getByDiscordUserId`.
- `packages/api/src/routers/user.ts` — `linkDiscord` conflict guard.
- `packages/api/src/routers/user-discord.test.ts` — conflict/idempotent tests; `listChannels` type test; mock rename.
- `packages/api/src/utils/discordMentions.ts` — `notifyCommentMentions` dedup + author-exclude.
- `packages/api/src/utils/discordMentions.test.ts` — dedup/author tests.
- `packages/api/src/routers/card.ts` — pass `previousHtml`/`authorUserId` to `notifyCommentMentions`.
- `packages/discord/src/index.ts` — `getPostableChannels` (rename), `getChannel`, `createForumPost`, `CHANNEL_TYPE_FORUM`, `FORUM_FLAG_REQUIRE_TAG`.
- `packages/discord/src/index.test.ts` — forum client tests + rename.
- `packages/api/src/utils/discord.ts` — `matchForumTags`; forum branch in `notifyCardCreated`; forum guard in `notifyCardMoved`.
- `packages/api/src/utils/discord.test.ts` — `matchForumTags` tests.
- `packages/api/src/utils/discord-forum.test.ts` (new) — `notifyCardCreated` forum vs text branch.
- `packages/api/src/routers/discord.ts` — `listChannels` uses `getPostableChannels`, output adds `type`.
- `apps/web/src/views/board/components/BoardDiscordChannelModal.tsx` — "(forum)" label.

---

## Task 1: Fix #1 — unique Discord IDs + link conflict guard

**Files:**
- Modify: `packages/db/src/schema/users.ts`
- Create: `packages/db/migrations/<timestamp>_AddUniqueIndexToDiscordUserId.sql` (via drizzle-kit generate)
- Modify: `packages/db/src/repository/user.repo.ts`
- Modify: `packages/api/src/routers/user.ts:180-214`
- Test: `packages/api/src/routers/user-discord.test.ts`

**Interfaces:**
- Produces: `userRepo.getByDiscordUserId(db, discordUserId: string): Promise<{ id: string } | undefined>`
- Produces: `user.linkDiscord` throws `TRPCError{code:"CONFLICT"}` when the id belongs to another user.

- [ ] **Step 1: Write failing repo/router tests**

In `user-discord.test.ts`, add `getByDiscordUserId` to the user.repo mock and a handle, then two tests:

```ts
// in the vi.mock("@kan/db/repository/user.repo", ...) factory, add:
//   getByDiscordUserId: vi.fn(),
const mockGetByDiscordUserId = userRepo.getByDiscordUserId as ReturnType<
  typeof vi.fn
>;

it("rejects linking a discord id already owned by another user", async () => {
  mockGetByDiscordUserId.mockResolvedValue({ id: "user2" });
  await expect(
    caller.linkDiscord({ discordUserId: VALID_DISCORD_ID }),
  ).rejects.toThrow(/already linked/i);
  expect(mockSet).not.toHaveBeenCalled();
});

it("allows re-linking the same discord id to the same user (idempotent)", async () => {
  mockGetByDiscordUserId.mockResolvedValue({ id: "user1" });
  mockGetUser.mockResolvedValue({
    success: true,
    data: { id: VALID_DISCORD_ID, username: "alice", displayName: "Alice" },
  });
  const result = await caller.linkDiscord({ discordUserId: VALID_DISCORD_ID });
  expect(mockSet).toHaveBeenCalled();
  expect(result.discordUserId).toBe(VALID_DISCORD_ID);
});
```

Existing `linkDiscord` tests must still pass: `getByDiscordUserId` defaults to `undefined` (vi.fn), which means "no owner" → no conflict.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kan/api exec vitest run src/routers/user-discord.test.ts`
Expected: FAIL — `getByDiscordUserId` is not a function / no conflict thrown.

- [ ] **Step 3: Add `getByDiscordUserId` to the repo**

In `packages/db/src/repository/user.repo.ts` (after `getById`):

```ts
export const getByDiscordUserId = async (
  db: dbClient,
  discordUserId: string,
) => {
  return db.query.users.findFirst({
    columns: { id: true },
    where: eq(users.discordUserId, discordUserId),
  });
};
```

(`eq` and `users` are already imported.)

- [ ] **Step 4: Add the conflict guard to `linkDiscord`**

In `packages/api/src/routers/user.ts`, inside the `linkDiscord` mutation, right after the `if (!userId) throw ...` block and **before** the `discordClient.getUser` call:

```ts
const owner = await userRepo.getByDiscordUserId(ctx.db, input.discordUserId);
if (owner && owner.id !== userId)
  throw new TRPCError({
    code: "CONFLICT",
    message: "This Discord account is already linked to another user.",
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @kan/api exec vitest run src/routers/user-discord.test.ts`
Expected: PASS (all, including the two existing linkDiscord tests).

- [ ] **Step 6: Add the partial unique index to the schema**

In `packages/db/src/schema/users.ts`:
- Add `uniqueIndex` to the `drizzle-orm/pg-core` import.
- Change the table definition to add a third argument (keep `.enableRLS()`):

```ts
export const users = pgTable(
  "user",
  {
    // ...unchanged columns...
  },
  (table) => [
    uniqueIndex("user_discord_user_id_unique")
      .on(table.discordUserId)
      .where(sql`${table.discordUserId} IS NOT NULL`),
  ],
).enableRLS();
```

(`sql` is already imported from `drizzle-orm`.)

- [ ] **Step 7: Generate the migration**

Run: `cd packages/db && pnpm with-env drizzle-kit generate --name AddUniqueIndexToDiscordUserId`
Then **review** the new file in `packages/db/migrations/` — it must contain only:

```sql
CREATE UNIQUE INDEX "user_discord_user_id_unique" ON "user" USING btree ("discordUserId") WHERE "discordUserId" IS NOT NULL;
```

If it contains unrelated changes, discard and investigate schema drift before proceeding.

- [ ] **Step 8: Typecheck + apply migration locally**

Run: `pnpm typecheck` (expect pass).
Run: `pnpm db:migrate` (applies the index to the local Postgres).
If existing rows already violate uniqueness, dedup them manually first, then re-run. (Fresh/dev DBs won't.)

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/schema/users.ts packages/db/migrations packages/db/src/repository/user.repo.ts packages/api/src/routers/user.ts packages/api/src/routers/user-discord.test.ts
git commit -m "fix(api): enforce unique discord id + block cross-user link"
```

---

## Task 2: Fix #2 — dedup comment-mention pings + exclude author

**Files:**
- Modify: `packages/api/src/utils/discordMentions.ts:49-76`
- Modify: `packages/api/src/routers/card.ts` (`addComment` ~335, `updateComment` ~436)
- Test: `packages/api/src/utils/discordMentions.test.ts`

**Interfaces:**
- Produces: `notifyCommentMentions(db, cardPublicId, commentHtml, authorName, opts?: { previousHtml?: string; authorUserId?: string }): Promise<void>`

- [ ] **Step 1: Write failing tests**

Append to `discordMentions.test.ts` inside `describe("notifyCommentMentions", ...)`:

```ts
it("does not ping when an edit adds no new mention", async () => {
  await notifyCommentMentions(db, "card_1", html, "Bob", {
    previousHtml: html,
  });
  expect(mockCtx).not.toHaveBeenCalled();
  expect(mockPost).not.toHaveBeenCalled();
});

it("pings only newly-added mentions on edit", async () => {
  const prev =
    '<span data-type="mention" data-id="mem_000000001">@A</span>';
  const next =
    prev +
    '<span data-type="mention" data-id="mem_000000002">@B</span>';
  mockCtx.mockResolvedValue({
    discordThreadId: "thread1",
    list: { board: { workspaceId: 7 } },
  });
  mockMembers.mockResolvedValue([
    { user: { id: "uB", discordUserId: "222" } },
  ]);
  await notifyCommentMentions(db, "card_1", next, "Bob", {
    previousHtml: prev,
  });
  expect(mockMembers).toHaveBeenCalledWith(db, ["mem_000000002"], 7);
  expect(mockPost).toHaveBeenCalledWith(
    "thread1",
    expect.stringContaining("<@222>"),
    [],
    [],
    ["222"],
  );
});

it("excludes the comment author from the ping", async () => {
  mockCtx.mockResolvedValue({
    discordThreadId: "thread1",
    list: { board: { workspaceId: 7 } },
  });
  mockMembers.mockResolvedValue([
    { user: { id: "uAuthor", discordUserId: "111" } },
  ]);
  await notifyCommentMentions(db, "card_1", html, "Bob", {
    authorUserId: "uAuthor",
  });
  expect(mockPost).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kan/api exec vitest run src/utils/discordMentions.test.ts`
Expected: FAIL (opts not honored yet).

- [ ] **Step 3: Update `notifyCommentMentions`**

Replace the `notifyCommentMentions` function in `discordMentions.ts` with:

```ts
export async function notifyCommentMentions(
  db: dbClient,
  cardPublicId: string,
  commentHtml: string,
  authorName: string,
  opts?: { previousHtml?: string; authorUserId?: string },
): Promise<void> {
  try {
    const previous = new Set(
      opts?.previousHtml ? parseMentionsFromHTML(opts.previousHtml) : [],
    );
    const memberPublicIds = parseMentionsFromHTML(commentHtml).filter(
      (id) => !previous.has(id),
    );
    if (!memberPublicIds.length) return;
    const ctx = await cardRepo.getDiscordContextByPublicId(db, cardPublicId);
    if (!ctx?.discordThreadId) return;
    const members = await memberRepo.getByPublicIdsWithUsers(
      db,
      memberPublicIds,
      ctx.list.board.workspaceId,
    );
    const ids = members
      .filter((m) => !opts?.authorUserId || m.user?.id !== opts.authorUserId)
      .map((m) => m.user?.discordUserId ?? null)
      .filter((id): id is string => !!id);
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

(`resolveDiscordIds` stays — still used by `notifyAssigned`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @kan/api exec vitest run src/utils/discordMentions.test.ts`
Expected: PASS (including the pre-existing "pings mentioned members" and "no mentions" tests).

- [ ] **Step 5: Wire the call sites in `card.ts`**

In `addComment`, replace the `notifyCommentMentions(...)` call with:

```ts
notifyCommentMentions(
  ctx.db,
  input.cardPublicId,
  input.comment,
  ctx.user?.name ?? ctx.user?.email ?? "Someone",
  { authorUserId: userId },
).catch((error) =>
  console.error("Discord comment mention ping failed:", error),
);
```

In `updateComment`, replace the `notifyCommentMentions(...)` call with:

```ts
notifyCommentMentions(
  ctx.db,
  input.cardPublicId,
  input.comment,
  ctx.user?.name ?? ctx.user?.email ?? "Someone",
  { previousHtml: existingComment.comment, authorUserId: userId },
).catch((error) =>
  console.error("Discord comment mention ping failed:", error),
);
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck` (expect pass).

```bash
git add packages/api/src/utils/discordMentions.ts packages/api/src/utils/discordMentions.test.ts packages/api/src/routers/card.ts
git commit -m "fix(api): only ping newly-added comment mentions, skip author"
```

---

## Task 3: `@kan/discord` — forum channel primitives

**Files:**
- Modify: `packages/discord/src/index.ts`
- Test: `packages/discord/src/index.test.ts`

**Interfaces:**
- Produces: `getPostableChannels(guildId): Promise<DiscordResult<DiscordChannel[]>>` (types 0 and 15)
- Produces: `getChannel(channelId): Promise<DiscordResult<{ id: string; type: number; availableTags: {id:string;name:string}[]; flags: number }>>`
- Produces: `createForumPost(forumChannelId, name, opts: { content?: string; embeds?: DiscordEmbed[]; mentionRoleIds?: string[]; mentionUserIds?: string[]; appliedTagIds?: string[] }): Promise<DiscordResult<DiscordThread>>`
- Produces: `CHANNEL_TYPE_FORUM = 15`, `FORUM_FLAG_REQUIRE_TAG = 16`

- [ ] **Step 1: Write failing tests**

In `index.test.ts`: rename the `getTextChannels` describe to `getPostableChannels`, import `getPostableChannels, getChannel, createForumPost` instead of `getTextChannels`, and use these tests:

```ts
describe("getPostableChannels", () => {
  it("keeps text (0) and forum (15) channels, drops others", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        { id: "1", name: "general", type: 0 },
        { id: "2", name: "voice", type: 2 },
        { id: "3", name: "ideas", type: 15 },
      ]),
    );
    const result = await getPostableChannels("g1");
    expect(result.data).toEqual([
      { id: "1", name: "general", type: 0 },
      { id: "3", name: "ideas", type: 15 },
    ]);
  });
});

describe("getChannel", () => {
  it("maps available_tags and flags for a forum channel", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        id: "3",
        type: 15,
        flags: 16,
        available_tags: [{ id: "t1", name: "Bug" }],
      }),
    );
    const res = await getChannel("3");
    expect(res.data).toEqual({
      id: "3",
      type: 15,
      flags: 16,
      availableTags: [{ id: "t1", name: "Bug" }],
    });
  });
});

describe("createForumPost", () => {
  it("posts a thread with an initial message, tags and allowed_mentions", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "post1", name: "n" }));
    const res = await createForumPost("3", "a".repeat(150), {
      content: "<@&7>",
      embeds: [{ title: "t" }],
      mentionRoleIds: ["7"],
      appliedTagIds: ["t1", "t2", "t3", "t4", "t5", "t6"],
    });
    expect(res.data?.id).toBe("post1");
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("https://discord.com/api/v10/channels/3/threads");
    const body = JSON.parse(call[1].body as string) as {
      name: string;
      applied_tags: string[];
      message: { content: string; allowed_mentions: unknown; embeds: unknown };
    };
    expect(body.name).toHaveLength(100);
    expect(body.applied_tags).toEqual(["t1", "t2", "t3", "t4", "t5"]); // capped at 5
    expect(body.message.content).toBe("<@&7>");
    expect(body.message.allowed_mentions).toEqual({
      parse: [],
      roles: ["7"],
      users: [],
    });
    expect(body.message.embeds).toEqual([{ title: "t" }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kan/discord exec vitest run src/index.test.ts`
Expected: FAIL — the new functions don't exist.

- [ ] **Step 3: Rename `getTextChannels` → `getPostableChannels` and add forum type**

Replace `getTextChannels` in `index.ts` with:

```ts
export const getPostableChannels = async (
  guildId: string,
): Promise<DiscordResult<DiscordChannel[]>> => {
  const result = await discordFetch<DiscordChannel[]>(
    `/guilds/${guildId}/channels`,
  );
  if (!result.success || !result.data) return result;
  // type 0 = text channel, type 15 = forum channel (both accept card posts)
  return {
    success: true,
    data: result.data.filter((c) => c.type === 0 || c.type === 15),
  };
};
```

- [ ] **Step 4: Add `getChannel`, `createForumPost`, and constants**

Add to `index.ts` (near `createThread`/`postMessage`):

```ts
export const CHANNEL_TYPE_FORUM = 15;
export const FORUM_FLAG_REQUIRE_TAG = 1 << 4; // 16

export interface DiscordChannelDetail {
  id: string;
  type: number;
  availableTags: { id: string; name: string }[];
  flags: number;
}

export const getChannel = async (
  channelId: string,
): Promise<DiscordResult<DiscordChannelDetail>> => {
  const res = await discordFetch<{
    id: string;
    type: number;
    flags?: number;
    available_tags?: { id: string; name: string }[];
  }>(`/channels/${channelId}`);
  if (!res.success || !res.data) return { success: false, error: res.error };
  return {
    success: true,
    data: {
      id: res.data.id,
      type: res.data.type,
      flags: res.data.flags ?? 0,
      availableTags: (res.data.available_tags ?? []).map((t) => ({
        id: t.id,
        name: t.name,
      })),
    },
  };
};

export const createForumPost = (
  forumChannelId: string,
  name: string,
  opts: {
    content?: string;
    embeds?: DiscordEmbed[];
    mentionRoleIds?: string[];
    mentionUserIds?: string[];
    appliedTagIds?: string[];
  },
) =>
  discordFetch<DiscordThread>(`/channels/${forumChannelId}/threads`, {
    method: "POST",
    body: JSON.stringify({
      // Discord caps thread names at 100 chars
      name: name.slice(0, 100),
      auto_archive_duration: 10080,
      ...(opts.appliedTagIds?.length
        ? { applied_tags: opts.appliedTagIds.slice(0, 5) }
        : {}),
      // Forum posts require a starter message; its id equals the thread id.
      message: {
        content: opts.content ?? "",
        allowed_mentions: {
          parse: [],
          roles: opts.mentionRoleIds ?? [],
          users: opts.mentionUserIds ?? [],
        },
        ...(opts.embeds?.length ? { embeds: opts.embeds } : {}),
      },
    }),
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @kan/discord exec vitest run src/index.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/discord/src/index.ts packages/discord/src/index.test.ts
git commit -m "feat(discord): forum channel primitives (getChannel, createForumPost)"
```

---

## Task 4: discord router `listChannels` + board picker UI

**Files:**
- Modify: `packages/api/src/routers/discord.ts:125-155`
- Modify: `packages/api/src/routers/user-discord.test.ts` (mock rename + listChannels test)
- Modify: `apps/web/src/views/board/components/BoardDiscordChannelModal.tsx:51-58`

**Interfaces:**
- Consumes: `getPostableChannels` (Task 3)
- Produces: `discord.listChannels` output items shaped `{ id: string; name: string; type: number }`

- [ ] **Step 1: Write a failing router test**

In `user-discord.test.ts`: in the `vi.mock("@kan/discord", ...)` factory, replace `getTextChannels: vi.fn()` with `getPostableChannels: vi.fn()`. Add near the other handles:

```ts
import { getPostableChannels } from "@kan/discord";
const mockGetPostableChannels = getPostableChannels as ReturnType<typeof vi.fn>;
```

Then a new describe:

```ts
describe("discord.listChannels", () => {
  const ctx = { user: { id: "user1" }, db: mockDb } as never;
  const caller = discordRouter.createCaller(ctx);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkspaceByPublicId.mockResolvedValue({
      id: 1,
      publicId: "ws1234567890",
    });
    mockAssertPermission.mockResolvedValue(undefined);
    mockGetByWorkspaceId.mockResolvedValue({ id: 1, guildId: "guild1" });
  });

  it("returns id, name and type (text + forum) for the workspace guild", async () => {
    mockGetPostableChannels.mockResolvedValue({
      success: true,
      data: [
        { id: "1", name: "general", type: 0 },
        { id: "3", name: "ideas", type: 15 },
      ],
    });
    const result = await caller.listChannels({
      workspacePublicId: "ws1234567890",
    });
    expect(mockGetPostableChannels).toHaveBeenCalledWith("guild1");
    expect(result).toEqual([
      { id: "1", name: "general", type: 0 },
      { id: "3", name: "ideas", type: 15 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kan/api exec vitest run src/routers/user-discord.test.ts`
Expected: FAIL — `listChannels` output has no `type` / calls `getTextChannels`.

- [ ] **Step 3: Update `listChannels`**

In `packages/api/src/routers/discord.ts`, in `listChannels`:
- Change the output schema to:

```ts
.output(
  z.array(
    z.object({ id: z.string(), name: z.string(), type: z.number() }),
  ),
)
```

- Replace the fetch + return with:

```ts
const channels = await discordClient.getPostableChannels(connection.guildId);

if (!channels.success || !channels.data)
  throw new TRPCError({
    message: channels.error ?? "Failed to fetch Discord channels",
    code: "INTERNAL_SERVER_ERROR",
  });

return channels.data.map(({ id, name, type }) => ({ id, name, type }));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kan/api exec vitest run src/routers/user-discord.test.ts`
Expected: PASS.

- [ ] **Step 5: Show forum channels in the board picker**

In `BoardDiscordChannelModal.tsx`, change the channel `items` map (keep everything else):

```ts
...(channels ?? []).map((channel) => ({
  key: channel.id,
  value: channel.type === 15 ? `#${channel.name} (forum)` : `#${channel.name}`,
  selected: channel.id === channelId,
})),
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck` (expect pass).

```bash
git add packages/api/src/routers/discord.ts packages/api/src/routers/user-discord.test.ts apps/web/src/views/board/components/BoardDiscordChannelModal.tsx
git commit -m "feat(discord): surface forum channels in channel picker"
```

---

## Task 5: `notifyCardCreated` forum branch + tag mapping + move guard

**Files:**
- Modify: `packages/api/src/utils/discord.ts` (`notifyCardCreated` ~142-210, `notifyCardMoved` ~255-296; add `matchForumTags`)
- Test: `packages/api/src/utils/discord.test.ts` (matchForumTags)
- Create: `packages/api/src/utils/discord-forum.test.ts` (notifyCardCreated branch)

**Interfaces:**
- Consumes: `getChannel`, `createForumPost`, `CHANNEL_TYPE_FORUM`, `FORUM_FLAG_REQUIRE_TAG` (Task 3)
- Produces: `matchForumTags(labelNames: string[], availableTags: {id:string;name:string}[], flags: number): string[]`

- [ ] **Step 1: Write failing `matchForumTags` tests**

Append to `discord.test.ts` (it already imports from `./discord`; add `matchForumTags` to the import):

```ts
describe("matchForumTags", () => {
  const tags = [
    { id: "t1", name: "Bug" },
    { id: "t2", name: "Feature" },
  ];

  it("matches label names case-insensitively", () => {
    expect(matchForumTags(["bug"], tags, 0)).toEqual(["t1"]);
  });

  it("returns [] when no label matches and tags are optional", () => {
    expect(matchForumTags(["chore"], tags, 0)).toEqual([]);
  });

  it("falls back to the first tag when the forum requires a tag", () => {
    expect(matchForumTags(["chore"], tags, 16)).toEqual(["t1"]);
  });

  it("caps at 5 tags", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: `t${i}`,
      name: `L${i}`,
    }));
    const labels = many.map((t) => t.name);
    expect(matchForumTags(labels, many, 0)).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kan/api exec vitest run src/utils/discord.test.ts`
Expected: FAIL — `matchForumTags` not defined.

- [ ] **Step 3: Implement `matchForumTags`**

Add to `packages/api/src/utils/discord.ts` (import the flag: it's referenced via `discordClient.FORUM_FLAG_REQUIRE_TAG`):

```ts
/** Maps card label names to a forum's tag ids (case-insensitive), max 5. */
export const matchForumTags = (
  labelNames: string[],
  availableTags: { id: string; name: string }[],
  flags: number,
): string[] => {
  const wanted = new Set(labelNames.map((n) => n.trim().toLowerCase()));
  const matched = availableTags
    .filter((t) => wanted.has(t.name.trim().toLowerCase()))
    .map((t) => t.id)
    .slice(0, 5);
  // Forums with REQUIRE_TAG reject a post with no tag — fall back to the first.
  if (
    matched.length === 0 &&
    (flags & discordClient.FORUM_FLAG_REQUIRE_TAG) !== 0 &&
    availableTags[0]
  ) {
    return [availableTags[0].id];
  }
  return matched;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kan/api exec vitest run src/utils/discord.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing `notifyCardCreated` branch test**

Create `packages/api/src/utils/discord-forum.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { dbClient } from "@kan/db/client";
import * as discordRepo from "@kan/db/repository/discord.repo";
import * as discordClient from "@kan/discord";

import { notifyCardCreated } from "./discord";

vi.mock("@kan/db/repository/discord.repo", () => ({
  getByWorkspaceId: vi.fn(() => Promise.resolve({ id: 1 })),
  setCardDiscordThreadId: vi.fn(),
  setCardDiscordMessageId: vi.fn(),
}));
vi.mock("@kan/db/repository/card.repo", () => ({}));
vi.mock("@kan/discord", async (importActual) => {
  const actual = await importActual<typeof import("@kan/discord")>();
  return {
    ...actual,
    getChannel: vi.fn(),
    createThread: vi.fn(),
    createForumPost: vi.fn(),
    postMessage: vi.fn(() => Promise.resolve({ success: true, data: { id: "m1" } })),
  };
});

const db = {} as dbClient;
const base = {
  cardId: 10,
  cardPublicId: "card_00000001",
  cardTitle: "Ship it",
  boardName: "Roadmap",
  workspaceId: 1,
  discordBehaviour: "create_thread",
  discordRoleIds: null,
  labelNames: ["Bug"],
};

beforeEach(() => vi.clearAllMocks());

it("creates a forum post (not a thread) when the channel is a forum", async () => {
  (discordClient.getChannel as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
    data: {
      id: "chan1",
      type: 15,
      flags: 0,
      availableTags: [{ id: "t1", name: "Bug" }],
    },
  });
  (discordClient.createForumPost as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
    data: { id: "post1" },
  });

  await notifyCardCreated(db, { ...base, discordChannelId: "chan1" });

  expect(discordClient.createForumPost).toHaveBeenCalledWith(
    "chan1",
    "Ship it - 📋 Roadmap",
    expect.objectContaining({ appliedTagIds: ["t1"] }),
  );
  expect(discordClient.createThread).not.toHaveBeenCalled();
  expect(discordRepo.setCardDiscordThreadId).toHaveBeenCalledWith(db, 10, "post1");
  expect(discordRepo.setCardDiscordMessageId).toHaveBeenCalledWith(db, 10, "post1");
});

it("creates a thread + message when the channel is a text channel", async () => {
  (discordClient.getChannel as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
    data: { id: "chan1", type: 0, flags: 0, availableTags: [] },
  });
  (discordClient.createThread as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
    data: { id: "thread1" },
  });

  await notifyCardCreated(db, { ...base, discordChannelId: "chan1" });

  expect(discordClient.createThread).toHaveBeenCalled();
  expect(discordClient.createForumPost).not.toHaveBeenCalled();
  expect(discordRepo.setCardDiscordThreadId).toHaveBeenCalledWith(db, 10, "thread1");
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @kan/api exec vitest run src/utils/discord-forum.test.ts`
Expected: FAIL — `notifyCardCreated` doesn't branch on channel type yet.

- [ ] **Step 7: Add the forum branch to `notifyCardCreated`**

In `packages/api/src/utils/discord.ts`, replace the body of `notifyCardCreated`'s `try` block (from the `create_thread` guard through the message-id store) with:

```ts
if (args.discordBehaviour !== "create_thread" || !args.discordChannelId)
  return;

const connection = await discordRepo.getByWorkspaceId(db, args.workspaceId);
if (!connection) return;

const roleIds = parseRoleIds(args.discordRoleIds);
const mentions = discordClient.buildRoleMentions(roleIds);
const embed = buildCardEmbed(args);
const threadName = `${args.cardTitle} - 📋 ${args.boardName}`;

const channel = await discordClient.getChannel(args.discordChannelId);

if (
  channel.success &&
  channel.data?.type === discordClient.CHANNEL_TYPE_FORUM
) {
  const appliedTagIds = matchForumTags(
    args.labelNames ?? [],
    channel.data.availableTags,
    channel.data.flags,
  );
  const post = await discordClient.createForumPost(
    args.discordChannelId,
    threadName,
    { content: mentions, embeds: [embed], mentionRoleIds: roleIds, appliedTagIds },
  );
  if (!post.success || !post.data) {
    log.error(
      { error: post.error, cardId: args.cardId },
      "Failed to create Discord forum post",
    );
    return;
  }
  // A forum post's starter message id equals the thread id.
  await discordRepo.setCardDiscordThreadId(db, args.cardId, post.data.id);
  await discordRepo.setCardDiscordMessageId(db, args.cardId, post.data.id);
  return;
}

const thread = await discordClient.createThread(
  args.discordChannelId,
  threadName,
);
if (!thread.success || !thread.data) {
  log.error(
    { error: thread.error, cardId: args.cardId },
    "Failed to create Discord thread",
  );
  return;
}

await discordRepo.setCardDiscordThreadId(db, args.cardId, thread.data.id);

const message = await discordClient.postMessage(
  thread.data.id,
  mentions,
  roleIds,
  [embed],
);
if (!message.success || !message.data) {
  log.error(
    { error: message.error, cardId: args.cardId },
    "Failed to post Discord thread message",
  );
  return;
}

await discordRepo.setCardDiscordMessageId(db, args.cardId, message.data.id);
```

- [ ] **Step 8: Add the forum guard to `notifyCardMoved`**

In `notifyCardMoved`, replace the fallback block:

```ts
let targetId = args.cardDiscordThreadId ?? null;
if (!targetId) {
  const boardChannelId = await discordRepo.getBoardDiscordChannelId(
    db,
    args.newListBoardId,
  );
  if (boardChannelId) {
    const channel = await discordClient.getChannel(boardChannelId);
    // Forum channels don't accept direct messages (only posts) — skip fallback.
    if (
      channel.success &&
      channel.data?.type === discordClient.CHANNEL_TYPE_FORUM
    ) {
      return;
    }
    targetId = boardChannelId;
  }
}
if (!targetId) return;
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm --filter @kan/api exec vitest run src/utils/discord-forum.test.ts src/utils/discord.test.ts`
Expected: PASS.

- [ ] **Step 10: Full Discord regression + typecheck**

Run: `pnpm --filter @kan/api exec vitest run src/utils/discord.test.ts src/utils/discordMentions.test.ts src/routers/user-discord.test.ts src/utils/discord-forum.test.ts`
Run: `pnpm --filter @kan/discord exec vitest run src/index.test.ts`
Run: `pnpm --filter @kan/web exec vitest run src/pages/api/cron/due-reminders.test.ts`
Run: `pnpm typecheck`
Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/api/src/utils/discord.ts packages/api/src/utils/discord.test.ts packages/api/src/utils/discord-forum.test.ts
git commit -m "feat(discord): create forum posts for cards in forum-linked boards"
```

---

## Self-Review notes

- **Spec coverage:** Part 1 → Task 1; Part 2 → Task 2; Part 3 (`@kan/discord`) → Task 3, (`listChannels`+UI) → Task 4, (`notifyCardCreated` forum + tags + `notifyCardMoved` guard) → Task 5. All covered.
- **Type consistency:** `getPostableChannels`, `getChannel` (`availableTags`/`flags`), `createForumPost` opts, `matchForumTags`, `CHANNEL_TYPE_FORUM`/`FORUM_FLAG_REQUIRE_TAG` used identically across Tasks 3–5.
- **Known limitation (documented in spec):** forum posts with `REQUIRE_TAG` and no label match get the first available tag; media channels (type 16) unsupported.
- **Non-obvious:** forum starter message id == thread id, so `notifyCardUpdated`/due-reminders/pings need no change.
