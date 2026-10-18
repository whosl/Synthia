import { readFile } from "node:fs/promises";

/** Re-read on use. Broken/missing policy fails closed; TLS/toolchain stay pinned. */
export async function readProjectScope(path: string, connectorId: string): Promise<readonly string[]> {
  const config = JSON.parse(await readFile(path, "utf8"));
  if (config.connector_id !== connectorId || !Array.isArray(config.project_scope)
    || config.project_scope.some((id: unknown) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
    || new Set(config.project_scope).size !== config.project_scope.length) throw new Error("CONFIG_INVALID:project_scope");
  return config.project_scope;
}
