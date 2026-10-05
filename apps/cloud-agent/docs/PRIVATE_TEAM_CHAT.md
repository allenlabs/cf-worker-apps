# Private team-chat support

The current integration supports the documented public-group App Hook. The official `teamChat.messageCreated` contract publishes roots and replies from public, non-archived groups. A private app installation is different from a private TeamChat group. [Official Hook reference](https://github.com/channel-io/app-sdk/blob/main/docs/reference/typescript/extensions/hook.md#teamchat-message-created).

Changing the configured group ID cannot make the upstream publisher emit private-group messages. The runtime can route a supplied event to its configured root and call `writeGroupMessage`, but synthetic input does not prove private-group event delivery or native write authorization. [Official native operation types](https://github.com/channel-io/app-sdk/blob/main/ts/packages/core/src/types/native.ts).

A future private-group integration needs a supported event or user-initiated input path, verified App Bot destination access, and an explicit policy for who may read stored history. The reviewed documentation does not establish private App Bot membership requirements or a private Hook override. Until those contracts are established and tested independently, the product must not claim automatic private-group support.

Existing local checks cover signed source filtering, root routing, duplicate delivery, rejected permissions and ambiguous sends. They use generated data and mocked native services. They do not prove that Channel Talk sends private-group events. Test a future private source with separate configuration and storage because source IDs participate in object identity.

## Other access paths

The maintained [Open API contract](https://api-doc.channel.works/docs/openapi.en.yaml), version `2026-06-01`, lists public groups only through `GET /open/groups`. It separately defines `GET /open/groups/{groupId}` for metadata and `GET /open/groups/{groupId}/messages` for paged content. Private API-key eligibility is unspecified. Omission from a public listing does not prove that a known private group is inaccessible.

The narrow verification path is one metadata request for an approved, empty private test group, using its known ID and an approved identity. Pin `Channel-Version: 2026-06-01` and omit profile expansion. Retain only status, matching identifiers and scope. Success establishes metadata access only; a subsequent synthetic-message read is a separate content-access test. No live private probe has been performed.

The same contract defines `GET /open/groups/{groupId}/threads/{messageId}` for a thread root and `GET /open/groups/{groupId}/threads/{messageId}/messages` for paged thread messages. If the execution supplies an unambiguous root ID and that identity can read the private group, these endpoints are a candidate for assembling root/reply context. Their existence does not establish private authorization.

Conventional Webhooks also explicitly exclude private groups and direct messages, so they are not an automatic private-event fallback. [Official Webhook guide](https://developers.channel.io/en/articles/Getting-started-f2a30b58).

A registered desk Command can receive explicit input and signed caller/chat context and open a WAM. If that surface is available in a private group, it offers a user-initiated input path without relying on a message Hook. WAM context provides identifiers, not history; any history read still needs an authorized API. Thread context such as `rootMessageId` is surface dependent and must be checked in an actual invocation, rather than inferred from a group ID. A Channel app token does not confer manager authority. [Command guide](https://developers.channel.io/en/articles/Command-b3d200dc), [WAM reference](https://github.com/channel-io/app-sdk/blob/main/docs/reference/typescript/WAM.md#core-hooks).

The current `/ai` feature parses Hook-delivered text. It is not a registered Command extension. Private Command availability, content reads, replies and stored-history reader policy must each be verified before implementing private support.
