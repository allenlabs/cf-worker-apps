# Deprecated interfaces

`commands.ai.visit` with `action:"draft"` is a legacy compatibility API for active clients. Its hardcoded arrival/treatment fields and deterministic draft renderer remain unchanged for those clients and their regression checks. Do not add fields, draft kinds or new UI consumers to it. The replacement is the versioned skill-driven `commands.ai.workflow` runner documented in [WORKFLOW_SKILLS.md](WORKFLOW_SKILLS.md).

The hardcoded WAM field controls and arrival/treatment buttons were removed. The live patient search/select API, shared picker, visit projection, Gateway and authorized read path remain supported. They are used by visit-source workflow forms and are not deprecated.
