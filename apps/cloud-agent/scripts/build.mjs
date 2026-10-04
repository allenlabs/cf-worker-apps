import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url));
const worker = process.argv[2];
const configs = { pi: "workers/pi/wrangler.jsonc", events: "../mcp-events/workers/api/wrangler.toml" };
if (!Object.hasOwn(configs, worker)) throw Error("Choose pi or events.");
const require = createRequire(import.meta.url);
const manifest = require.resolve("wrangler/package.json");
const wrangler = join(dirname(manifest), require(manifest).bin.wrangler);
execFileSync(process.execPath, [wrangler, "deploy", "--config", resolve(app, configs[worker]), "--dry-run", "--outdir", resolve(app, "build", worker)], {
  cwd: app,
  stdio: "inherit",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" }
});
