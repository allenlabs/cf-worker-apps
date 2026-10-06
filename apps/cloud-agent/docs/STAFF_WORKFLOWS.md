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
