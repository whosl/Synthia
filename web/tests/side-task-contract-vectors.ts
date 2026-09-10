/** Exactly 32 path segments including `rtl` and the filename. */
export const DEEP_SIDE_TASK_PATH = `rtl/${Array.from({ length: 30 }, (_, index) => `level-${index + 1}`).join("/")}/deep.v`;
export const TOO_DEEP_SIDE_TASK_PATH = `rtl/${Array.from({ length: 31 }, (_, index) => `level-${index + 1}`).join("/")}/deep.v`;
export const MAX_BYTES_SIDE_TASK_PATH = `doc/${"界".repeat(168)}x.md`;
export const TOO_MANY_BYTES_SIDE_TASK_PATH = `doc/${"界".repeat(169)}x.md`;

export const VALID_SIDE_TASK_PATHS = [
  "rtl/a.v",
  "tb/a_tb.sv",
  "doc/arch/a.md",
  "prj/constr/top.xdc",
  "./rtl/normalized.v",
  DEEP_SIDE_TASK_PATH,
  MAX_BYTES_SIDE_TASK_PATH,
] as const;

export const INVALID_SIDE_TASK_PATHS = [
  "rtl/**",
  "rtl/",
  "rtl/../secret",
  "../rtl/a.v",
  "/tmp/a.v",
  "C:/tmp/a.v",
  "rtl\\a.v",
  "src/a.v",
  "sim/exploratory/run.log",
  "doc/a.v",
  "doc/a.SVH",
  "prj/top.xdc",
  "prj/constr",
  TOO_DEEP_SIDE_TASK_PATH,
  TOO_MANY_BYTES_SIDE_TASK_PATH,
] as const;

export function sideTaskPaths(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `rtl/generated/file-${String(index + 1).padStart(2, "0")}.v`);
}
