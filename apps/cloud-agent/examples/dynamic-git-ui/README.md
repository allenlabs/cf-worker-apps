# Runtime Git UI feasibility example

This optional example compiles synthetic TSX inside the local Cloudflare Workers runtime and returns HTML and browser JavaScript assets. It does not fetch a Git repository, deploy a Worker, execute the browser UI, or implement the production source importer.

```sh
cd apps/cloud-agent/examples/dynamic-git-ui
npm ci
npm test
```

The example has its own dependencies. Installing it does not change the application or repository-root package manifests. Generated bundles and the compiler WASM stay in a temporary folder and are removed after the check.

## What the check proves

The check calls the Worker through Miniflare and uses the official `@cloudflare/worker-bundler` adapter. It asserts that `createApp` returns HTML plus JavaScript with TS types and JSX removed. A replay of the same revision and source skips compilation. A source change and a revision change each produce a different cache key.

The fixture creates a small JSX object through a local `createElement` function; it does not mount a page in a browser. Its `Map` cache proves reuse within one warm isolate, not persistence across isolate eviction or restarts. Transpilation is not semantic typechecking.

A local run with worker-bundler 0.2.5 and Miniflare 5.20261001.0-alpha took 865 ms for the first request, including 362 ms in `createApp`. These are local wall-clock observations, not production latency or CPU-budget guarantees. The host bundle was 379,434 bytes and compiler WASM was 13,940,120 bytes before compression. The package is experimental and its API may change; pin the version and keep this check when evaluating an upgrade.

## Applying this to a Git source

Initial host support needs one normal application deployment. Subsequent approved UI revisions can be fetched and served without redeploying that host:

1. An administrator registers a tenant-scoped repository ID, allowed source folder, entry file, format, and UI contract version. A launch resolves the chosen Git ref to one exact commit. Every file in that launch uses that commit.
2. The server reads approved files with the GitHub App installation token. The token remains server-side. HTML and browser-ready ESM JavaScript require no compiler; validated workflow JSON can use the existing schema renderer. TS and TSX require transformation to JavaScript.
3. On a TSX cache miss, bundle the approved source in a Worker. Key the artifact by tenant/source authorization scope, repository ID, commit, source hashes, compiler version/options, resolved dependency versions/hashes, and UI contract version. Cache assets in private R2 storage and coalesce concurrent misses. Recheck authorization when serving private artifacts; cache identity is not authorization.
4. A WAM launch pins that artifact revision. New launches can select a newer revision while an open form keeps its old revision. Serve HTML and JavaScript with explicit MIME types and a narrowly scoped CSP. Keep workflow values, credentials, and customer records out of code artifacts and cache keys.
5. The trusted WAM parent validates declared actions on the server. Treat generated or untrusted UI code as a child frame on a separate origin without the Channel bridge or application credentials. Dynamic Workers isolate server execution; they do not isolate browser code after an HTML response is opened.

The current application has exact Git tree/blob reads and a workflow JSON renderer, but no automatic Git-to-UI importer. The authoring source permissions and subscription-account checks are not the staff UI read contract. Add a separate approved-source read gate rather than broadening staff access to the administration broker. The current broker also excludes `.html`; HTML loading needs an explicit supported-file policy.

The existing WAM CSP allows inline scripts and blocks external module scripts. A dynamic module route needs a deliberate CSP change, such as a scoped same-origin module policy or a trusted parent plus isolated child origin. Runtime bundling does not require `unsafe-eval` in that browser policy. For frontend assets alone, no Dynamic Worker Loader binding is needed. A backend code extension would additionally need a Loader, controlled bindings, egress, and resource limits.

## Primary sources

- [Cloudflare runtime TypeScript and npm bundling](https://developers.cloudflare.com/dynamic-workers/getting-started/)
- [Cloudflare runtime GitHub import playground](https://developers.cloudflare.com/dynamic-workers/examples/dynamic-workers-playground/)
- [Pinned worker-bundler API and TSX example](https://github.com/cloudflare/agents/blob/cf7c9e3cd06a9250434fabf87b26d29b3485b9cc/packages/worker-bundler/README.md)
- [Runtime static asset storage](https://developers.cloudflare.com/dynamic-workers/usage/static-assets/)
- [Channel WAM bridge](https://github.com/channel-io/app-sdk/blob/main/docs/guides/en/wam.md)
