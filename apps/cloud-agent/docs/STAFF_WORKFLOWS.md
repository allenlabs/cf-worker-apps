# Staff workflows in Pi

The runtime already supports approved, versioned SKILL.md files. Three reusable workflows use that registry rather than a second workflow engine.

| Skill | Staff outcome | Completion evidence |
| --- | --- | --- |
| announcement-review | Corrected notices and language/channel review table | Explicit review and approval; distribution remains separate |
| staff-request-triage | Device/system request state, next action and verification | User or measured confirmation; temporary remedy remains labeled |
| staff-handoff | Completed work, outstanding tasks, owners and deadlines | Source messages; missing facts remain unknown |

Publish a file from `skills/workflows/<name>/SKILL.md` in the management skill editor, then activate it. New executions pin the active skill revision through the existing manifest snapshot. Staff can request the workflow in ordinary language; editing or enabling skills remains an administrator action.

Source-history reads are bounded and report incomplete traversal. Skills must not invent approvals, owners, deadlines, tool executions or attachments they have not read. These workflows create a reply or draft in the pinned thread. They do not invite teammates, modify business records, purchase equipment, distribute notices or create external tickets.

Adapt language approval rules, status conventions and business templates only in a private organization skill revision. Never commit source messages, personal contacts or customer records. The generic examples contain procedures without real identities.

Run `npm run -w @cf-worker-apps/cloud-agent control-check` after the Pi build. The native workerd check publishes each workflow through the protected administrator API, explicitly activates it and verifies its body loads through Pi's native activate_skill tool. Faux inference exercises registry and persistence behavior; a hosted language-model run is a separate acceptance check.

## Scoped MCP and images

Two Pi tools (`search_visit_patients`, `get_visit_context`) call the configured Gateway through a Cloudflare service binding. The caller comes from the placed Pi submission and its signed Channel command operation, not model arguments. Set `VISIT_MCP_GROUP_ID` and `ALLOWED_CHANNEL_ID` on both runtimes, bind `VISIT_MCP_API` to the Gateway and supply its existing `VISIT_INGRESS_TOKEN` through the secret manager. The endpoint `/channel-visit/mcp` requires the service token and pinned server target on each request. This preview rejects every result whose dataset mode is not `test`.

`generate_image` requires an explicit image request in that same signed command. Each source operation can dispatch one generation; the Durable Object records intent before transport, so an uncertain outcome is not charged again on replay. Private R2 stores the binary and the journal stores an opaque asset link. `/assets/:id` requires the management SSO session and matching tenant. No public bucket URL is created.

For subscription images, set `IMAGE_ENABLED=true`, `IMAGE_PROVIDER=codex`, `IMAGE_MODEL=gpt-image-2` and bind a private R2 bucket as `IMAGE_ASSETS`. The account panel starts one Codex device login for inference and images. Existing SIWC inference stays active until successful reconnection; image-only profiles are not promoted implicitly. See [unified subscription authorization](UNIFIED_SUBSCRIPTION_AUTH.md) for credential pins and migration behavior. The transport follows the official Codex image implementation; it is not a separately versioned third-party API guarantee. Hosted device authentication and image entitlement require a real login and probe. A missing profile returns `image_auth_needed`; this mode never switches to a paid API key.

Sources: [Codex images](https://learn.chatgpt.com/docs/image-generation), [SIWC inference endpoints](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference). Legacy SIWC inference has a separate authorization profile; the unified standard Codex profile covers both Codex inference and images.

Focused checks: `npm run pi-mcp-check`, `npm run image-check`, `npm run codex-images-check`. The MCP check uses the installed SDK with native Worker service bindings and the typed Gateway/backend helpers; the deployed Gateway must additionally verify its installed legacy server adapter. Image checks use native Durable Object/R2 storage and a synthetic transport. Neither check proves live provider access.

## Verification record — 2026-10-06

- A hosted staff root received an automatic workflow reply. The committed transcript contained `activate_skill(announcement-review)`; the reply preserved unapproved/unpublished status while drafting the requested translation.
- A signed App command in that same root committed real `search_visit_patients` and `get_visit_context` tool calls through the hosted Gateway. It returned 20 synthetic visit records. The backend bounds the returned list to 20; this is a returned-row count, not a complete lifetime visit count.
- A separate synthetic printer thread produced a triage/handoff reply that distinguished accepted ownership from verified resolution and preserved unknown deadlines. No people were invited or real equipment modified.
- Hosted Codex device-code issuance succeeded. User login and a real subscription image remain unverified; native OAuth/JWKS, replay, storage and UI checks use mocked outbound endpoints.
- Behavioral checks pass. Native coverage collection reports `Profiler is not enabled`; no numeric coverage result is claimed or threshold relaxed.
