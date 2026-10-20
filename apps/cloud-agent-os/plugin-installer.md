# Plugin installer

The installer builds approved package plugins outside the Worker and publishes immutable artifacts to R2. Organization administrators select `host` or `dynamic`. A pending request does not run. The installer never changes that approval and never switches a failed host plugin to dynamic execution.

## Run

Copy `plugin-installer.example.json` outside the public checkout, replace its synthetic paths, and make the configuration and state directory accessible only to the operator. Point `esbuildModule` and `typescriptModule` to the reviewed build environment's existing compiler installations. The runner requires Linux, Node 24, and an npm installation that advertises the dependency source policies described below. These flags were checked against npm 11.19.0. The runner does not install build tools or change authentication.

```sh
node scripts/plugin-installer.mjs --config /srv/cloud-agent-os/private/runner.json --once
```

Without `--once`, the runner polls every `pollSeconds`. A service or timer can invoke `--once` instead. Use one runner and one private state directory for each deployment. A Linux abstract Unix socket blocks concurrent local runs and is released by the kernel on process exit, including SIGKILL and reboot.

The process receives no credential environment. Its transport and deployment commands are operator-owned brokers. A broker may obtain only the credential needed for that operation. The npm subprocess receives a separate empty home, npm configuration, and cache. Package lifecycle scripts and executable bin links are disabled. The installer checks `npm install --help` before mutation and requires `--allow-directory=none`, `--allow-file=none`, `--allow-git=none`, and `--allow-remote=none`. These native policies reject local directory, local tarball, Git, and direct URL dependencies, including transitive dependencies. Genuine npm registry tarballs remain allowed. The compiler reads package files and bundles them; it never imports the installed package into Node or calls its setup function.

This process does not provide operating-system isolation. Run it on an appropriately restricted build host when packages must not have access to a personal machine. Npm and esbuild parse untrusted files, and package dependencies may require network downloads.

## Supported module profile

An npm source must use a supported lowercase npm name and an exact semantic version. Ranges, tags, Git URLs, and package URLs are rejected. The npm registry is `https://registry.npmjs.org`. The artifact records the installed package's SRI integrity and the exact lockfile SHA-256.

A bundle source references the SHA-256 of the uploaded UTF-8 JavaScript bytes. Upload those bytes at `agent-plugins/v1/bundles/<digest>.mjs`. The runner verifies that digest before compilation. Bundle artifacts have `packageIntegrity: null` and `lockDigest: null`.

Both sources compile to a single standalone ES module with a default export or named `Plugin` export. The runtime requires that export to implement native OpenCode v2 `{ id, setup(ctx) }`. The first portable profile supports bundled JavaScript without residual imports. Node or Cloudflare module imports, URL imports, native addons, external assets, and packages that need lifecycle builds fail explicitly. Setup compatibility is checked when the package runs in the selected Workers environment. A successful compilation alone does not prove every OpenCode API used by a plugin is supported.

The compiler parses its emitted JavaScript and rejects residual static or computed imports, `require` references, and direct `eval` or `Function` references. This compatibility check is not a JavaScript security sandbox. Host plugins are organization-trusted code; use dynamic execution when isolate-level network and binding restrictions are required.

Plugin options are a JSON string containing an object. The runner validates a maximum of 16,384 UTF-8 bytes, depth 16, and 2,048 JSON values. Options never affect the installation ID or artifact and are not passed to npm or esbuild.

## Transport protocol

The runner calls the configured `transportCommand` with one complete JSON request on stdin. It accepts only one complete JSON response on stdout. Diagnostics must go to private broker logs, never stdout. The runner does not expose raw broker or npm logs in installation status.

```json
{"operation":"get","key":"agent-plugins/v1/desired.json","file":"/private/plugin-state/poll-123/desired.json"}
```

The caller chooses an absolute destination inside its private state directory. A successful read returns `{"ok":true,"found":true,"file":"<exact requested path>"}` after writing the file. A missing object returns `{"ok":true,"found":false}` and creates no file. A put uses the same request shape with `"operation":"put"` and returns `{"ok":true,"found":true}` after publication. Failed operations must exit nonzero. Commands have a 60-second timeout and a 16-KiB stdout limit.

