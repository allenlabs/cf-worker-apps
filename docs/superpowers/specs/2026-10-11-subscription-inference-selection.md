# Explicit subscription inference selection

Ordinary inference currently selects native Codex whenever an account has a unified profile. An account can also retain a legitimate SIWC direct-use grant, but cannot select it for new ordinary requests. Add an explicit server-owned installation choice. The user requires all future subscription inference in their installation to use SIWC only.

## Contract

- `SUBSCRIPTION_INFERENCE_PROVIDER` is an optional server environment enum, `auto` or `siwc`, default `auto` for generic compatibility. The private installation will set `siwc` for every account.
- Validate the enum before reading stored credentials. Reject every other value; an explicitly empty value is invalid.
- `auto` preserves current selection. `siwc` requires an existing legacy credential containing both `resource.invoke` and `chatgpt.tokens.use.direct`. Missing or ungranted SIWC is unavailable; there is no native fallback, new authorization flow or alternate account.
- Status provider, inference readiness/capability, endpoint, selected identity, plan and expiry must describe the selected inference grant. Image status and access continue to use their existing Codex profile. Connection state may still represent an account with an image connection but unavailable inference.
- Refresh the selected inference grant. Preserve encryption, identity pins, OAuth registration, existing stores and disconnect behavior.
- The private inference bridge has its own explicit provider choice. Ordinary selection must not override either bridge provider or native image readiness. Expose or use independent readiness for the actual native and SIWC grants.
- Apply selection when creating new request snapshots. Preserve every stored provider/account/model/session; completed replay makes no new provider request. In SIWC mode, unfinished or failed historical native snapshots must refuse before native credential access/provider fetch. Do not rewrite or resubmit these operations automatically; new requests select SIWC.
- Preserve model catalogs, allowlists, account allocation, manual/GitHub admission and cancellation. Availability follows the selected provider. SIWC-only mode applies to every ordinary subscription account. An account without the required retained SIWC grant is unavailable instead of using native Codex.
- Account UI must describe the selected inference provider and image connection truthfully. No new preference UI, storage schema, dependencies or automatic retry is needed.
- All fixtures use generated identities and invalid synthetic grants. No real messages, credentials, cookies, hosted resource inventories or deployment receipts belong in the public repository.

## Acceptance

Genuine workerd tests cover default unified Codex, explicit SIWC across multiple accounts, invalid policy before credential reads, missing/either missing scope, selected identity/expiry and refresh, independent bridge selection and native images, provider-specific model availability, new admission, unchanged completed replay and blocked pending historical native operations without native credential access/fetch. Verify SIWC success/error and native error behavior through the actual installed SDK with mocked upstreams. Run required Cloud Agent checks and coverage; report existing runtime limitations without lowering thresholds.

This provides an explicit supported route for available grants. It does not identify or repair an upstream native refusal rule, guarantee every model/tool workload, or change historical failed records.
