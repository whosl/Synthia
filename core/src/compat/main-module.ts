import { pathToFileURL } from "node:url";

/**
 * Cross-runtime "am I the process entry?" check. Replaces the Bun-only
 * `import.meta.main` / `import.meta.path === Bun.main` guards: under Bun the
 * boolean is present, under Node compare against the executed file. Inside a
 * bundle every module's URL differs from the entry, so inlined guards (like
 * the migration runner) correctly stay inert.
 */
export function isMainModule(meta: ImportMeta): boolean {
  const bunMain = (meta as ImportMeta & { readonly main?: boolean }).main;
  if (typeof bunMain === "boolean") return bunMain;
  if (typeof process.argv[1] !== "string") return false;
  try {
    return meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}
