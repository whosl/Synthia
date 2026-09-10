# Web 前端重组迁移计划：shadcn-vue + Reka UI + Tailwind v4

状态：✅ 全部完成（2026-09-10 启动，2026-09-11 收尾）

## 1. 目标与边界

把 `web/` 从「零组件库 + 6,050 行手写 CSS」迁移到 shadcn-vue 体系，获得：

- 可维护的原语层（焦点管理、键盘导航、定位交给 Reka UI，不再自管）；
- 一套 CSS-first 的设计令牌系统（Tailwind v4 `@theme`），取代散落的手写变量引用；
- 现代 AI 产品观感，且不牺牲 spec §4 定下的「Claude 的色，IDE 的密度」（13px 基准、暖中性底 + 陶土强调色）。

**不动的东西**：对话流核心（ChatFeed 状态机、`domain/markdown-stream.ts` 流式分块、ReasoningItem / ToolCallItem / CodeCard 的行为逻辑）、Monaco 封装、所有 API/domain 层、主题切换机制（`domain/theme.ts` + `data-theme` attribute）。

## 2. 目标栈

| 层 | 选型 | 说明 |
|---|---|---|
| 样式引擎 | tailwindcss v4 + `@tailwindcss/vite` | CSS-first，无 tailwind.config.js；仅引入 theme+utilities，**跳过 preflight**（避免与现有 reset 冲突） |
| 无头行为层 | reka-ui v2 | shadcn-vue 组件内核 |
| 组件层 | shadcn-vue CLI | 组件源码拷入 `src/components/ui/<name>/`，归本仓库所有 |
| 图标 | lucide-vue-next | 逐步替代 `ui/Icon.vue` 手绘 SVG |
| 通知 | vue-sonner | 消灭三处 `setTimeout` 横幅 notice |

暗色模式：用 Tailwind v4 `@custom-variant dark` 映射到现有 `[data-theme="dark"]` attribute，`domain/theme.ts` 一行不改。

## 3. 令牌映射（双向兼容，渐进迁移）

现有 `style.css` 语义令牌（`--surface-*` / `--text-*` / `--state-*` / `--accent*`）通过 `@theme inline` 注册为 Tailwind 颜色工具类，值仍指向运行时变量：

```css
@theme inline {
  --color-bg-base: var(--surface-base);
  --color-bg-panel: var(--surface-panel);
  --color-bg-raised: var(--surface-raised);
  --color-bg-hover: var(--surface-hover);
  --color-fg: var(--text-primary);
  --color-fg-secondary: var(--text-secondary);
  --color-fg-muted: var(--text-muted);
  --color-line: var(--border-subtle);
  --color-line-strong: var(--border-strong);
  --color-accent: var(--accent);
  --color-accent-hover: var(--accent-hover);
  --color-ok / --color-warn / --color-danger / --color-info: var(--state-*) …
}
```

迁移中途：旧 scoped CSS 继续引用旧变量，新代码用 Tailwind 类，两套指向同一份运行时值，可逐组件搬、随时回滚。

## 4. 现有手写件 → shadcn-vue 映射

| 现有 | 替换为 | 收益 |
|---|---|---|
| `ui/Button.vue` | `ui/button/` | variant 语义一致，直接换 |
| `ui/Badge.vue` + StatusBadge | `ui/badge/` | 直接换 |
| `ui/Dropdown.vue`（手写 outside-click） | `ui/dropdown-menu/` | 白得焦点管理/键盘导航 |
| `ui/Tooltip.vue`（纯 CSS） | `ui/tooltip/` | 自动定位/碰撞检测 |
| `ui/Splitter.vue`（187 行拖拽+持久化） | `ui/resizable/` | 自带持久化 |
| CreateProjectDialog（原生 dialog） | `ui/dialog/` | 焦点陷阱/滚动锁定 |
| ProjectView veil 抽屉 | `ui/sheet/` | 移动端断点抽屉化现成 |
| StageRail Teleport 浮层 | `ui/dialog/` | — |
| AgentPaneTabs / ViewSwitcher | `ui/tabs/` | — |
| use-chip-popover.ts | `hover-card` + `popover` | 语义拆分 |
| 三处 setTimeout notice | `sonner` | 纯增量 |
| ChatFeed 吸底/思考卡/工具卡 | 保留自研，仅换皮 | Vue 版无 chat 原语（unovue/shadcn-vue#1861） |

## 5. 阶段划分

| 阶段 | 内容 | 出口判据 | 粗估 |
|---|---|---|---|
| 0 试点 | 基建接入 + LoginView 迁移 | check/test/build 全绿，双主题截图确认 | 0.5–1d |
| 1 门户页 | ProjectListView / ApprovalsView + portal.css（796 行全局样式）消除 | portal.css 删除 | 1–2d |
| 2 原语替换 | ui/ 五件换 shadcn 版 + Sonner 接入 | 旧 ui/ 原语删除，465 测试全绿 | 1–2d |
| 3 ProjectView 重组 | 拆分 2,991 行巨石；Splitter→Resizable；veil→Sheet；notice→Sonner | ProjectView 拆为壳 + composables | 2–3d |
| 4 大面板换皮 | SideTasksPanel / FormalDeliveryPanel / HistoricalMaterialsPanel（合计 ~2,770 行） | 三个面板 scoped CSS 清零 | 2–3d |
| 5 对话区换皮 | ChatFeed 系视觉 Tailwind 化，行为不动 | chat 组件 scoped CSS 清零 | 1–2d |

