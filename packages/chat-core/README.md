# @allenlabs/chat-core

Framework-agnostic core for a **multiplayer AI chat + agents** platform — the
open-source heart of a "Claude Tag"-style product: shared rooms where people
collaborate and named AI agents answer on mention or always.

MIT-licensed. Model-agnostic by design: bring your own **OpenAI-compatible**
chat provider (OpenAI, a self-hosted gateway, etc.). This package contains no
credentials and no ChatGPT-subscription proxy — those stay in your private
deployment.

## What's here

- **`ChatProvider`** (`provider.ts`) — the pluggable, OpenAI-compatible backend
  interface (`chat(request) → Response`, JSON or SSE). Implement it over any
  model backend.
- **Room + agent domain** (`rooms.ts`) — portable types (`Room`, `Agent`,
  `RoomMember`, `RoomMessage`, `McpServer`) plus pure logic:
  - `shouldAssistantReply(room, text, agents)` — `off` / `mention` (`@assistant`
    or `@agent`) / `always` gating.
  - `resolveTargetAgent(agents, text, defaultAgentId)` — mention wins, else the
    room default, else generic.
  - `mentionsAssistant`, `mentionsAgent`, `toChatMessages` (group transcript →
    OpenAI messages, prefixing human names).

All pure — no storage or network — so it drops into any runtime (Cloudflare
Workers/Durable Objects, Node, etc.) and is fully unit-tested.

## Concept

- A **room** is the unit of conversation: 1 member = a personal AI chat, many
  members = a group ("톡방"). `kind` = `dm | group | org`.
- An **agent** is a named assistant identity (persona + model + reasoning
  effort + skills + MCP servers). Address it in a room with `@name`.
- The assistant replies per the room's **`aiMode`**.

Wire these into your own storage (rooms/messages/members), transport (SSE), and
a `ChatProvider`, and you have the platform. The reference deployment adds
Durable Object rooms, org agents, an OpenAI-compatible provider endpoint, and
credential pooling on top.

## Use

```ts
import {
  shouldAssistantReply,
  resolveTargetAgent,
  toChatMessages,
  type ChatProvider,
} from "@allenlabs/chat-core";
```

```bash
npm run typecheck && npm run test
```