Keys are limited to the `agent-plugins/v1/` prefix. The runner reads `desired.json`, validates each immutable request at `requests/<installationId>.json`, and publishes `results/<installationId>.json`. Installation IDs hash `JSON.stringify({ resourceId, source, execution })` with the source's keys in canonical order. The desired snapshot contains only approved enabled package resources, never provider keys or unrelated settings.

An artifact is the exact UTF-8 JSON serialization of `{apiVersion:1,source,module,packageIntegrity,lockDigest}`. The SHA-256 of those bytes is its object key at `artifacts/<digest>.json`. The entire JSON artifact is at most 2 MiB. Existing artifacts must match byte for byte. Uploads are read back and verified before a result becomes ready.

## Host deployment protocol

The runner invokes `deployCommand` with a private host manifest path as its final argument. The manifest binds the exact desired snapshot digest and revision, clean source Git commit, deployment configuration digest, installation identities, and immutable artifact paths and digests. The runner rereads the desired snapshot, source, configuration, and artifacts before invoking the deployment command.

The deployment broker must validate this manifest against its independently configured source, account, deployment, and bucket. It must reread the current desired snapshot immediately before the actual upload, including after a long build. It must preserve the existing build, migration, namespace, binding, CPU, observability, and upload-module guards. Do not invoke a generic unchecked deployment command or put Worker deployment credentials into the builder environment.

After materializing a disposable checkout through the existing wrapper, the deployment broker applies the registry there:

```sh
node scripts/apply-host-plugin-inventory.mjs --manifest /private/host-manifest.json --checkout /private/build/cloudflare-os
```

The apply script requires the wrapper's `prepared.json` and a recognized placeholder or generated registry. It writes immutable module files and a lazy registry. Package top-level code is evaluated only after the runtime has verified the current resource, execution approval, installation result, and artifact digest. It never edits the tracked overlay. An empty manifest removes all active host registry entries.

After the guarded deployment completes, the broker returns `{"ok":true,"accepted":true,"manifestDigest":"<SHA-256 of exact manifest bytes>"}`. A response for another manifest is rejected. A deployment attempt marker is written before the command runs. An ambiguous response is recorded as `PLUGIN_HOST_DEPLOYMENT_UNVERIFIED` and is not automatically retried. An operator must inspect the actual deployment before reconciling that failure. A failed installation is also not retried on each poll.

The wrapper can freeze the checked deployment without credentials:

```sh
node scripts/build.mjs --check --config /private/deployment.json \
  --plugin-inventory /private/host-manifest.json --artifact-dir /private/new-artifacts
```

The artifact directory must be new and outside the source tree. The build checks a unique disposable copy, preserves every generated Worker setting, and captures all modules and frontend assets. It seals the manifest only after tests and Worker dry runs pass. The separate `upload-verified-artifacts.mjs` requires that manifest's expected SHA-256, the same deployment configuration, an exclusive attempt-marker path, and the installed Wrangler CLI path. It uploads those exact bytes without rebuilding and returns accepted version IDs. The deployment broker must check those versions on the live target independently.

When Cloudflare omits an existing service binding's properties from its read APIs, an operator can explicitly select that binding with `workers.<worker>.preserveServiceBindings` in the private `--upload-config-overlay` JSON file. The build replaces only the selected service binding with Cloudflare's native `inherit` binding before tests and dry runs, and seals the original service identity in the manifest. Immediately before each affected upload, the uploader checks the visible identity and requires the latest uploaded version to be the single active version at 100%. The broker must still verify all readable settings after deployment. Hidden properties remain unverified by read-back; native inheritance preserves them.

The `ready` result means the artifact was published and the selected deployment command returned a matching receipt. A host plugin becomes active only when the running Worker contains its exact artifact digest. Runtime authorization remains authoritative if the desired snapshot changes while a deployment is in progress.

## Checks

```sh
PLUGIN_TEST_ESBUILD=/absolute/path/to/esbuild/lib/main.js \
PLUGIN_TEST_TYPESCRIPT=/absolute/path/to/typescript/lib/typescript.js \
node --test tests/plugin-installer.test.mjs
```

The tests author their own package, transport, and deployment fixtures. They run the real compiler and CLI without downloading or evaluating third-party package code. Without both compiler module paths, protocol checks run and compiler-dependent checks are explicitly skipped.
