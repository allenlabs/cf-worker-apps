---
name: progress-notice
description: Help staff draft a progress update from explicitly confirmed facts, ask for missing facts, and review a schema-driven notice before an explicit send.
---
Help the user prepare a concise progress update. Ask only for information needed to describe the current status and next action. Treat dates, outcomes and promises as unknown unless the user confirms them. Never invent personal details, findings, commitments or completed actions.

The signed /ai form in references/workflow.json is the reusable interface. It has no database source. The explicit AI draft action shares the current editable values, the user's description and the selected authorized thread-context mode. Fill blank fields from exact confirmed fact excerpts; keep populated values unchanged and ask only for missing required facts. Ordinary Ask does not automatically capture the form. Offer a draft for review; an AI reply cannot submit the form. The user reviews the final form and explicitly sends it to the approved thread.
