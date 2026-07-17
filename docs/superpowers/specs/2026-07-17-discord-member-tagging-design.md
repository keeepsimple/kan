# Discord Member Tagging — Design Spec

**Date:** 2026-07-17
**Status:** Approved (design), pending implementation plan
**Branch:** `feat/discord-member-tagging`

## Goal

Let Kan @mention (tag) the real Discord user behind a Kan workspace member, so Discord notifications actually ping the right person. Tags fire in three places: when a member is **assigned** to a card, when a member is **@mentioned in a comment**, and in **due reminders** (ping the card's assignees).

## Background — current state (what already exists)

- **`packages/discord/`** — a single-file, dependency-free client talking to Discord via **bot token + REST API v10** (`Authorization: Bot ${DISCORD_BOT_TOKEN}`). Exports `postMessage(channelOrThreadId, content, mentionRoleIds = [], embeds = [])`, `createThread`, `editMessage`, `getGuild/getTextChannels/getRoles`, `buildRoleMentions(roleIds)` → `<@&ROLE_ID>`. **Only role mentions exist today**; `postMessage` hard-codes `allowed_mentions = { parse: [], roles: mentionRoleIds }` (`packages/discord/src/index.ts:146`), which actively suppresses user mentions.
- **Discord ↔ card wiring** — `packages/api/src/utils/discord.ts`: `notifyCardCreated` (fires only if `list.discordBehaviour === "create_thread"`, creates a thread in `board.discordChannelId`, stores `card.discordThreadId`/`discordMessageId`), `notifyCardUpdated` (re-renders/PATCHes the thread's first embed), `notifyCardMoved`. `routers/discord.ts` exposes `getStatus/connect/disconnect/listChannels/listRoles` (workspace-scoped, permission-gated). Due reminders live in the cron `apps/web/src/pages/api/cron/due-reminders.ts` (calls `postMessage` directly into `card.discordThreadId`, **no user/role targeting**, `mentionRoleIds = []`).
- **Config storage** — `workspace_discord` table holds one `guildId` per workspace (`packages/db/src/schema/discord.ts`). `board.discordChannelId`, `list.discordBehaviour`/`list.discordRoleIds`, `card.discordThreadId`/`discordMessageId`. **No per-member/per-user Discord mapping exists anywhere.**
- **Member / user model** — `user` (`packages/db/src/schema/users.ts`) has no Discord field. `workspace_members` (`packages/db/src/schema/workspaces.ts`) has nullable `userId` (null = invited-but-not-registered), `email`, `status`. Card assignees live in the `_card_workspace_members` join table (`cardToWorkspaceMembers`).
- **Comment @mentions already exist as data** — the editor emits `<span data-type="mention" data-id="{memberPublicId}">`, parsed by `parseMentionsFromHTML` (`packages/shared/src/utils/mentions.ts`) and consumed by `sendMentionEmails` (`packages/api/src/utils/notifications.ts`), called from card create-with-description and `addComment`. **This currently only sends email — never touches Discord.**
- **Better Auth `account` table** (`packages/db/src/schema/auth.ts`) — Discord is a built-in Better Auth social provider; Kan auto-enables it when `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` are set (`packages/auth/src/providers.ts`). When a user logs in with Discord, Better Auth writes `account.providerId = "discord"` and `account.accountId = the user's Discord snowflake`. This is the "free" mapping source for the auto path. (This OAuth app is distinct from the bot app; both see the same global user snowflake.)

## Design

### 1. Data model — mapping lives on `user`

A Discord identity is **global to a person**, so store it once per user (not per workspace member).

Add two nullable columns to the `user` table (`packages/db/src/schema/users.ts`) + a Drizzle migration:
- `discordUserId varchar(32)` — the Discord snowflake (the value used to build `<@id>`).
- `discordUsername varchar(64)` — cached handle for display in Settings (not used for tagging).

**Rationale / trade-offs:**
- Per-user (not per-`workspace_members`): the snowflake is global; the auto-from-login source is per-user; avoids re-linking in every workspace.
- Consequence: an invited member whose `workspace_members.userId` is `null` (not yet registered) cannot be mapped until they create an account. Accepted.
- Rejected alternatives: (a) read only from the `account` table — free but excludes manual linking and non-Discord-login users; (b) store on `workspace_members` — scopes to the guild but forces re-linking per workspace and duplicates the per-user auto value.

At tag time there is a **single read path**: `user.discordUserId`.

### 2. Populating the mapping (combo: auto + manual fallback)

**Auto (zero-touch for Discord-login users):** add a Better Auth `databaseHooks.account` hook in `packages/auth` (the config already wires `databaseHooks: createDatabaseHooks(db)`). On account create/update where `providerId === "discord"`, copy `account.accountId` → `user.discordUserId` and the profile handle → `user.discordUsername`. Requires Discord OAuth to be enabled (`DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`).

**Manual fallback (self-service, in Settings):** a "Discord" section where the signed-in user links their own account, via either:
- **Pick from server members** — new tRPC procedure calls a new `@kan/discord` `searchGuildMembers(guildId, query)` against the workspace's `workspace_discord.guildId`; user picks their account from the results; store snowflake + handle. (Requires the bot's **GUILD_MEMBERS** privileged intent.)
- **Paste Discord user ID** — user pastes their snowflake directly (with Developer Mode → Copy ID); basic validation (numeric, length).
- **Unlink** — clears both columns.

New tRPC procedures on a `user`/`member` router (protected, self-scoped — a user may only link/unlink their OWN mapping): `linkDiscord`, `unlinkDiscord`, `searchWorkspaceDiscordMembers` (workspace-scoped, `board:view`/member permission). Include `.meta({ openapi })` + zod input/output per repo convention. All DB access via a repo (`user.repo.ts` / a new `discordMapping.repo.ts`).

### 3. `@kan/discord` — user-mention capability

- `buildUserMentions(userIds: string[]): string` → `userIds.map(id => \`<@${id}>\`).join(" ")` (mirrors existing `buildRoleMentions`).
- Extend `postMessage(channelOrThreadId, content, mentionRoleIds = [], embeds = [], mentionUserIds = [])`: add `users: mentionUserIds` to `allowed_mentions` (append a param; keep existing call sites working by defaulting to `[]`).
- `searchGuildMembers(guildId, query)` → `DiscordResult<Array<{ id, username, displayName }>>` via `GET /guilds/{guildId}/members/search?query=` (or paginated list) — for the Settings dropdown. Needs GUILD_MEMBERS intent.

### 4. Three tag hook points (all fire-and-forget, best-effort, never fail/slow a mutation)

Each hook resolves member(s) → `user.discordUserId`, skips anyone unlinked, and only posts if the card has a Discord thread (`card.discordThreadId`) — otherwise there is nowhere authorized to ping.

- **Assign** — in `card.ts` `addOrRemoveMember` (only on the **add** branch) and card-create-with-members: post a short ping into the card's thread: `<@discordId> you were assigned to «card title»` + link. No ping on remove.
- **Comment @mention** — in `card.ts` `addComment`/`updateComment`: reuse `parseMentionsFromHTML` → `workspace_members` → `user.discordUserId`; if any mention resolves and the card has a thread, post a short ping: `<@discordId> mentioned by «author» in «card title»` + short excerpt + link. (Per decision: **only** when a comment contains a mention; never mirror plain comments.)
- **Due reminder** — in `apps/web/src/pages/api/cron/due-reminders.ts`: load the card's assignees (`_card_workspace_members`) → their `discordUserId`s → pass as `mentionUserIds` to `postMessage`.

All three wrap Discord calls in `.catch` (existing pattern: Discord notifies are already fire-and-forget). Members without a linked Discord ID are silently skipped.

### 5. Error handling & correctness

- Fire-and-forget everywhere; a Discord/mapping failure must never fail or slow the originating mutation or the cron batch.
- A tag only actually pings if the mapped user is a **member of the guild the message posts into**. The "pick from server" path guarantees this by construction; auto-OAuth and paste-ID do not. Optional (later): verify membership via the bot (`GET /guilds/{guildId}/members/{userId}`) at link time and warn — do not block.
- `allowed_mentions.users` must list exactly the ids we intend to ping (Discord suppresses mentions not in `allowed_mentions`), preventing accidental @everyone/stray pings.

### 6. Testing strategy

- `@kan/discord`: unit-test `buildUserMentions` and `postMessage`'s `allowed_mentions.users` assembly (mock `fetch`).
- Repo + tRPC: link/unlink writes the right columns; self-scoping (a user cannot link someone else's mapping); search is permission-gated.
- Tag hooks (`packages/api`): with mocked repos + mocked `@kan/discord`, assert the correct `mentionUserIds` are passed for assign / comment-mention / due-reminder, that unlinked members are skipped, and that a Discord failure does not throw into the mutation.
- Auth hook: account create with `providerId="discord"` populates `user.discordUserId`.
- Manual E2E (like the SSE feature): real bot + guild, link a member, assign/comment/due-remind, confirm a real ping in Discord.

### 7. Prerequisites (operator config, outside code)

- Enable the bot's **GUILD_MEMBERS** privileged intent (Discord dev portal) — required for "pick from server".
- For auto-linking: create a Discord OAuth app and set `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` (register in `turbo.json` `globalEnv` if new).
- Each member must be in the connected Discord server for the tag to ping.

## Build order

- **Phase 1 — mapping infrastructure:** schema + migration, auth `account` databaseHook, `@kan/discord` helpers (`buildUserMentions`, `postMessage` param, `searchGuildMembers`), repo + tRPC procedures, Settings UI (auto status + pick-from-server + paste + unlink).
- **Phase 2 — enable tags:** wire the three hook points (assign, comment @mention, due reminder).

## Non-goals (v1)

- No per-user opt-out toggle — not linking a Discord account is itself the opt-out.
- No admin-maps-others flow — linking is self-service only.
- No real-time guild-membership re-verification on every tag (best-effort ping; optional warn-at-link-time only).
- No syncing of Discord display name/avatar into Kan beyond the cached handle.
- No change to the existing role-mention behaviour (`list.discordRoleIds`).
