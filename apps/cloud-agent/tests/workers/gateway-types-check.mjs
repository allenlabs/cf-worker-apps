import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

execFileSync(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--lib", "ES2022,DOM", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", fileURLToPath(new URL("./gateway-types.ts", import.meta.url))], { stdio: "inherit" });
