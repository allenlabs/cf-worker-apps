import { describe, expect, it } from "vitest";
import {
  mentionsAssistant,
  mentionsAgent,
  shouldAssistantReply,
  resolveTargetAgent,
  toChatMessages,
  type Agent,
  type RoomMessage,
} from "../src/index";

const agent = (id: string, name: string): Pick<Agent, "id" | "name"> => ({ id, name });

describe("mentionsAssistant", () => {
  it("matches @assistant / @ai case-insensitively at word start", () => {
    expect(mentionsAssistant("hey @assistant help")).toBe(true);
    expect(mentionsAssistant("@AI go")).toBe(true);
    expect(mentionsAssistant("email me@ai.com")).toBe(false);
    expect(mentionsAssistant("no mention")).toBe(false);
  });
});

describe("mentionsAgent", () => {
  it("matches the agent name, tolerating spaces", () => {
    expect(mentionsAgent("ask @Support now", { name: "Support" })).toBe(true);
    expect(mentionsAgent("@data-bot?", { name: "data-bot" })).toBe(true);
    expect(mentionsAgent("hi @Data Bot", { name: "Data Bot" })).toBe(true);
    expect(mentionsAgent("nothing", { name: "Support" })).toBe(false);
  });
});

describe("shouldAssistantReply", () => {
  it("always mode replies to everything", () => {
    expect(shouldAssistantReply({ aiMode: "always" }, "anything")).toBe(true);
  });
  it("off mode never replies", () => {
    expect(shouldAssistantReply({ aiMode: "off" }, "@assistant")).toBe(false);
  });
  it("mention mode replies on @assistant or an agent mention", () => {
    expect(shouldAssistantReply({ aiMode: "mention" }, "@assistant hi")).toBe(true);
    expect(shouldAssistantReply({ aiMode: "mention" }, "@Support hi", [agent("a1", "Support")])).toBe(true);
    expect(shouldAssistantReply({ aiMode: "mention" }, "just chatting", [agent("a1", "Support")])).toBe(false);
  });
});

describe("resolveTargetAgent", () => {
  const agents = [agent("a1", "Support"), agent("a2", "Researcher")];
  it("prefers a directly mentioned agent", () => {
    expect(resolveTargetAgent(agents, "@Researcher ping", "a1")?.id).toBe("a2");
  });
  it("falls back to the default agent", () => {
    expect(resolveTargetAgent(agents, "no mention", "a1")?.id).toBe("a1");
  });
  it("returns null with no mention and no default", () => {
    expect(resolveTargetAgent(agents, "no mention", null)).toBeNull();
  });
  it("returns null when the default id is unknown", () => {
    expect(resolveTargetAgent(agents, "no mention", "missing")).toBeNull();
  });
});

describe("toChatMessages", () => {
  it("prefixes human names, passes assistant through, drops system", () => {
    const msgs: RoomMessage[] = [
      { seq: 1, senderType: "user", senderName: "Alice", text: "hi" },
      { seq: 2, senderType: "assistant", senderName: "Bot", text: "hello" },
      { seq: 3, senderType: "system", senderName: null, text: "notice" },
      { seq: 4, senderType: "user", senderName: null, text: "anon" },
    ];
    const out = toChatMessages(msgs, "SYS");
    expect(out).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "Alice: hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "anon" },
    ]);
  });
});
