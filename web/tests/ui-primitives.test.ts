import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readUi = (path: string): string =>
  readFileSync(new URL(`../src/components/ui/${path}`, import.meta.url), "utf8");

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

const barrelExports: Record<string, string[]> = {
  sheet: [
    "Sheet",
    "SheetTrigger",
    "SheetClose",
    "SheetPortal",
    "SheetOverlay",
    "SheetContent",
    "SheetHeader",
    "SheetFooter",
    "SheetTitle",
    "SheetDescription",
  ],
  select: [
    "Select",
    "SelectTrigger",
    "SelectValue",
    "SelectContent",
    "SelectItem",
    "SelectGroup",
    "SelectLabel",
    "SelectSeparator",
    "SelectScrollUpButton",
    "SelectScrollDownButton",
  ],
  textarea: ["Textarea"],
  checkbox: ["Checkbox"],
  "radio-group": ["RadioGroup", "RadioGroupItem"],
  card: ["Card", "CardHeader", "CardTitle", "CardDescription", "CardAction", "CardContent", "CardFooter"],
  alert: ["Alert", "AlertTitle", "AlertDescription"],
  empty: ["Empty", "EmptyHeader", "EmptyMedia", "EmptyTitle", "EmptyDescription", "EmptyContent"],
  accordion: ["Accordion", "AccordionItem", "AccordionTrigger", "AccordionContent"],
};

