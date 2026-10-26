# Provider Fast mode

Fast is an explicit per-chat request for a provider's separate low-latency or priority tier. It never changes reasoning effort. Standard remains the default. Model support does not prove account entitlement or latency; the UI explains prerequisites and extra usage or prices before selection. No paid calls, account changes, credentials, deployment, or main integration belong to this change.

## Approach

Extend the existing `fastMode` request, durable chat metadata, active-turn snapshot and resume path. Derive model capability and explanatory copy from trusted configuration and provider/model/auth constraints. Keep rejecting client-supplied capability claims. Put wire translation in the common native model adapter and subscription bridge. This keeps the existing bot snapshot, authorization and memory boundaries intact.

Alternatives considered were a new independent request-tier enum (unnecessary migration for a binary product choice) and reasoning presets (different behavior that does not request faster processing). A server-derived capability with the existing boolean is the smallest compatible shape.

Native OpenAI, Anthropic and Gemini support is restricted to documented models and official native endpoints; generic compatible endpoints, Workers AI and Ollama get an explicit unavailable reason. Subscription SIWC retains current bearer-specific capability metadata. Codex subscription can expose documented model support with an explicit account-entitlement caveat. No automatic retry may add Fast or silently remove it after an opted-in provider rejection. Providers may themselves fall back under their documented contract.

Capability follows the effective deployment route. Legacy user-managed or untagged bridges remain unavailable for Fast because they lack a verified provider/account selection contract. The server rejects their Fast preference before chat, message or retry writes. Their existing Standard transport remains available.

## State and UI

Use one capability helper for profile projection, server preference validation and adapter request translation. Preserve `supportsFast` compatibility and add server-derived explanatory metadata for pricing and unsupported reasons. Home, bot start, workspace composer and retry must send the same selected value. Scope draft selections so changing bot/model/chat cannot enable paid Fast unexpectedly. Existing chats and old active records without a preference remain Standard.

## Verification

TDD covers native wire payloads and unchanged reasoning, model/endpoint restrictions, server-derived profiles, UI toggle/disabled reason/price, Home and bot request arguments, durable save/resume and unsupported transitions. Real SDK serialization is exercised through synthetic fetch responses. Run wrapper tests, generated backend/frontend suites, types, production bundles and Worker dry-runs. Review the complete public diff independently before branch publication. Record unrelated lint/CI limitations separately.
