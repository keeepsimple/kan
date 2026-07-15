import { describe, expect, it } from "vitest";

import { buildCardDescription, parseCardCommand } from "./crisp";

describe("parseCardCommand", () => {
  it("returns null when content does not start with #card", () => {
    expect(parseCardCommand("hello world")).toBeNull();
    expect(parseCardCommand("please #card do thing")).toBeNull();
  });

  it("returns null for a bare #card with no title", () => {
    expect(parseCardCommand("#card")).toBeNull();
    expect(parseCardCommand("#card    ")).toBeNull();
  });

  it("extracts a single-line title with empty body", () => {
    expect(parseCardCommand("#card Fix login bug")).toEqual({
      title: "Fix login bug",
      body: "",
    });
  });

  it("trims surrounding whitespace before matching the prefix", () => {
    expect(parseCardCommand("  #card Fix login bug  ")).toEqual({
      title: "Fix login bug",
      body: "",
    });
  });

  it("uses the first line as title and the rest as body", () => {
    expect(
      parseCardCommand("#card Fix login bug\nUser cannot sign in\nwith SSO"),
    ).toEqual({
      title: "Fix login bug",
      body: "User cannot sign in\nwith SSO",
    });
  });

  it("truncates the title at 2000 characters", () => {
    const result = parseCardCommand(`#card ${"a".repeat(3000)}`);
    expect(result?.title).toHaveLength(2000);
  });
});

describe("buildCardDescription", () => {
  it("includes the conversation link", () => {
    const description = buildCardDescription({
      body: "",
      websiteId: "site-1",
      sessionId: "session_abc",
    });
    expect(description).toContain(
      "https://app.crisp.chat/website/site-1/inbox/session_abc/",
    );
  });

  it("includes body and operator nickname when provided", () => {
    const description = buildCardDescription({
      body: "Steps to reproduce",
      websiteId: "site-1",
      sessionId: "session_abc",
      operatorNickname: "Jane",
    });
    expect(description).toContain("Steps to reproduce");
    expect(description).toContain("Jane");
  });

  it("caps the description at 10000 characters", () => {
    const description = buildCardDescription({
      body: "x".repeat(20000),
      websiteId: "site-1",
      sessionId: "session_abc",
    });
    expect(description.length).toBeLessThanOrEqual(10000);
  });
});
