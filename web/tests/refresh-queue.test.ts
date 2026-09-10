import { expect, test } from "bun:test";
import { createRefreshQueue } from "../src/domain/refresh-queue.ts";

test("a write waits for a new refresh when an older read is already in flight", async () => {
  const finish: (() => void)[] = [];
  const refresh = createRefreshQueue(
    () => new Promise<void>((resolve) => finish.push(resolve)),
  );
  const oldRead = refresh();
  const afterWrite = refresh();
  const extraPoll = refresh();
  expect(afterWrite).toBe(extraPoll);
  expect(finish).toHaveLength(1);
  finish[0]!();
  await oldRead;
  await Promise.resolve();
  expect(finish).toHaveLength(2);
  let updated = false;
  void afterWrite.then(() => {
    updated = true;
  });
  expect(updated).toBe(false);
  finish[1]!();
  await afterWrite;
  expect(updated).toBe(true);
});

test("a failed refresh does not strand the next requested refresh", async () => {
  let fail!: (reason: Error) => void;
  let calls = 0;
  const refresh = createRefreshQueue(() =>
    ++calls === 1
      ? new Promise<void>((_resolve, reject) => {
          fail = reject;
        })
      : Promise.resolve(),
  );
  const first = refresh();
  const next = refresh();
  fail(new Error("offline"));
  await expect(first).rejects.toThrow("offline");
  await next;
  expect(calls).toBe(2);
  await refresh();
  expect(calls).toBe(3);
});
