/** Only return to known, local application pages after authentication. */
export function loginDestination(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\/(projects|approvals)(\/|\?|#|$)/.test(value)
  )
    return "/projects";
  if (/[\\\r\n]/.test(value)) return "/projects";
  return value;
}

/** Query-only navigation must preserve the workspace and its drafts. */
export function viewKey(route: { readonly path: string }): string {
  return route.path;
}
