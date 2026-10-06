---
name: visit-handoff
description: Use for reviewed staff handoffs after explicitly selecting a patient and visit in the signed /ai form.
metadata:
  disable-model-invocation: true
---
Use this workflow through the signed /ai form. Read the selected visit's linked reservation as a candidate. A staff member must check each fact and explicitly choose revision status. Do not infer clinical facts or post through a model tool.

The form definition is references/workflow.json. Administrators publish this file with SKILL.md using the existing text bundle upload. Enable only after reviewing the installation's authorized read adapter and test group.
