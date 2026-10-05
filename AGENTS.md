# Agent instructions

This is the public, reusable product repository and a portfolio of its implementation. Keep the useful runtime, tests, architecture, reproducible examples and measured results here. State verification limits honestly.

## Required publication order

1. Implement and verify every reusable change here first, including its tests and documentation.
2. Review the public diff for credentials, personal data and installation-specific information, then publish it here. Use generated identities and example configuration.
3. After the public commit is published, transfer its reviewed generic changes to the private deployment repository. Record the public commit being adopted.
4. Apply installation tuning only in the private deployment repository, through deployment configuration or documented private settings. If tuning requires reusable runtime logic, implement that logic here first.

Never publish credentials, OAuth grants or codes, browser sessions, personal identities, real chat or customer data, private operations documents, resource inventories or hosted deployment evidence. Preserve useful implementation detail by replacing sensitive inputs with fixtures; do not remove generic features merely because an installation uses them.

Do not push a private branch or its history here. Review the actual files and diff when transferring changes; do not blindly merge repositories with different histories. Secrets stay in secret-manager and platform bindings, including in the private repository.

## Repository context

Follow the current user's instructions first. Read this file and `CLAUDE.md` before working, then the app's guidance, README and handoff for the files being changed. App-specific instructions can refine the workflow but cannot weaken this public publication boundary. Existing commit, test and deployment rules in `CLAUDE.md` still apply where they do not conflict with this boundary or an explicit user instruction.
