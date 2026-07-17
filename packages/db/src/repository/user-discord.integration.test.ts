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
