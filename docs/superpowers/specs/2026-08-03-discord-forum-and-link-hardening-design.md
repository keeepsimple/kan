# Discord: forum support + link hardening — design

Date: 2026-08-03
Branch: `feat/discord-forum-and-link-hardening`

## Context

The Discord integration (commits `dc0c684`…`b90a022`) lets a workspace connect a
Discord guild, link a board to a **text channel**, and have cards in a
`create_thread` list spawn a public thread (type 11) with a synced embed. Later
features ping assignees / comment @mentions and post due reminders into that
thread.

A prior review surfaced two defects and the user requested a new capability:

- **#1** Manual "paste Discord ID" link (`user.linkDiscord`) has no ownership
  proof and `users.discordUserId` has no uniqueness — a Discord ID can be claimed
  by multiple Kan users, misdirecting pings.
- **#2** `card.updateComment` re-pings every mentioned user on every edit
  (no dedup, unlike the email path) and never excludes the comment author.
- **Feature** Support linking a board to a Discord **forum channel** (type 15),
  so cards become forum posts.

Decisions taken during brainstorming:
- Fix #1 via **partial unique index + keep the paste path** (block cross-user
  claims with a clear error).
- Forum posts **map card labels → forum tags**.
- Do **not** persist channel type on the board; fetch the channel at
  post-creation time (keeps tags fresh, no migration for the feature).

## Part 1 — Fix #1: prevent duplicate Discord IDs

**Schema (`packages/db/src/schema/users.ts`) + migration**
- Add a **partial unique index** on `discordUserId` where `discordUserId IS NOT NULL`.
  Multiple `NULL`s remain allowed; each non-null ID maps to exactly one user.

**Repository (`packages/db/src/repository/user.repo.ts`)**
- Add `getByDiscordUserId(db, discordUserId)` → the owning user (or undefined).

**Router (`packages/api/src/routers/user.ts` → `linkDiscord`)**
- Before `setDiscordMapping`, look up `getByDiscordUserId`.
  - If it resolves to a **different** user → throw `TRPCError { code: "CONFLICT" }`
    with message "This Discord account is already linked to another user."
  - If it resolves to the current user (or nobody) → proceed (idempotent).

**Auth hook (`packages/auth/src/hooks.ts` → `handleDiscordAccountLink`)**
- Already wrapped in try/catch. If the unique index rejects (the OAuth account's
  Discord ID was previously pasted by another user) → the existing `catch` logs
  and swallows; no crash. No behavioural change needed beyond confirming this.

**Tests (`packages/api/src/routers/user-discord.test.ts`)**
- Linking an ID already owned by another user → `CONFLICT`.
- Re-linking the same ID to the same user → success (idempotent).

## Part 2 — Fix #2: dedup comment-mention pings + exclude author

**`packages/api/src/utils/discordMentions.ts` → `notifyCommentMentions`**
- New optional params: `previousHtml?: string`, `authorUserId?: string`.
- Resolve mentions to ping as: `parse(commentHtml) − parse(previousHtml ?? "")`
  (only newly-added member publicIds).
- After resolving members, drop any whose `user.id === authorUserId`
  (parity with `sendMentionEmails`). Requires selecting `user.id` in
  `getByPublicIdsWithUsers` (already selected).

**`packages/api/src/routers/card.ts`**
- `addComment`: `notifyCommentMentions(db, cardPublicId, comment, authorName, { authorUserId: userId })`
  (no previousHtml → pings all new mentions except author).
- `updateComment`: pass `previousHtml: existingComment.comment` and
  `authorUserId: userId` → only newly-added mentions are pinged.

**Tests (`packages/api/src/utils/discordMentions.test.ts`)**
- Edit that adds no new mention → no ping.
- Edit that adds one new mention → only that user pinged.
- Self-mention by author → no ping.

## Part 3 — Feature: Discord forum channel support

A forum post **is** a thread, so once created, embed-sync / due-reminders /
mention & assignee pings all work unchanged via `discordThreadId` /
`discordMessageId`. Only the **creation** step differs.

**`packages/discord/src/index.ts`**
- `getPostableChannels(guildId)` — replaces `getTextChannels`; returns channels of
  **type 0 (text)** and **type 15 (forum)** as `{ id, name, type }`.
- `getChannel(channelId)` — `GET /channels/{id}` → `{ id, type, availableTags: {id,name}[], flags }`.
  Used to detect forum vs text and read `available_tags` / `REQUIRE_TAG` (flag `1<<4 = 16`).
- `createForumPost(forumId, name, { content, embeds, mentionRoleIds, mentionUserIds, appliedTagIds })`
  — `POST /channels/{forumId}/threads` with body
  `{ name, auto_archive_duration, applied_tags, message: { content, allowed_mentions, embeds } }`.
  The response's thread `id` == starter message id.

**`packages/api/src/utils/discord.ts` → `notifyCardCreated`**
- When `discordBehaviour === "create_thread"`, call `getChannel(discordChannelId)` once.
  - **type 15 (forum):**
    - Map `labelNames` → tag ids by case-insensitive name match against
      `availableTags` (cap 5). If the forum has `REQUIRE_TAG` and no label matched,
      fall back to the first available tag so creation succeeds.
    - `createForumPost(channelId, "<title> - 📋 <board>", { content: roleMentions, embeds: [embed], mentionRoleIds: roleIds, appliedTagIds })`.
    - Store `discordThreadId = thread.id` and `discordMessageId = thread.id`.
  - **else (text):** unchanged (`createThread` → `postMessage`).
- `htmlToDiscordMarkdown`, `buildCardEmbed`, role-mention logic reused as-is.

**`packages/api/src/utils/discord.ts` → `notifyCardMoved`**
- The no-thread fallback posts to the board channel. If that channel is a forum,
  a direct `postMessage` is invalid (forums accept posts, not messages). Guard:
  fetch the fallback channel type; if forum, skip and log. (Low-traffic edge:
  card created in a plain list, then moved into a `notify` list.)

**`packages/api/src/routers/discord.ts` → `listChannels`**
- Call `getPostableChannels`; output schema adds `type: number` (0 text, 15 forum).
  The web picker derives its "Forum" badge from `type === 15`.

**`apps/web/src/views/board/components/BoardDiscordChannelModal.tsx`**
- Render a "Forum" badge next to forum-type channels in the picker.

**No migration** for this part.

## Non-goals (YAGNI)
- Creating/managing forum tags from Kan (we only match existing ones by name).
- Media channels (type 16) — same mechanism, out of scope for now.
- Persisting channel type on the board.

## Testing strategy
- Unit: `createForumPost` request shape; forum branch of `notifyCardCreated`
  (mock `@kan/discord`); tag name-matching + require-tag fallback.
- Existing Discord suites (`discord.test.ts`, `discordMentions.test.ts`,
  `user-discord.test.ts`, `due-reminders.test.ts`) stay green.
- `pnpm typecheck` + targeted `vitest run`.

## Rollout / order
1. Part 1 (schema migration + link guard) — run migration, `@kan/api` tests.
2. Part 2 (mention dedup) — `@kan/api` tests.
3. Part 3 (forum) — `@kan/discord` + `@kan/api` tests, then web UI.
