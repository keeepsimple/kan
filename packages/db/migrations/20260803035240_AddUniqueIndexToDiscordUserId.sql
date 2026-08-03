-- Clear duplicate Discord mappings (keep the earliest-created owner per id) so
-- the unique index below can be created on databases that predate the
-- uniqueness guarantee (the paste-ID link path formerly allowed duplicates).
UPDATE "user" AS u
SET "discordUserId" = NULL, "discordUsername" = NULL
WHERE "discordUserId" IS NOT NULL
  AND "id" <> (
    SELECT u2."id" FROM "user" AS u2
    WHERE u2."discordUserId" = u."discordUserId"
    ORDER BY u2."createdAt" ASC, u2."id" ASC
    LIMIT 1
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_discord_user_id_unique" ON "user" USING btree ("discordUserId") WHERE "user"."discordUserId" IS NOT NULL;
