# Manager display names

`workers/pi/manager-directory.js` resolves names for staff IDs already observed in the deployment's Channel Talk channel. It uses the existing App's native `getManager` permission and channel access token. It does not require an Open API key or team-member impersonation.

Apply `MANAGER_DIRECTORY_SCHEMA` in the parent D1 migration, then call:

```js
const names = await resolveManagers({
  db: env.CONVERSATIONS,
  tenantId: env.TENANT_ID,
  channelId: env.ALLOWED_CHANNEL_ID,
  managerIds: observedSenderIds,
  lookup: params => owner.native("getManager", params, channelAccess)
});
const display = names.get(senderId); // { managerId, displayName, state }
```

The callback returns the official `{ manager: ... }` wrapper; the parent unwraps its native HTTP envelope. SDK types guarantee the Manager ID while other fields are opaque. A resolved display requires a valid `name`; the helper checks the returned ID and any supplied channel ID. Tenant/channel come from server configuration, and IDs come from admitted messages. Do not expose the helper as an arbitrary client-controlled directory lookup. Lookup receives an optional second `{ signal }` argument for cancellation.

Channel credentials include an encrypted grant revision. This release reissues pre-revision cached credentials once through the existing singleflight and cooldown path, so a token issued before Manager-read approval is not retained. Matching revisions keep normal token refresh. Permission denial does not trigger a general credential-reissue loop. Installations must grant `getManager` before name resolution can succeed. [Official Channel-token example](https://github.com/channel-io/app-sdk/blob/main/ts/packages/server/src/native/proxy-api.ts).

Names are cached for six hours; missing, malformed, denied and timed-out lookups yield `직원 <id>` for 60 seconds. Pages contain at most 50 requested IDs, duplicates are resolved once, and at most five lookups run together with a two-second deadline each. A late lookup cannot overwrite a cache row fetched at a newer timestamp. D1 failures reject explicitly; callers can report the directory as unavailable without interrupting message delivery.

Only IDs, validated display names, cache state and timestamps are stored. The helper discards email, phone, avatar, credentials and all other profile fields. Names are untrusted text: render them with `textContent` or the existing HTML escape helper. Manager names never grant SSO or model-account permissions.

Run the actual-workerd/D1 check from the repository root:

```sh
node apps/cloud-agent/tests/workers/manager-check.mjs
```

This check uses generated profiles and makes no network requests. It does not establish that a live App installation has the Manager-read permission.