describe("shadcn-vue ui primitives", () => {
  test("every new primitive directory has a complete index.ts barrel", () => {
    for (const [dir, names] of Object.entries(barrelExports)) {
      const barrel = readUi(`${dir}/index.ts`);
      for (const name of names) {
        expect(barrel, `${dir}/index.ts -> ${name}`).toContain(
          `export { default as ${name} } from "./${name}.vue"`,
        );
      }
    }
  });

  test("sheet is derived from the Dialog primitives with a configurable side", () => {
    const sheet = readUi("sheet/Sheet.vue");
    expect(sheet).toContain("DialogRoot");
    expect(sheet).toContain('data-slot="sheet"');

    const content = readUi("sheet/SheetContent.vue");
    expect(content).toContain("DialogContent");
    expect(content).toContain('from "reka-ui"');
    expect(content).toContain('side?: "top" | "right" | "bottom" | "left"');
    expect(content).toContain('side: "right"');
    for (const sideClass of [
      "data-[state=closed]:translate-x-full",
      "data-[state=closed]:-translate-x-full",
      "data-[state=closed]:-translate-y-full",
      "data-[state=closed]:translate-y-full",
      "transition-transform",
      "sm:max-w-sm",
      "w-3/4",
    ]) {
      expect(content, sideClass).toContain(sideClass);
    }
    expect(content).toContain('data-slot="sheet-content"');
    expect(content).toContain('from "@lucide/vue"');
    expect(content).toContain("sr-only");

    const overlay = readUi("sheet/SheetOverlay.vue");
    expect(overlay).toContain("DialogOverlay");
    expect(overlay).toContain('data-slot="sheet-overlay"');

    const title = readUi("sheet/SheetTitle.vue");
    expect(title).toContain("DialogTitle");
    const description = readUi("sheet/SheetDescription.vue");
    expect(description).toContain("DialogDescription");
  });

  test("select uses the reka Select primitives with a popper popover content", () => {
    const content = readUi("select/SelectContent.vue");
    expect(content).toContain("SelectContent");
    expect(content).toContain('from "reka-ui"');
    expect(content).toContain("bg-popover text-popover-foreground");
    expect(content).toContain('position: "popper"');
    expect(content).toContain("SelectViewport");
    expect(content).toContain("SelectScrollUpButton");
    expect(content).toContain("SelectScrollDownButton");

    const trigger = readUi("select/SelectTrigger.vue");
    expect(trigger).toContain("SelectTrigger");
    expect(trigger).toContain("ChevronDown");

    const item = readUi("select/SelectItem.vue");
    expect(item).toContain("SelectItem");
    expect(item).toContain("SelectItemIndicator");
    expect(item).toContain("SelectItemText");
    expect(item).toContain("Check");
  });

  test("textarea is a styled native textarea wired to defineModel", () => {
    const textarea = readUi("textarea/Textarea.vue");
    expect(textarea).toContain("defineModel<string>");
    expect(textarea).toContain("<textarea");
    expect(textarea).toContain('data-slot="textarea"');
    expect(textarea).toContain("placeholder:text-muted-foreground");
    expect(textarea).toContain("focus-visible:ring-ring/50");
  });

  test("checkbox wraps CheckboxRoot with a Check indicator and boolean v-model", () => {
    const checkbox = readUi("checkbox/Checkbox.vue");
    expect(checkbox).toContain("CheckboxRoot");
    expect(checkbox).toContain("CheckboxIndicator");
    expect(checkbox).toContain("defineModel<boolean>");
    expect(checkbox).toContain("data-[state=checked]:bg-primary");
    expect(checkbox).toContain('from "@lucide/vue"');
    expect(checkbox).toContain("Check");
  });

  test("radio-group wraps RadioGroupRoot and RadioGroupItem with a dot indicator", () => {
    const group = readUi("radio-group/RadioGroup.vue");
    expect(group).toContain("RadioGroupRoot");

    const item = readUi("radio-group/RadioGroupItem.vue");
    expect(item).toContain("RadioGroupItem");
    expect(item).toContain("RadioGroupIndicator");
    expect(item).toContain("rounded-full");
    expect(item).toContain("Circle");
  });

  test("card exposes the latest shadcn structure classes", () => {
    const card = readUi("card/Card.vue");
    expect(card).toContain("rounded-xl");
    expect(card).toContain("bg-card text-card-foreground");
    expect(card).toContain("shadow-sm");

    const header = readUi("card/CardHeader.vue");
    expect(header).toContain("has-data-[slot=card-action]:grid-cols-[1fr_auto]");
  });

  test("alert ships default and destructive cva variants", () => {
    const index = readUi("alert/index.ts");
    expect(index).toContain("cva");
    expect(index).toContain("alertVariants");
    expect(index).toContain("destructive");

    const alert = readUi("alert/Alert.vue");
    expect(alert).toContain("alertVariants");
    expect(alert).toContain('role="alert"');
  });

  test("empty ships the latest empty structure with media variants", () => {
    const index = readUi("empty/index.ts");
    expect(index).toContain("emptyMediaVariants");
    expect(index).toContain("icon:");

    const empty = readUi("empty/Empty.vue");
    expect(empty).toContain('data-slot="empty"');
    const media = readUi("empty/EmptyMedia.vue");
    expect(media).toContain("emptyMediaVariants");
  });

  test("accordion rotates the chevron and animates content height with grid rows", () => {
    const accordion = readUi("accordion/Accordion.vue");
    expect(accordion).toContain("AccordionRoot");

    const trigger = readUi("accordion/AccordionTrigger.vue");
    expect(trigger).toContain("AccordionTrigger");
    expect(trigger).toContain("AccordionHeader");
    expect(trigger).toContain("ChevronDown");
    expect(trigger).toContain("rotate-180");

    const content = readUi("accordion/AccordionContent.vue");
    expect(content).toContain("AccordionContent");
    expect(content).toContain("grid-rows-[0fr]");
    expect(content).toContain("data-[state=open]:grid-rows-[1fr]");
  });

  test("build:golden script enables all four feature flags", () => {
    const script = packageJson.scripts["build:golden"] ?? "";
    for (const flag of [
      "VITE_FEATURE_HISTORICAL_MATERIALS=1",
      "VITE_FEATURE_SIDE_TASKS=1",
      "VITE_FEATURE_FORMAL_DELIVERY=1",
      "VITE_FEATURE_SELF_EVOLUTION=1",
    ]) {
      expect(script, flag).toContain(flag);
    }
  });
});

describe("ui 组件模板可解析性", () => {
  // vue-tsc 不会发现模板里的属性引号冲突（双引号 JS 字符串嵌在双引号 HTML
  // 属性里），而未被引用的组件又进不了 vite 构建图——此处直接用 compiler-sfc
  // 解析全部 ui 组件，堵住「坏文件潜伏到首次被引用才爆」的缺口。
  test("所有 ui/**/*.vue 都能被 @vue/compiler-sfc 无错误解析", () => {
    const { parse } = require("@vue/compiler-sfc") as typeof import("@vue/compiler-sfc");
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const uiDir = new URL("../src/components/ui/", import.meta.url);
    const broken: string[] = [];
    for (const entry of readdirSync(uiDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".vue")) {
        const file = new URL(entry.name, uiDir);
        const result = parse(readFileSync(file, "utf8"));
        if (result.errors.length) broken.push(`${entry.name}: ${String(result.errors[0])}`);
      }
      if (entry.isDirectory()) {
        for (const sub of readdirSync(new URL(`${entry.name}/`, uiDir))) {
          if (!sub.endsWith(".vue")) continue;
          const file = new URL(`${entry.name}/${sub}`, uiDir);
          const result = parse(readFileSync(file, "utf8"));
          if (result.errors.length) broken.push(`${entry.name}/${sub}: ${String(result.errors[0])}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
