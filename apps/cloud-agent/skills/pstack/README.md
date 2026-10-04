# pstack hosted adapter

Status: **NOT_INSTALLED**. These files are prepared for repository handoff. No production skill publication, activation, shell integration or Git integration has occurred.

`pstack.payload.json` and `pstack-library.payload.json` contain the complete Markdown documentation from pstack 1.5.0 with a hosted capability adapter. The 54 upstream entrypoints are indexed documents inside two catalog entries. The adapter can guide reasoning, planning, explanation, prose editing and review of supplied text using `activate_skill` and `read_skill_resource`.

The full upstream plugin runtime is not installed. Executable scripts, runtime hooks, external model launchers, shell, Git, browser control and child agents are absent. The adapter instructs the model to report those capabilities as unavailable and never present a sequential single-agent pass as independent review.

All 122 upstream Markdown files and both plugin descriptors retain exact source bytes. The metadata attributes Lauren Tan and the open-pstack maintainers. `LICENSE.upstream` is the unchanged MIT license retrieved from the official repository, including the original copyright notice. Its URL and checksum are in `license-provenance.json`; the main payload also includes that exact license.

## Local verification

From a checkout with the Cloud Agent dependencies installed, pass the directory containing `package.json` and `workers/pi/admin.js`:

```sh
node check.mjs --implementation-root ../..
```

Adjust the relative argument for the repository layout. The check uses the implementation's existing `esbuild` and `miniflare` dependencies. It validates and publishes both payloads in local workerd, repeats publication, activates them, and compares every stored resource with its input. It blocks all network calls. It does not call a model or production service.

To regenerate payloads from a pstack 1.5.0 source tree containing `skills/`, `agents/`, `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`:

```sh
python build.py --source /path/to/pstack-1.5.0
node check.mjs --implementation-root /path/to/cloud-agent-implementation
```

The source path is an explicit argument. Neither script contains machine-specific home paths. The builder checks source byte retention, per-skill and resource bounds, and Markdown reference coverage. Existing payloads and the native check can be used without an installed local pstack plugin.

## Installation checkpoint

No installation is part of this handoff. To finish installation from the cloud workspace, check active catalog capacity, publish the library and main payloads, and then enable both. Each publication initially stays disabled in the existing management API. A real model tool-call check is still needed after activation. No inference validation has been performed for this package.

See `assessment.md` for measured bounds and `runtime-expansion.md` for researched shell/Git options.
