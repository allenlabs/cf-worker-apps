import { createRequire } from "node:module";
import { readFile, mkdir, writeFile, mkdtemp, symlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const dependencyManifest = resolve(process.env.SUBSCRIPTION_DEPENDENCIES || resolve(here, "../../../package.json"));
export const dependencies = createRequire(dependencyManifest);
export const sourceRoot = resolve(process.env.SUBSCRIPTION_SOURCE_ROOT || resolve(here, "../../.."));

export async function bundle(entry, outfile) {
  const { build } = dependencies("esbuild");
  await mkdir(dirname(outfile), { recursive: true });
  const stage = await mkdtemp(join(tmpdir(), "subscription-bundle-"));
  await symlink(join(dirname(dependencyManifest), "node_modules"), join(stage, "node_modules"), "dir");
  // Resolve public app sources first, then let Wrangler handle native Workers package conditions and Node compatibility.
  await build({
    entryPoints: [entry], outfile: join(stage, "input.js"), bundle: true, packages: "external", format: "esm", target: "es2022",
    external: ["cloudflare:*", "node:*"], loader: { ".sql": "text" }, metafile: true, logLevel: "silent",
    plugins: [{ name: "isolated-public-source", setup(builder) {
      builder.onResolve({ filter: /cloud-agent\/workers\/pi\/index\.js$/ }, () => ({ path: join(sourceRoot, "apps/cloud-agent/workers/pi/index.js") }));
    } }],
  });
  await writeFile(join(stage, "package.json"), '{"private":true,"type":"module"}\n');
  await writeFile(join(stage, "wrangler.json"), JSON.stringify({ name: "subscription-local-build", main: "input.js", compatibility_date: "2026-10-04", compatibility_flags: ["nodejs_compat"], workers_dev: false, preview_urls: false }));
  const wranglerManifest = dependencies.resolve("wrangler/package.json");
  const wrangler = join(dirname(wranglerManifest), dependencies(wranglerManifest).bin.wrangler);
  execFileSync(process.execPath, [wrangler, "deploy", "--config", join(stage, "wrangler.json"), "--dry-run", "--outdir", join(stage, "dist"), "--minify", "--metafile", join(stage, "metadata.json")], {
    cwd: stage, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "pipe", maxBuffer: 1048576,
  });
  await copyFile(join(stage, "dist/input.js"), outfile);
  return { metafile: JSON.parse(await readFile(join(stage, "metadata.json"), "utf8")) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = resolve(process.argv[2] || join(here, "build/index.js"));
  const result = await bundle(join(here, "index.js"), output);
  const bytes = await readFile(output);
  await writeFile(`${output}.meta.json`, JSON.stringify(result.metafile));
  const script = Object.values(result.metafile.outputs).find(value => value.exports.includes("default"));
  console.log(JSON.stringify({ output, bytes: bytes.length, gzipBytes: gzipSync(bytes).length, exports: script.exports, imports: [...new Set(script.imports.map(value => value.path))] }));
}
