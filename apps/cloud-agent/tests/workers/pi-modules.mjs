import { copyFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function piTextModules(directory, destination = directory) {
  const names = (await readdir(directory)).filter(name => name.endsWith(".sql"));
  if (destination !== directory) await Promise.all(names.map(name => copyFile(join(directory, name), join(destination, name))));
  return names.map(name => ({ type: "Text", path: join(destination, name) }));
}
