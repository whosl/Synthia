import { describe, expect, test } from "bun:test";
import {
  applyTheme,
  resolveTheme,
  systemTheme,
  THEME_STORAGE_KEY,
  toggleTheme,
  type Theme,
  type ThemeMedia,
  type ThemeRoot,
  type ThemeStorage,
} from "../src/domain/theme.ts";

/** 内存 storage mock（不依赖真实 localStorage）。 */
function memoryStorage(initial: Readonly<Record<string, string>> = {}): ThemeStorage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

function media(matches: boolean): ThemeMedia {
  return { matches };
}

/** 记录 setAttribute 调用的假挂载根。 */
function fakeRoot(): ThemeRoot & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    setAttribute: (name, value) => void calls.push([name, value]),
  };
}

describe("systemTheme", () => {
  test("matches=true → dark", () => {
    expect(systemTheme(media(true))).toBe("dark");
  });
  test("matches=false → light", () => {
    expect(systemTheme(media(false))).toBe("light");
  });
});

describe("resolveTheme", () => {
  test("localStorage 无记忆 → 跟随系统（深色）", () => {
    expect(resolveTheme(memoryStorage(), media(true))).toBe("dark");
  });

  test("localStorage 无记忆 → 跟随系统（浅色）", () => {
    expect(resolveTheme(memoryStorage(), media(false))).toBe("light");
  });

  test("localStorage 已记忆 light → 优先生效，忽略系统偏好", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "light" });
    expect(resolveTheme(storage, media(true))).toBe("light");
  });

  test("localStorage 已记忆 dark → 优先生效，忽略系统偏好", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "dark" });
    expect(resolveTheme(storage, media(false))).toBe("dark");
  });

  test("localStorage 存了非法值 → 视为未记忆，跟随系统", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "solarized" });
    expect(resolveTheme(storage, media(true))).toBe("dark");
  });
});

describe("applyTheme", () => {
  test("写入 data-theme 属性", () => {
    const root = fakeRoot();
    applyTheme("dark", root);
    expect(root.calls).toEqual([["data-theme", "dark"]]);
  });

  test("light 主题同理", () => {
    const root = fakeRoot();
    applyTheme("light", root);
    expect(root.calls).toEqual([["data-theme", "light"]]);
  });
});

describe("toggleTheme", () => {
  test("dark → light，写入 localStorage 并应用到 DOM", () => {
    const storage = memoryStorage();
    const root = fakeRoot();
    const next = toggleTheme("dark", storage, root);
    expect(next).toBe("light");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(root.calls).toEqual([["data-theme", "light"]]);
  });

  test("light → dark", () => {
    const storage = memoryStorage();
    const root = fakeRoot();
    const next = toggleTheme("light", storage, root);
    expect(next).toBe("dark");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  test("切换后覆盖此前的手动记忆", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "dark" });
    const root = fakeRoot();
    toggleTheme("dark", storage, root);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });
});

describe("Theme 类型契约", () => {
  test("只有 dark/light 两个合法值参与 resolveTheme 判定", () => {
    const values: Theme[] = ["dark", "light"];
    for (const v of values) {
      const storage = memoryStorage({ [THEME_STORAGE_KEY]: v });
      expect(resolveTheme(storage, media(false))).toBe(v);
    }
  });
});
