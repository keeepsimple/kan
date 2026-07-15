# Crisp → Kan Card Integration — Design

**Date:** 2026-07-15
**Status:** Approved

## Goal

Let a Crisp operator create a Kan card from inside a Crisp conversation by
writing a private note starting with `#card`. The card lands in a
workspace-designated board/list. Configured per workspace in Kan's
Settings → Integrations page.

## Decisions made

- **Full in-app integration** (Settings UI + DB), not an external middleware.
- **Trigger:** operator private note with prefix `#card ` (invisible to the
  visitor). Operators can create a Crisp shortcut `!card` for fast typing.
- **Card content:** title = first line after the prefix; description =
  remaining lines + link to the Crisp conversation + operator nickname.
  No reply back to Crisp (no Crisp API token required). Out of scope for v1:
  posting the card link back, per-command board routing, status sync.

## Crisp facts (verified against docs.crisp.chat)

- Operator messages/notes arrive as webhook event `message:received`;
  private notes have `type: "note"`, `from: "operator"`.
- Payload includes `website_id`, `session_id`, `content`, `type`, `from`,
  `user.nickname`.
- Website-level webhooks are configured in the Crisp dashboard and are
  **unsigned** (no HMAC) → authentication is a random secret embedded in the
  webhook URL (Slack-incoming-webhook pattern).
- Any 2xx response marks delivery successful; non-2xx triggers retries.
- Conversation URL format:
  `https://app.crisp.chat/website/{website_id}/inbox/{session_id}/`

## Architecture

### 1. Database — new table `crisp_integrations`

Follows the `workspace_webhooks` schema style
(`packages/db/src/schema/webhooks.ts`):

| column           | type                                            |
| ---------------- | ----------------------------------------------- |
| `id`             | bigserial PK                                    |
| `publicId`       | varchar(12) unique                              |
| `workspaceId`    | bigint FK → workspaces, cascade, **unique**     |
| `crispWebsiteId` | varchar(255)                                    |
| `listId`         | bigint FK → lists, cascade (board derived)      |
| `webhookSecret`  | text (random 32 bytes, URL-safe)                |
| `createdBy`      | uuid FK → users (used as card creator)          |
| `active`         | boolean default true                            |
| `createdAt` / `updatedAt` | timestamps                             |

One Crisp connection per workspace (unique `workspaceId`). Command prefix is
fixed to `#card` (make configurable later only if requested). Deleting the
target list cascades and removes the integration. New repo file
`packages/db/src/repository/crispIntegration.repo.ts` + drizzle migration.

### 2. Webhook endpoint — `apps/web/src/pages/api/integrations/crisp/[token].ts`

1. Look up active integration by `token`; unknown token → 404.
2. Ignore (200) anything that is not `message:received` with `type: "note"`,
   `from: "operator"`, and `website_id` equal to the stored
   `crispWebsiteId`.
3. Note content must start with `#card ` (after trim); otherwise ignore (200).
   A note with an empty title after the prefix is also ignored (200).
4. Parse: first line after prefix → title (truncate to 2000 chars, the API
   limit); remaining lines + conversation link + operator nickname → description.
5. Create the card via `cardRepo.create` with
   `createdBy = integration.createdBy`, `listId`, `workspaceId`,
   `position: "end"`.
6. Fire outgoing workspace webhooks (`card.created`) via the same
   `createCardWebhookPayload` / `sendWebhooksForWorkspace` utilities the card
   router uses, so existing outbound webhooks stay consistent.
7. Return 200 on success; 500 on unexpected failure (lets Crisp retry).

### 3. API — new tRPC router `crispIntegration`

Procedures (workspace-admin permission checks, following the existing webhook
router pattern):

- `get({ workspacePublicId })` → connection status, webhook URL, target
  board/list names.
- `create({ workspacePublicId, crispWebsiteId, listPublicId })` → generates
  secret, returns webhook URL.
- `disconnect({ workspacePublicId })` → deletes the row.

Internal only (no OpenAPI exposure needed for v1).

### 4. Settings UI — new "Crisp" section in `IntegrationsSettings.tsx`

- **Not connected:** form with Crisp Website ID input + Board select →
  List select (existing board/list tRPC queries) → "Connect Crisp".
- **Connected:** shows the webhook URL with copy button, target board/list,
  setup instructions (paste URL in Crisp dashboard → Settings → Web Hooks,
  enable message events; optionally create a `!card` shortcut), and a
  Disconnect button.
- All strings via lingui `` t`...` `` macros; run lingui extract afterwards.

## Error handling

- Wrong/missing token → 404, no information leak.
- Non-matching events / prefix → silent 200 (prevents Crisp retry storms).
- Card creation failure → 500 + server log (existing logger package).
- Payload `website_id` mismatch → ignored 200.

## Testing

- One small handler test: rejects bad token, ignores non-note events, parses
  `#card` note into title/description, creates card in the configured list.
- Manual end-to-end check against a real Crisp site (paste webhook URL, send
  a `#card` note, verify the card appears).
