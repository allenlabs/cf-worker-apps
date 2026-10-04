// Framework-agnostic room + agent domain for a multiplayer AI chat ("Claude
// Tag"-style): a room is the unit of conversation (1 member = personal chat,
// many = group), an agent is a named assistant identity, and the assistant
// replies per the room's ai_mode. Pure logic only — no storage, no network — so
// it's portable across runtimes and fully unit-testable.

export type RoomKind = "dm" | "group" | "org";
export type RoomAiMode = "off" | "mention" | "always";
export type RoomRole = "owner" | "admin" | "member";
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

export interface Room {
  id: string;
  name: string;
  kind: RoomKind;
  orgId: string | null;
  ownerUserId: string;
  aiMode: RoomAiMode;
  /** Which agent answers in always-mode (org rooms); null = generic. */
  defaultAgentId: string | null;
}

export interface RoomMember {
  roomId: string;
  userId: string;
  role: RoomRole;
}

export interface McpServer {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface Agent {
  id: string;
  orgId: string;
  name: string;
  instructions: string;
  model: string;
  thinking: ThinkingLevel;
  skills: string[];
  mcpServers: McpServer[];
}

export interface RoomMessage {
  seq: number;
  senderType: "user" | "assistant" | "system";
  senderName: string | null;
  text: string;
}

/** True if the text addresses the generic assistant (@assistant / @ai). */
export function mentionsAssistant(text: string): boolean {
  return /(^|\s)@(assistant|ai)\b/i.test(text);
}

/** True if the text @mentions this agent by name (space-tolerant). */
export function mentionsAgent(text: string, agent: Pick<Agent, "name">): boolean {
  const slug = agent.name.trim().replace(/\s+/g, "[-_ ]?");
  return new RegExp(`(^|\\s)@${slug}\\b`, "i").test(text);
}

/** Should the assistant reply, given the room's ai_mode + any agent mentions? */
export function shouldAssistantReply(
  room: Pick<Room, "aiMode">,
  text: string,
  agents: readonly Pick<Agent, "name">[] = [],
): boolean {
  switch (room.aiMode) {
    case "always":
      return true;
    case "mention":
      return mentionsAssistant(text) || agents.some((a) => mentionsAgent(text, a));
    case "off":
    default:
      return false;
  }
}

/**
 * Resolve which agent answers: a directly @mentioned agent wins, else the
 * room's default agent, else null (generic assistant).
 */
export function resolveTargetAgent<A extends Pick<Agent, "id" | "name">>(
  agents: readonly A[],
  text: string,
  defaultAgentId: string | null,
): A | null {
  const mentioned = agents.find((a) => mentionsAgent(text, a));
  if (mentioned) return mentioned;
  if (defaultAgentId) return agents.find((a) => a.id === defaultAgentId) ?? null;
  return null;
}

/** Build OpenAI chat messages from a room transcript, prefixing human names. */
export function toChatMessages(
  messages: readonly RoomMessage[],
  systemPrompt: string,
): { role: "system" | "user" | "assistant"; content: string }[] {
  const out: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
  ];
  for (const m of messages) {
    if (m.senderType === "assistant") {
      out.push({ role: "assistant", content: m.text });
    } else if (m.senderType === "user") {
      out.push({ role: "user", content: m.senderName ? `${m.senderName}: ${m.text}` : m.text });
    }
    // system messages are not fed back to the model
  }
  return out;
}
