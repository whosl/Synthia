# Web UI 现代化改造 P0–P8（完成台账）

前置：`web-ui-shadcn-migration-plan.md`（shadcn-vue + Reka UI + Tailwind v4 全量迁移）完成后，用户要求「接着改造整个 Synthia」。本档案记录 2026-09-13 ~ 09-14 的现代化改造全程，**全部阶段已完成并部署 golden**。

调研依据（P0 前）：setproduct AI chat 解剖学、Linear 设计系统拆解、2026 编码 agent 横评（Claude Code Agent View / Devin / Cursor Background Agents）。核心结论：信息流就是产品、工具调用降噪（Cursor/Devin 折叠模式）、"immediate, not fast" 动效哲学、等宽数字 + 收紧字距是最便宜的精致感。

## 阶段台账

| 阶段 | 内容 | 提交 |
|---|---|---|
| P0 | 信息流降噪：连续工具调用折叠（`domain/chat-groups.ts` 纯函数 + 13 单测）、轮次分隔线、阅读列 720px；Linear 排版（标题字距、tabular-nums）；中央欢迎页 → 项目主页（G0–G4 步进器 + 最近动态 + 情境化 CTA） | `cbef28e` |
| 修复链 | flag 构建丢失（裸 build 编译掉四个 VITE_FEATURE_*，golden 部署必须 `build:golden`）；权限卡/上下文水位环/跳过权限开关在 ChatFeed 重写时断线（契约在、渲染被摘）修复；盒式 composer（`#controls` 插槽保住 composer 职责边界） | `e926890`、`88249fc` |
| P1 | 顶栏双 chip 合一 `StageStatusChip`（状态点 + 摘要 + 400px 弹层收全量信息，`implChipText` 抽共用归约）；主流程四颗胶囊徽章改 dot 变体 | `abcfe6f` |
| P2 | 「本轮改动」汇总卡（`domain/change-cards.ts` + `ChangeListCard.vue`）：durable 会话按用户消息时间窗归集制品修订，legacy audit 归集 doc 卡；点行直开 Monaco 版间 diff | `db42524`、`45a1866` |
| P3 | 基座收口：新增 sheet/select/textarea/checkbox/radio-group/card/alert/empty/accordion 九族原语（55 文件）；死代码清除（TaskSwitcher/StageRail/ReplySegments）；`util/format-time.ts` 收拢三处重复；PanelHeader/StatCard 公共组件 | `2572a28` |
| P4 | 门户：PageShell 导航打磨、ProjectListView 骨架/空态/行密度、CreateProjectDialog 上新原语；修 SelectTrigger/SelectItem 对齐 + 全量 ui 组件模板可解析性守卫测试 | `8336175`、`1cb4f2d` |
| P5 | 面板体系：ProjectView 四个手写 veil 抽屉全部迁 `ui/sheet`（焦点陷阱/滚动锁/Esc 白得）；三大面板（SideTasks/FormalDelivery/HistoricalMaterials）+ RecordsPanel 换皮；修复 visible-link 主线运行记录抽屉入口 | `529d71e`、`5b73bdd` |
| P6 | 编辑器体验：`styles/markdown.css` 统一 MessageItem/DocPreview 排印；VersionBar 版本对比（下拉 + diff 直达）；欢迎页步进器；CodeEditor 协作打磨 | `03c617b` |
| P7 | 审批中心 + 自进化：ApprovalCard 抽组件、可见性感知 30s 轮询、ui Input/Skeleton/Empty；EvolutionView 族 StatCard 复用、危险操作（Archive/禁用）接 `ConfirmDialog`（shadcn Dialog + danger 按钮） | `cb49d26` |
| P8 | 收尾巡检：7 表面无头截图（真实 p17 + mock p1 + 窄屏 + 浅色主题）全过；键盘可达性抽查（焦点陷阱/Esc 关对话框/Esc 关抽屉）全 PASS；本档案；推 origin | 本次 |

## 架构事实（后续开发照此走）

- **原语清单** `web/src/components/ui/`：button/badge/dialog/dropdown-menu/input/label/skeleton/tabs/tooltip/resizable + sheet/select/textarea/checkbox/radio-group/card/alert/empty/accordion。包装层 `AppButton`/`AppBadge`（含 `variant="dot"`）保留旧调用契约。
- **令牌桥**：shadcn 语义变量全部指向 `style.css` 既有令牌（唯一色值来源不变）；`dark:` variant 映射 `[data-theme="dark"]`。圆角刻度 sm=4/md=6/lg=10/xl=14；动效 120/150/180ms 令牌 + 应用层统一 `duration-150`（200/300 仅 shadcn 原语内部大面板动画，不偏离上游）。全局尊重 `prefers-reduced-motion`。
- **动效哲学**：hover/确认类 "immediate, not fast"（<150ms）；入场/退场动画只用于确认事情已发生。
- **composer 职责边界**：`ChatComposer` 只管消息语义；头部控件经 `#controls` 插槽由 `ChatFeed` 喂入并冒泡到 ProjectView。别给 composer 加权限类 props。
- **ChangeListCard 归因**：durable 会话用时间窗（用户消息 ts 划窗 + 制品修订 created_at 落窗），首轮前登记 = 种子，自动排除；无 ts 退化为 doc 卡模式。
- **部署**：golden 检出走 `git fetch <worktree> platform-ops-golden && git checkout --detach FETCH_HEAD`，构建必须 `bun run build:golden`（固化四个 feature flag），然后重启 `vite preview --port 4173`。
- **验证基线**：`bun test` 552 pass / 0 fail；`bun run check`（vue-tsc）干净；产物级抽查 feature flag 为 `l("1")` ×4。

## 巡检记录（P8）

- 截图面：real /projects、/projects/p17（工作台全要素：步进器/工具折叠/盒式 composer）、/approvals、/evolution、浅色 /approvals、窄屏 700px /projects、mock /projects + p1 工作台 —— 全部渲染正常。
- 键盘：Dialog 焦点陷阱（3×Tab 不逃逸）、Esc 关对话框、Esc 关 Sheet 抽屉 —— 全 PASS（reka-ui 继承行为，实测确认）。
- 遗留：`--space-7` 未定义（原作者 bug，保持原样）；正式流程/自进化面板的分类标签仍用胶囊（密集表格区刻意保留）。
