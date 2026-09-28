# Synthia 平台沙箱部署（Core + Runtime + 自进化 + Web）

目标平台：Daytona 管理的 Debian13 Docker 沙箱（Node 20.19.4、无 Bun、npm 走
npmmirror、对外仅 5173 预览代理 + 8000 `__backend/` 转发、出站自由）。
仓库侧配套改动：`core/src/compat/`（Bun/Node 双运行时）与 web 的
`VITE_PLATFORM_PREVIEW=1` 构建模式（相对 base + hash 路由 + 运行时 `__backend`
前缀解析，见 `web/src/api/platform.ts`）。

## 架构

```text
浏览器 ── {预览根}/            → 5173 python http.server（web/dist 静态）
       └─ {预览根}/__backend/* → 8000 node core-serve.mjs（剥前缀转发）
                                    └─ 127.0.0.1:5432 嵌入式 PG17（pguser + trust）
                                    └─ 出站 → connect.wenzhuolin.xyz（家里 66 的 Vivado worker）
```

当前构建脚本已包含 Runtime（8790）和自进化服务。自进化服务在专用令牌齐备时启动。

此目录面向可选的 Node 沙箱，当前正式站点沿用本机 Bun + systemd；见 [`../production-release.md`](../production-release.md)。

## 一次部署流程

### 本机（仓库根，Bun 1.4.1）

```bash
bash deploy/platform/build.sh          # 产出 dist/synthia-platform-<date>.tar.gz
pg_dump --inserts --no-owner --no-privileges -h 127.0.0.1 -U synthia synthia > synthia.dump
psql ... -tAc "<基线计数查询>"          # 结果填进 sandbox/BASELINE.txt
```

（`--inserts` 必须：沙箱侧没有 psql/pg_restore，恢复用 node:pg 整文件执行。）

### 沙箱（两个文件经平台 /upload 上传后）

```bash
mkdir -p /root/synthia && tar -xzf /upload/synthia-platform-<date>.tar.gz -C /root/synthia
cd /root/synthia
cp env.example env.real                # 按需填 CF creds（不填则 connector 503 降级）
bash 10-setup-pg.sh                    # 嵌入式 PG17（~60MB npmmirror；建 pguser；trust 回环）
bash 20-restore-db.sh /upload/synthia.dump   # 恢复 + 计数比对 BASELINE.txt
bash 30-start.sh                       # core :8000 + web :5173 + 自检
# 然后调 generate_preview_url(5173) 生成预览路径
```

现有 web 登录 token 随 `auth_token` 表迁移，**继续可用**。

## 日常运维

- **改码重部署**：本机 `build.sh` → 上传新 tar → 解包替换（更新既有实例不重新恢复数据库；保留 `env.real`、
  `pg-data/`、`pg-bootstrap/`、`logs/`）→ `bash 30-start.sh`
- **数据冷备**：`bash snapshot-db.sh`（短暂停库 tar pg-data → 重启；产物在
  `backups/`。沙箱重建即丢——重要节点把备份下载出沙箱）
- **日志**：`logs/core.log`、`logs/web.log`、`pg-home/postgres.log`
- **SSE 验证口径**：`{预览根}/__backend/api/v1/...` 若平台实际是透传而非剥
  前缀（文档口径为剥前缀），浏览器将 404——用 8000 端口 echo 服务一步确认后，
  在 core 侧加 strip 中间件即可修复

## 已知边界（对照探测报告）

| 项 | 状态 |
|---|---|
| Bun | 沙箱弱网装不上 → Node 20 跑 `--target=node` bundle |
| PG | 嵌入式 zonky 17.10（含 pgcrypto/pg_trgm），无 psql/pg_dump → node:pg 恢复 |
| 持久性 | 同实例跨会话已证；销毁重建未证 → snapshot-db.sh 冷备兜底 |
| 端口 | 仅 5173/8000 有既定通道；core 绑 127.0.0.1:8000（预览代理沙箱内回环） |
| connector | 出站 connect.wenzhuolin.xyz 可达；无 CF creds 时降级 503 |
