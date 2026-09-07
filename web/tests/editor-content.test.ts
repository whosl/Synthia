import { describe, expect, test } from "bun:test";
import { effectScope } from "vue";
import { createClient } from "../src/api/client.ts";
import { useEditorContent } from "../src/composables/use-editor-content.ts";

function harness() {
  const pending: {
    path: string;
    method: string;
    body: unknown;
    finish: (content: unknown, status?: number) => void;
  }[] = [];
  const client = createClient({
    fetchImpl: (async (input, init) =>
      new Promise<Response>((resolve) => {
        pending.push({
          path: String(input),
          method: init?.method ?? "GET",
          body: init?.body,
          finish: (data, status = 200) =>
            resolve(
              new Response(
                JSON.stringify(
                  status === 200
                    ? { data }
                    : { error: { code: "forbidden", message: "read denied" } },
                ),
                { status },
              ),
            ),
        });
      })) as typeof fetch,
  });
  const scope = effectScope();
  const editor = scope.run(() => useEditorContent(client, "project"))!;
  return { editor, pending, scope };
}

describe("editor request ownership", () => {
  test("a slower previous file cannot overwrite the current file", async () => {
    const { editor, pending, scope } = harness();
    const first = editor.loadWorkspaceContent("first.md");
    const second = editor.loadWorkspaceContent("second.md");
    pending[1]!.finish({ content: "second" });
    await second;
    pending[0]!.finish({ content: "first" });
    await first;
    expect(editor.fileContent.value).toBe("second");
    expect(editor.contentSource.value).toBe("workspace");
    scope.stop();
  });

  test("an earlier failure cannot clear new content or its loading indicator", async () => {
    const { editor, pending, scope } = harness();
    const first = editor.loadWorkspaceContent("first.md");
    const second = editor.loadWorkspaceContent("second.md");
    pending[0]!.finish(null, 403);
    await first;
    expect(editor.fileContentLoading.value).toBe(true);
    expect(editor.saveError.value).toBeNull();
    pending[1]!.finish({ content: "second" });
    await second;
    expect(editor.fileContent.value).toBe("second");
    scope.stop();
  });

  test("a failed read cannot turn an empty editor into a writable file", async () => {
    const { editor, pending, scope } = harness();
    const read = editor.loadWorkspaceContent("denied.md");
    pending[0]!.finish(null, 403);
    await read;
    expect(editor.fileContent.value).toBeNull();
    expect(editor.saveError.value).not.toBeNull();
    expect(await editor.saveWorkspaceContent("denied.md", "replacement")).toBe(
      false,
    );
    expect(pending).toHaveLength(1);
    scope.stop();
  });

  test("a successful save updates the confirmed bytes without a duplicate write", async () => {
    const { editor, pending, scope } = harness();
    const read = editor.loadWorkspaceContent("notes.md");
    pending[0]!.finish({ content: "original" });
    await read;
    const save = editor.saveWorkspaceContent("notes.md", "edited");
    expect(await editor.saveWorkspaceContent("notes.md", "edited")).toBe(false);
    expect(pending[1]!.method).toBe("PUT");
    pending[1]!.finish({});
    expect(await save).toBe(true);
    expect(editor.fileContent.value).toBe("edited");
    expect(editor.saving.value).toBe(false);
    scope.stop();
  });

  test("save failure preserves the previous confirmed bytes for retry", async () => {
    const { editor, pending, scope } = harness();
    const read = editor.loadWorkspaceContent("notes.md");
    pending[0]!.finish({ content: "original" });
    await read;
    const save = editor.saveWorkspaceContent("notes.md", "edited");
    pending[1]!.finish(null, 403);
    expect(await save).toBe(false);
    expect(editor.fileContent.value).toBe("original");
    expect(editor.saveError.value).not.toBeNull();
    scope.stop();
  });

  test("a late save acknowledgment cannot replace a different file", async () => {
    const { editor, pending, scope } = harness();
    const read = editor.loadWorkspaceContent("notes.md");
    pending[0]!.finish({ content: "original" });
    await read;
    const save = editor.saveWorkspaceContent("notes.md", "edited");
    const next = editor.loadWorkspaceContent("next.md");
    pending[2]!.finish({ content: "next" });
    await next;
    pending[1]!.finish({});
    await save;
    expect(editor.fileContent.value).toBe("next");
    scope.stop();
  });

  test("unmount invalidates all pending reads", async () => {
    const { editor, pending, scope } = harness();
    const read = editor.loadWorkspaceContent("notes.md");
    scope.stop();
    pending[0]!.finish({ content: "late" });
    await read;
    expect(editor.fileContent.value).toBeNull();
  });
});
