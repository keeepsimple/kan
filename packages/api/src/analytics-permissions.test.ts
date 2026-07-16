import { describe, expect, it } from "vitest";

import { defaultRolePermissions, getDefaultPermissions } from "@kan/shared";

describe("analytics permissions", () => {
  it("grants admin both analytics permissions", () => {
    const admin = getDefaultPermissions("admin");
    expect(admin).toContain("analytics:view");
    expect(admin).toContain("analytics:view:all");
  });
  it("grants member only own-view analytics", () => {
    expect(defaultRolePermissions.member).toContain("analytics:view");
    expect(defaultRolePermissions.member).not.toContain("analytics:view:all");
  });
  it("grants guest no analytics", () => {
    expect(defaultRolePermissions.guest).not.toContain("analytics:view");
    expect(defaultRolePermissions.guest).not.toContain("analytics:view:all");
  });
});
