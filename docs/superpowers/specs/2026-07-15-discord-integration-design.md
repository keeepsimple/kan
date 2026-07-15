# Discord Integration — Design Spec

**Ngày:** 2026-07-15
**Trạng thái:** Chờ duyệt

## Mục tiêu

Tích hợp Discord vào Kan bằng **Discord Bot** (không dùng incoming webhook), đáp ứng 4 yêu cầu:

1. Workspace kết nối 1 Discord server (guild). Mỗi **Board** gắn với 1 **channel** của server đó — mọi thread của board được tạo trong channel này. Channel được chọn từ danh sách channel thật của server (bot liệt kê).
2. Mỗi **List** có một hành vi Discord (`discordBehavior`):
   - `create_thread` — tạo card trong list này ⇒ tạo thread trên Discord.
   - `notify` — **không cho tạo card trực tiếp** trong list này; khi **move card vào** ⇒ gửi message vào thread của card.
   - `null` (mặc định) — không làm gì.
3. Khi tạo thread, tag các **role** Discord đã cấu hình trên list (chọn từ danh sách role thật của server).
4. Message khi move card: `{card title} {board name} - {tên người update}`.

## Kiến trúc

### Package mới: `packages/discord` (`@kan/discord`)

Theo đúng khuôn `packages/stripe`: `src/index.ts`, không thêm dependency ngoài (gọi Discord REST API v10 bằng `fetch`). Bot token đọc từ env `DISCORD_BOT_TOKEN`.

Các hàm export:

| Hàm | Discord API | Dùng cho |
|---|---|---|
| `getGuild(guildId)` | `GET /guilds/{id}` | Verify khi connect |
| `getGuildChannels(guildId)` | `GET /guilds/{id}/channels` | Dropdown chọn channel (lọc text channel, type 0) |
| `getGuildRoles(guildId)` | `GET /guilds/{id}/roles` | Multi-select role cho list |
| `createThread(channelId, name)` | `POST /channels/{id}/threads` (public thread, type 11) | Tạo thread khi tạo card |
| `postMessage(channelOrThreadId, content, roleIds?)` | `POST /channels/{id}/messages` với `allowed_mentions.roles` | Message đầu thread (tag role) + message khi move card |

Lỗi từ Discord: trả về kết quả `{ success, error }`, log qua `@kan/logger` — **không bao giờ** làm fail thao tác card (cùng triết lý fire-and-forget của webhook hiện tại).

### Env mới

- `DISCORD_BOT_TOKEN` — token của bot.
- `DISCORD_BOT_CLIENT_ID` — để dựng link invite bot: `https://discord.com/oauth2/authorize?client_id={id}&scope=bot&permissions={perms}`.

(Không tái sử dụng `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` sẵn có — cặp đó đang phục vụ đăng nhập social qua Better Auth.)

Quyền bot tối thiểu: View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Mention Everyone (để tag được role không mentionable).

### DB (1 migration)

- Bảng mới `workspace_discord`: `id`, `workspaceId` (FK unique — 1 workspace : 1 guild), `guildId` varchar(32), `createdBy`, `createdAt`.
- `board` + cột `discordChannelId` varchar(32) nullable.
- `list` + cột `discordBehavior` varchar(16) nullable (`create_thread` | `notify`) và `discordRoleIds` text nullable (JSON array các role id).
- `card` + cột `discordThreadId` varchar(32) nullable.

### API (tRPC)

Router mới `discord` (theo khuôn `integration.ts`):

- `getStatus` — workspace đã connect chưa, tên guild.
- `connect({ workspacePublicId, guildId })` — verify bot truy cập được guild (`getGuild`) rồi lưu. Chỉ admin workspace.
- `disconnect({ workspacePublicId })` — xoá row `workspace_discord`. Các cột config trên board/list/card giữ nguyên nhưng trơ (không có guild thì không bắn gì).
- `listChannels({ workspacePublicId })`, `listRoles({ workspacePublicId })` — proxy qua bot.

Mở rộng router hiện có:

- `board.create` / `board.update`: nhận thêm `discordChannelId` (optional).
- `list.update`: nhận thêm `discordBehavior`, `discordRoleIds`.
- `card.create`: **guard** — nếu list đích có `discordBehavior === 'notify'` ⇒ `TRPCError BAD_REQUEST` ("Không thể tạo card trực tiếp trong list này").

### Điểm móc vào card router (cạnh 2 chỗ đang bắn webhook)

1. **Tạo card** ([card.ts:187](packages/api/src/routers/card.ts#L187)): nếu workspace có guild + board có `discordChannelId` + list là `create_thread` ⇒ `createThread(channelId, tên thread = card title)` → `postMessage(threadId, ...)` với message đầu thread: `{tag các role} {card title} — {board name}` → lưu `discordThreadId` vào card. Fire-and-forget.
2. **Move card** ([card.ts:1075](packages/api/src/routers/card.ts#L1075)): nếu `movedToNewList` và list đích là `notify` ⇒ gửi `{card.title} {boardName} - {user.name}`:
   - vào `card.discordThreadId` nếu có;
   - **fallback:** card chưa có thread (tạo ở list thường) ⇒ gửi vào channel của board.

### Frontend

- **Settings → Integrations** ([IntegrationsSettings.tsx](apps/web/src/views/settings/IntegrationsSettings.tsx)): mục Discord — nút mở link invite bot, ô nhập Server ID (guild ID), trạng thái connected + nút disconnect. (Lazy: dán guild ID + verify, không làm OAuth redirect flow.)
- **Board**: dropdown chọn channel trong [NewBoardForm.tsx](apps/web/src/views/boards/components/NewBoardForm.tsx) và trong menu board ([BoardDropdown.tsx](apps/web/src/views/board/components/BoardDropdown.tsx)) để đổi sau. Chỉ hiện khi workspace đã connect Discord.
- **List**: mục "Discord settings" trong context menu của list → modal chọn hành vi (Không / Tạo thread / Gửi message) + multi-select role (chỉ hiện khi chọn Tạo thread).
- **List `notify`**: ẩn nút thêm card ([List.tsx](apps/web/src/views/board/components/List.tsx) / NewCardForm entry) — server đã có guard nên UI chỉ là tiện dụng.
- i18n: chuỗi mới qua lingui như hiện tại.

## Xử lý lỗi

- Mọi lời gọi Discord đều fire-and-forget + log; thao tác card không bao giờ fail vì Discord.
- Connect verify guild trước khi lưu; guild ID sai hoặc bot chưa được invite ⇒ báo lỗi rõ ràng.
- Board đổi channel: thread cũ giữ nguyên chỗ cũ, thread mới tạo ở channel mới (không di dời).

## Kiểm thử

- Unit test cho `@kan/discord`: dựng payload đúng (tên thread, `allowed_mentions.roles`, nội dung message) — mock `fetch`.
- Test guard `card.create` với list `notify` (theo khuôn `webhook.test.ts`).

## Ngoài phạm vi (YAGNI)

- Sync ngược Discord → Kan (comment trong thread không tạo gì trong Kan).
- Nhiều guild cho 1 workspace; nhiều channel cho 1 board.
- Archive/xoá thread khi card bị xoá.
- Retry/queue cho message thất bại.
