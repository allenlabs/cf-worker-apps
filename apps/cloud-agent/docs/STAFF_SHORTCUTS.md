# Staff defaults and skill shortcuts

A signed `/ai` command can open the normal thread helper or select an administrator-enabled workflow before a thread exists. Its optional `mode` parameter offers the localized choice **단축어** (`shortcut`); optional `workflow` uses the native Command autocomplete Function. The server returns at most ten current enabled workflow titles with stable skill names as values. Execute accepts a canonical name or an unambiguous title/compact Korean title and resolves it to a content-hash revision. The WAM receives only that minimal selection and the existing caller-bound capability.

This uses the [official Command SDK schema](https://github.com/channel-io/app-sdk/blob/main/ts/packages/core/src/extensions/command.ts) and [Command guide](https://github.com/channel-io/app-sdk/blob/main/docs/guides/en/extensions/command.md): optional typed parameters, static choices, parameter autocomplete and a WAM result. These APIs do not define a subcommand tree or guarantee one full-phrase suggestion row. Verify the native client presentation separately before describing literal `/ai 단축어 경과알리기` typing as observed behavior. Bare `/ai` remains valid and performs no owner catalog read solely to open its WAM.

## Personal settings

The existing Credentials owner stores model ID and thinking level under a hash of tenant, Channel and authenticated manager identity. It stores no employee email, account choice or shared transcript. A successful staff setting action patches only its changed field. An explicitly created root commits its selected pair when creation becomes ready. Updates merge inside one owner transaction with a durable receipt bound to staff identity, source group/root and original operation ID; old replays cannot revert a newer choice.

The next new real AI root captures a permitted copy of its first authenticated invoker's defaults once during account admission. The Assistant applies that frozen intent before its first AI snapshot. Explicit creator intent wins over later employee changes or colleagues. Already registered roots and initialized legacy Assistants keep their own settings; incidental administrator reads never create staff defaults. A native event lacking a valid sender ID uses configured defaults without guessing its author. If a previously preferred model is withdrawn, new discovery/admission falls back to the allowed configured model. Global account selection and administrator root controls do not change staff preferences.

An administrator's recovery of an uncertain root initializes that root only; it does not overwrite employee defaults that may have changed since the original launch. The dedicated owner keeps at most 2,000 setting operation receipts. Reaching this ceiling rejects another update rather than deleting old receipts and making replay unsafe. An operator must plan explicit archival/migration before increasing sustained usage. Root admission and start receipt ceilings remain unchanged.

## Skill-specific interaction

The existing schema-driven `references/workflow.json` renderer supplies fields, choices, required values, confirmations, exact-text review and explicit thread send. Selecting a native shortcut preselects the exact skill revision; stale selections require refresh instead of silently choosing a new revision. The generic [progress notice](../skills/workflows/progress-notice/SKILL.md) is a source-free example titled **경과알리기**. Keeping these two text files in Git lets an administrator review and publish a new form using the existing skill bundle UI without changing runtime code.

The form also has **선택한 업무로 질문하기**. That explicit Ask carries only a skill name/revision and the user's bounded plain question. It never copies form values, patient selection, visit selection or source projection into the general Pi transcript. The existing visible API-versus-directly-shared context choice continues to govern authorized source history. Typed question text is intentional conversation content.

At command acceptance, the Assistant pins the selected enabled current revision, whole manifest version, account, session, model and thinking level. Retries and cold restart use that accepted snapshot even if an administrator publishes another revision before execution. A new request with a stale selection is rejected. The existing `activate_skill` and `read_skill_resource` tools read the pinned bundle. An explicit selected skill can be activated even when its metadata disables unsolicited model invocation; other skills retain their metadata. AI instructions cannot silently send a form or change the delivery target. A selected-skill question beginning `/image` remains a skill question rather than bypassing this path through the direct image command.

## Load a Git UI without redeploying it

The current runtime renders validated workflow JSON dynamically. Its GitHub editor can maintain those files, but automatic Git import and UI activation are not implemented by this unit. Uploading a `.ts` resource does not execute it.

Cloudflare's official experimental `@cloudflare/worker-bundler` also supports runtime TS/TSX transformation. The optional [native runtime example](../examples/dynamic-git-ui/README.md) verifies `createApp` inside workerd: synthetic TSX produces HTML and browser JavaScript assets, an unchanged revision reuses a warm cache, and source or revision changes use a new key. It does not fetch a real repository, mount a browser UI, persist an R2 cache, or deploy a production loader.

A production Git UI loader needs one initial host deployment. Later approved UI revisions can follow **Git exact commit → runtime transformation on cache miss → private R2 artifact → pinned WAM launch** without deploying the host again. Browser-ready HTML/ESM and workflow JSON need no TS compiler. Cache identity includes authorized source scope, source content, compiler/options, resolved dependencies and UI contract version; serving still rechecks authorization. An open form retains its pinned revision.

Keep GitHub tokens on the server and route declared UI actions through the existing signed Function boundary. The current inline-only WAM CSP does not permit external modules. A dynamic module route needs a scoped asset policy or a trusted parent with an isolated child; backend Dynamic Workers do not isolate the resulting browser code. The linked example documents the remaining importer, isolation and persistent-cache work and the compiler's experimental limits.

## Runnable checks

After `npm run -w @cf-worker-apps/cloud-agent build`, run:

```sh
npm run -w @cf-worker-apps/cloud-agent shortcuts-check
npm run -w @cf-worker-apps/cloud-agent shortcuts-ui-check
```

The workerd check exercises signature/caller/group rejection, optional command parameters, title aliases, two employee identities, atomic partial preference updates and old replay after newer changes, cold restart, ordinary/explicit/legacy roots, absent sender, administrator isolation, recovered-root isolation, withdrawn-model fallback, accepted revision pinning, already placed generation cold-resume before command processing, image-only snapshot exclusion, actual skill tools and no implicit form capture. DOM checks exercise exact shortcut preselection, visible employee defaults, rootless no-inference selection, form-specific Ask and immutable request retry. These use generated identities and mocked outbound services; they do not prove native-client suggestion layout or production non-default model execution. Preserve existing coverage thresholds and report any unavailable workerd Profiler separately.