全程渐进合入，每阶段独立 PR，不停功能开发。

## 6. 风险与对策

- **密度气质跑偏**：shadcn 默认 SaaS 风（14–16px、大留白）。对策：`@theme` 里显式覆盖字号/间距/圆角为本仓库令牌，组件拷入后即调密度。
- **preflight 冲突**：Tailwind 全局 reset 与现有 reset/组件样式叠加风险。对策：导入时跳过 preflight（`tailwindcss/theme.css` + `tailwindcss/utilities.css`）。
- **portal.css 全局污染**：非 scoped，类名可能与迁移期新样式碰撞。对策：阶段 1 整体消灭它，不做局部修补。
- **Reka UI v2 较新**：个别组件可能有回归；源码在仓库内，可直接修。
- **对话区无现成件**：chat 原语 Vue 版未移植，ChatFeed 继续自研——这本就是计划，不算风险。

## 7. 试点记录（阶段 0，2026-09-10 已完成）

实际改动：

- 依赖：`tailwindcss` `@tailwindcss/vite` `clsx` `tailwind-merge` `class-variance-authority` `reka-ui` `lucide-vue-next` `@vueuse/core`（shadcn-vue Input 依赖 useVModel）。
- `vite.config.ts`：接入 tailwindcss 插件 + `@` → `src` 别名；`tsconfig.json` 同步 paths。
- `src/tailwind.css`（新增）：只导入 theme+utilities（跳过 preflight）；`@custom-variant dark` 映射到 `[data-theme="dark"]`；shadcn 语义变量桥接到 style.css 现有令牌；`@theme inline` 注册工具类。注意 shadcn 的 `--accent`（悬停底色）映射到 `--surface-hover`，品牌色走 `--primary`。
- `components.json` + `src/lib/utils.ts`（cn）+ CLI 拉取 `ui/button` `ui/input` `ui/label`。
- `views/LoginView.vue`：219 行（含 115 行 scoped CSS）→ 纯 Tailwind 模板，零 scoped CSS；文案/交互/断点（800px）完全保留；手绘 Icon 换 lucide（Cpu/Sparkles/ArrowRight/LoaderCircle）。

验证：vue-tsc 干净；`bun test` 483 全过；build 成功；浏览器实测双主题变量链解析正确（dark: 按钮 #d97757 / panel #262624；light: 按钮 #c15f3c）；输入→按钮解禁→提交→跳转 `/projects` 全流程通。

踩坑记录：

- shadcn-vue CLI 需要 `bun` 在 PATH 上（`spawn bun ENOENT`），用 `export PATH="$HOME/.bun/bin:$PATH"` 解决；registry 偶发抖动，重试即可。
- Tailwind v4 utilities 在 layer 内，未分层的旧 scoped CSS 优先级更高——迁移期内若有类冲突，以删旧样式为准，别叠 `!important`。
- `@theme inline` 里 `--font-sans: var(--font-sans)` 会自引用成环，字体栈需写字面量。

## 8. 完成记录（2026-09-11）

六个阶段全部落地，五个提交：试点基建 → 原语替换（AppButton/AppBadge 包装、Resizable 三栏、vue-sonner）→ 门户页 + portal.css 删除（796 行）→ 三个大面板 + 对话区换皮 → ProjectView 收尾（notice→toast×13、veil→utilities）+ 全局清扫（StageRail→Dialog、Icon.vue 删除、evolution/* 补迁）→ 最终清扫（notice prop 管道删除、层叠残余缩减）。

终态：手写 CSS 从 ~6,050 行降到不足 400 行（残余仅为 keyframes、Vue Transition 类、`:deep()` markdown 排版、以及必须压过未分层 `pre/code` 元素规则的极少数规则，均带注释说明）；`web/src/styles/portal.css`、`ui/Icon.vue`、`StatusBadge.vue` 等手写原语全部删除。校验：vue-tsc 干净，`bun test` 510 全过，build 成功；浏览器/mock 巡检 /projects、/approvals、/projects/p1 及窄屏断点全部正常，双主题令牌链实测正确。

过程中的额外收益：修掉多处引用不存在令牌（--state-success/--state-warning/--danger/--surface）的死样式（PermissionCard 深色下一直是奶油色）；style.css 元素规则迁入 `@layer base`，Tailwind 工具类不再被全局 reset 反杀。

已知留白（不阻塞，按需跟进）：三个面板的 notice prop 已删但 EvolutionView 自有 notice 横幅保留；`--space-7` 未定义导致的零 padding 属原作者 bug（保持原样）；TaskSwitcher 行高随 shadcn DropdownMenuItem 默认密度有 ~2px 变化；vue-sonner 主题样式走运行时变量绑定，后续可换 class 方案。
