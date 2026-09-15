# Synthia 迁移完成 — 100.69.60.88:/data3/dev/synthia（wenzhuolin-MS-7D33）

- 迁移日期：2026-09-10
- 源：MacBook Pro（/Users/wenzhuolin/dev/synthia-golden，分支 codex/project-agent-side-agent @ 775d044）
- 目标：Linux Ubuntu 24.04，x86_64，/data3（851G 剩 562G），Tailscale `wenzhuolin-ms-7d33`

## 已就位的内容

| 组件 | 位置 | 状态 |
|---|---|---|
| 代码（golden 线全部 88+ commits） | `/data3/dev/synthia-golden`（git worktree，分支 codex/project-agent-side-agent） | ✅ 最新（775d044 常量可靠性修复） |
| m4f 自演化线（原有） | `/data3/dev/synthia`（m4f-recover 分支 + 17 脏文件已 stash 快照） | ✅ 未动 |
| 数据库 synthia_real_ui | 本机 PostgreSQL（角色 synthia_core） | ✅ 17 项目 / 259 tool_runs 全量恢复 |
| 工作区（p1-p16 等 git 仓库） | `~/.synthia/workspaces/` | ✅ |
| mTLS 证书（worker 66 客户端） | `~/.synthia/certs/worker-66/` | ✅ 路径已改写为 Linux 路径 |
| Runtime 会话（agent 状态/对话） | `/data3/dev/synthia-golden/runtime/.runs/` | ✅ |
| Bun | `~/.bun/bin/bun` v1.3.14（与 Mac 一致，避免 1.4.x 兼容问题） | ✅ |
| Core 服务 | systemd user unit `synthia-core`（:5130） | ✅ active，开机自启 + linger |
| Runtime 服务 | systemd user unit `synthia-runtime`（:8791，GLM-4.6） | ✅ active，开机自启 + linger |
| worker 66（Vivado 2021.1） | 不迁移（仍在 Windows 主机），经 Tailscale 100.96.223.49:8443 | ✅ mTLS discover 9 能力验证通过 |

## 迁移中处理的问题

1. **tokens 失配**：DB dump 带的 auth_token 哈希与传的 token 文件不同代 → 重新 bootstrap 一次对齐
2. **证书配置内嵌 Mac 绝对路径**（`/Users/wenzhuolin/...`）→ 改写为 `/home/wenzhuolin/...`
3. **bun 1.4.2 与代码不兼容**（connector-adapter 运行时错误）→ 降级到 1.3.14（与 Mac 一致）
4. **SSH 会话退出杀掉 nohup 进程** → 改用 systemd user service + `loginctl enable-linger`
5. **supervisor 残留进程占 5130** → 清理后 systemd 接管
6. **worktree 布局**：m4f-recover 的 17 个脏文件先 `git stash push -u` 快照（可随时 `git stash pop` 恢复），再用 `git worktree add` 挂 golden 分支 — 两线互不干扰

## 在新机器上继续工作

```bash
ssh wenzhuolin@100.69.60.88
cd /data3/dev/synthia-golden

# token（每次 bootstrap 换新，文件在 /tmp/synthia-tokens.txt）
cat /tmp/synthia-tokens.txt

# 服务管理
systemctl --user status synthia-core synthia-runtime
systemctl --user restart synthia-core

# 日志
journalctl --user -u synthia-core -f
journalctl --user -u synthia-runtime -f

# 跑测试（应 1493 全过）
~/.bun/bin/bun test
```

### 前排工作（按 bench-lib 任务书）

- **T1 已完**（aes/sha3/des 3/3 全绿，含常量可靠性修复闭环）
- **T2 标准压力**：i2c → can → vga_lcd → dspfilters → picorv32（寄存器接口类 vs CPU 类分开对比）
- **T3 收敛极限**：jpegencode → usbhostslave → openmsp430 → fpganes（测差距形态）
- 模板制作五步法（含新的第 2 步常量附录红线）见 `golden/bench-lib/README.md`

### 注意

- **worker 66 仍要在线**：所有 vivado 四步验证经 Tailscale 到 Windows 主机；Windows 重启后需 `schtasks /run /tn synthia-worker`
- **GLM key 明文写在 systemd unit 里**（`~/.config/systemd/user/synthia-runtime.service`）— 生产化时应移到 credential store
- 两个已知平台问题未修根因：Core 重启孤儿化在途作业轮询；worker 进程偶发卡死需任务级重启（均已记入 T1 报告 §4）

## 与 Mac 的关系

Mac 侧（/Users/wenzhuolin/dev/synthia-golden）保留为原环境，两边经 GitHub 远端（whosl/Synthia）同步。Mac 上的本地栈（Core 5130/Runtime 8791/worker 66 客户端）仍可运行，但**后续主工作面在 MS-7D33**。
