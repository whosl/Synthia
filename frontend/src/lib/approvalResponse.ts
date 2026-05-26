/** Build approval API payload — indices identify each change row (supports duplicate paths). */
export function buildApprovalResponse(
  files: Array<{ path: string }>,
  approvedIndices: number[],
): { approved: true; approved_indices: number[]; approved_files: string[] } {
  const sorted = [...approvedIndices].sort((a, b) => a - b)
  return {
    approved: true,
    approved_indices: sorted,
    approved_files: sorted.map((i) => files[i]!.path),
  }
}
