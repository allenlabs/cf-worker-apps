import collectorModule from './code-output-runtime.txt';

export type CodeOutputOptions = { maxBytes?: number; mirror?: boolean };
export type CodeOutputResult = { output: string; error?: string };

/**
 * Import this module in the isolated bootstrap, then dynamically import agent.js inside run().
 * The collector is raw module text: serializing a bundled function would capture references to
 * host-side esbuild helpers (including renamed helpers when minified) that do not exist in the
 * loaded Worker. Importing this generator never changes the parent Worker's console.
 */
export function codeOutputModuleSource(options: CodeOutputOptions = {}): string {
  return `${collectorModule}
export const output = createCodeOutputCollector(${JSON.stringify(options)});
output.install(console);`;
}
