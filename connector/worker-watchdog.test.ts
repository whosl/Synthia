import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("H40 Windows supervisor contract: port mutex, scoped cleanup, unrelated-port refusal, foreground child", async () => {
  const source = await readFile(new URL("../deploy/supervise/worker-watchdog-66.ps1", import.meta.url), "utf8");
  expect(source).toContain("Global\\SynthiaWorkerPort-$port");
  expect(source).toContain("$mutex.WaitOne(0)");
  expect(source).toContain("System.Threading.AbandonedMutexException");
  expect(source).toContain("[regex]::Escape($_)");
  expect(source).toContain("$process.Name -in @('node.exe', 'bun.exe')");
  expect(source).toContain("$process.CommandLine -match $_");
  expect(source).toContain("is owned by an unrelated process; refusing cleanup");
  expect(source.indexOf("refusing cleanup")).toBeLessThan(source.indexOf("Stop-Process"));
  expect(source).toContain("Wait-Process -Id $worker.ProcessId");
  expect(source.indexOf("& $env:ComSpec")).toBeLessThan(source.indexOf("$mutex.ReleaseMutex()"));
  expect(source).not.toMatch(/Stop-Process\s+-Name|taskkill|Start-Process/);
});
