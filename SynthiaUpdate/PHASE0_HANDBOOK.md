# Synthia Phase 0 开发手册

> 文档级别：从零照抄就能干完。
> 假设读者：能用 git / 终端 / VSCode，但不熟这个仓库。
> 配套阅读：`SynthiaUpdate/spec.md`（产品愿景）、`SynthiaUpdate/update.md`（升级路线）、`futureWork.md`（已知风险延后项）。

---

## 目录

- [Phase 0 是什么](#phase-0-是什么)
- [0. 准备工作](#0-准备工作)
- 后端任务
  - [T1. 修 4 个失败的测试](#t1-修-4-个失败的测试)
  - [T2. `command_runner` 改 `shell=False`](#t2-command_runner-改-shellfalse)
  - [T3. 审批后写文件加 workspace 沙箱](#t3-审批后写文件加-workspace-沙箱)
  - [T4. Web API 加 token 鉴权 + 默认绑定 localhost](#t4-web-api-加-token-鉴权--默认绑定-localhost)
  - [T5. 修 `a.kind` 与 `run_simulation` 假成功](#t5-修-akind-与-run_simulation-假成功)
  - [T6. SPA 静态路径穿越修复](#t6-spa-静态路径穿越修复)
  - [T7. 开分支 + 写 5 篇 ADR](#t7-开分支--写-5-篇-adr)
  - [T8. `synthia` CLI 软链 + 品牌别名](#t8-synthia-cli-软链--品牌别名)
- 前端设计任务
  - [D1. 更新颜色 token（Claude 暖色）](#d1-更新颜色-token-claude-暖色)
  - [D2. AppShell 改为 Cursor 三栏](#d2-appshell-改为-cursor-三栏)
  - [D3. `StatusPill` 新组件](#d3-statuspill-新组件)
  - [D4. `ToolCallBlock` 重写](#d4-toolcallblock-重写)
  - [D5. `ApprovalBlock` 重写](#d5-approvalblock-重写)
  - [D6. `Composer` 改造](#d6-composer-改造)
  - [D7. `⌘K` 命令面板](#d7-k-命令面板)
- [Phase 0 整体验收](#phase-0-整体验收)
- [Phase 0 之后](#phase-0-之后)

---

## Phase 0 是什么

**目标**：把当前 EdAgent-Vivado 仓库从「能跑但有安全坑+测试不绿+UI 朴素」整理成「能稳、能审计、长得像 Cursor + Claude 的 Synthia v1.0 起点」。

**为什么先做这些**：
1. 现有代码有 3 类 P0 安全问题（命令注入、路径穿越、API 无鉴权），不修不能继续往上叠功能。
2. 有 4 个测试失败，再写新代码会让 CI 越来越脏。
3. 前端要变成 Synthia 品牌，颜色/布局/组件先调一遍。
4. 写 ADR 锁死决策（xpr-first、内部 connector、不切栈 Next.js），避免反复返工。

**时间预期**（一个人 vibe coding）：

| 块 | 任务 | 预估 |
|---|---|---|
| 后端 hygiene | T1–T8 | 5–7 个工作日 |
| 前端设计 | D1–D7 | 6–9 个工作日 |
| 合计 | | **约 2 周** |

可以前后端并行做。

---

## 0. 准备工作

### 0.1 检查开发环境

打开终端（Windows 用 Git Bash 或 PowerShell，本手册命令默认 Git Bash 语法），进入仓库：

```bash
cd /e/dev/edagent-vivado
```

检查必需工具：

```bash
python --version    # 应 ≥ 3.11
node --version      # 应 ≥ 20
git --version
```

如果 `python` 找不到，试 `python3` 或 `py`。

### 0.2 安装依赖

```bash
pip install -e ".[dev,ssh]"
cd frontend && npm install && cd ..
```

如果遇到代理/网络问题，参考 `AGENTS.md`。

### 0.3 跑一次测试，记录基线

```bash
python -m pytest -k "not agent_smoke" -q --tb=no
```

**期望**：`416 passed, 4 failed`（与上次评审一致）。如果失败数不同，先把多出来的失败修了再开始 Phase 0。

### 0.4 开发分支

```bash
git checkout -b product/synthia-phase0
git push -u origin product/synthia-phase0
```

之后每个任务 **单独一个 commit**，commit message 用任务编号开头，例如：

```
T1: fix 4 failing tests (path_mapper, mock_synth_parse x2, remote_runner)
```

这样万一某项要回滚，git revert 一条就行。

### 0.5 文档语境

后面所有路径形如 `src/edagent_vivado/...` 都是**仓库根目录下的相对路径**（即 `E:\dev\edagent-vivado\` 下面）。

代码示例如果有 `# ← NEW` / `# ← CHANGED` 注释，**只是给你看的提示**，实际代码不要加这些注释。

---

# 后端任务

## T1. 修 4 个失败的测试

### 目标
让 `pytest -k "not agent_smoke"` 全绿。

### 失败列表
1. `tests/test_phase3a.py::test_path_mapper_roundtrip`
2. `tests/test_e2e_cases.py::test_case6_remote_runner_check`
3. `tests/test_integration.py::test_vivado_runner_mock_synth_with_parse`
4. `tests/test_integration.py::test_vivado_runner_mock_synth_failure_parse`

---

### T1.1 `test_path_mapper_roundtrip`

**症状**：Windows 下 `Path("/work/proj").resolve()` 会拼上当前盘符（如 `E:\work\proj`），而测试比较的是未 resolve 的 `Path("/work/proj/rtl/top.v")`，两边路径表示不同。

**改文件**：`src/edagent_vivado/harness/path_mapper.py`

**当前代码**（第 11–13 行）：

```python
def __init__(self, local_root: str | Path, remote_root: str) -> None:
    self.local_root = Path(local_root).resolve()
    self.remote_root = remote_root.rstrip("/") or "/tmp/edagent_remote"
```

**改成**：

```python
def __init__(self, local_root: str | Path, remote_root: str) -> None:
    p = Path(local_root)
    # only resolve if path actually exists; avoid Windows drive-letter injection for synthetic test paths
    self.local_root = p.resolve() if p.exists() else p
    self.remote_root = remote_root.rstrip("/") or "/tmp/edagent_remote"
```

**`to_remote` 也要相应改**（第 15–21 行）：

```python
def to_remote(self, local_path: str | Path) -> str:
    p = Path(local_path)
    abs_p = p.resolve() if p.exists() else p
    try:
        rel = abs_p.relative_to(self.local_root)
    except ValueError:
        return f"{self.remote_root}/{abs_p.name}"
    return f"{self.remote_root}/{rel.as_posix()}"
```

### T1.2 `test_case6_remote_runner_check`

**症状**：`ImportError` —— 某个旧 class 没有从模块里 export。

**先确认是哪个 class**：

```bash
python -m pytest tests/test_e2e_cases.py::test_case6_remote_runner_check -x 2>&1 | head -20
```

记下报错的 `ImportError: cannot import name 'XXX' from 'yyy'`。

**典型修法**：在 `yyy/__init__.py` 里加 `from .module import XXX`，或直接改测试用真实存在的名字。

如果报错的 class 已经被删除/重命名，直接**改测试**：

```python
# 例：原本
from edagent_vivado.harness.remote_executor import RemoteRunnerCheck
# 改成
from edagent_vivado.harness.remote_executor import RemoteExecutor as RemoteRunnerCheck
```

具体改哪个名字以实际报错为准。

### T1.3 / T1.4 mock_synth_parse 两个

**症状**：测试期望返回 dict 里有某些 key（如 `wns` / `tns`），但当前 mock runner 不返回。

**先看测试**：

```bash
python -m pytest tests/test_integration.py::test_vivado_runner_mock_synth_with_parse -x 2>&1 | tail -30
```

找到形如：

```
assert "wns" in result
KeyError or AssertionError
```

**修法二选一**：

- A. 让 mock runner 返回完整 dict（动 `harness/vivado_runner.py` 的 mock 分支）。
- B. 改测试断言（如果测试期望本身就是错的）。

**推荐 A**——产品语义上 mock 应该长得像真的。

打开 `src/edagent_vivado/harness/vivado_runner.py`，找 mock 分支（搜 `force_mock` 或 `mock` 字样），让返回 dict 里包含：

```python
{
    "status": "success" | "failure",
    "wns": 0.812,        # mock 假数据
    "tns": 0.0,
    "lut": 1234,
    "ff": 5678,
    "report_paths": {...},
    "log_path": "...",
}
```

具体字段照测试要求的来。

### T1 验收标准

```bash
python -m pytest -k "not agent_smoke" -q --tb=no
```

**必须显示** `420 passed`（或同等无 fail 数量）、`0 failed`。

提交一次 commit：

```bash
git add -A && git commit -m "T1: fix 4 failing tests (path_mapper, e2e_case6, mock_synth_parse)"
```

---

## T2. `command_runner` 改 `shell=False`

### 目标
消除「白名单可绕过 + shell 注入」风险。

### 背景
当前 `subprocess.run(..., shell=True)`，整条命令字符串交给 shell 解释。即使 `python` 在白名单里，`python -c "import os; os.system('rm -rf /')"` 也能跑。

### 改文件
`src/edagent_vivado/harness/command_runner.py`

### 改造步骤

#### 步骤 1：把 `command: str` 接口改成接受 `list[str]` 或自动 split

**当前 `run()` 签名**（约第 121 行）：

```python
def run(self, command: str, cwd=None, timeout=None, env=None, log_label="") -> CommandResult:
```

**改成支持双形态**：

```python
def run(
    self,
    command: str | Sequence[str],
    cwd: str | Path | None = None,
    timeout: int | None = None,
    env: dict[str, str] | None = None,
    log_label: str = "",
) -> CommandResult:
    """Execute a command. Accepts either str (will be shlex.split) or list[str] argv."""
    if isinstance(command, str):
        try:
            argv = shlex.split(command, posix=True)
        except ValueError as exc:
            return CommandResult(
                command=command,
                cwd=str(cwd or self.workspace_root),
                return_code=-1,
                error=f"Failed to parse command: {exc}",
            )
    else:
        argv = list(command)

    if not argv:
        return CommandResult(command="", cwd="", return_code=-1, error="empty command")

    if not self._check_argv(argv):
        return CommandResult(
            command=" ".join(argv),
            cwd=str(cwd or self.workspace_root),
            return_code=-1,
            error=f"Command rejected by allowlist: {argv[0]}",
        )
    # ... 后续 subprocess.run(argv, shell=False, ...)
```

#### 步骤 2：新增 `_check_argv` 方法（替代 `check_allowed`）

```python
def _check_argv(self, argv: list[str]) -> bool:
    """Validate full argv list, not just first token."""
    if not argv:
        return False
    base = argv[0]
    # strip path
    base_name = Path(base).name
    # vivado may come as full path
    if base_name == "vivado" or base_name in ALLOWED_COMMANDS:
        pass
    else:
        logger.warning("Command not in allowlist: %s", base_name)
        return False

    # forbid dangerous flags on python interpreters
    if base_name in ("python", "python3"):
        for arg in argv[1:]:
            if arg in ("-c", "-m"):
                # allow only specific module invocations; reject inline -c
                if arg == "-c":
                    logger.warning("python -c is forbidden via CommandRunner")
                    return False

    # join for pattern check (now that shell=False, this catches argv-embedded threats too)
    joined = " ".join(argv)
    for pat in BLOCKED_PATTERNS:
        if pat.search(joined):
            logger.warning("Blocked pattern matched: %s", pat.pattern)
            return False
    return True
```

#### 步骤 3：subprocess 调用改 `shell=False`

把 `subprocess.run(resolved, shell=True, ...)` 改成 `subprocess.run(argv, shell=False, ...)`。

`_resolve_command` 也要重写——之前替换 `vivado` 字符串前缀，现在变成 argv 第一个元素替换：

```python
def _resolve_argv(self, argv: list[str]) -> list[str]:
    if self._vivado_path and argv and Path(argv[0]).name == "vivado":
        return [str(self._vivado_path), *argv[1:]]
    return argv
```

调用处：

```python
resolved_argv = self._resolve_argv(argv)
proc = subprocess.run(
    resolved_argv,
    shell=False,
    cwd=effective_cwd,
    stdout=so,
    stderr=se,
    timeout=timeout or self.timeout,
    env=env or None,
)
```

#### 步骤 4：保留 `check_allowed` 作为兼容包装（避免破坏外部调用）

```python
def check_allowed(self, command: str) -> bool:
    try:
        argv = shlex.split(command, posix=True)
    except ValueError:
        return False
    return self._check_argv(argv)
```

#### 步骤 5：cwd 沙箱

把 `effective_cwd` 检查一下：

```python
effective_cwd = Path(cwd).resolve() if cwd else self.workspace_root
ws_root = self.workspace_root.resolve()
try:
    effective_cwd.relative_to(ws_root)
except ValueError:
    return CommandResult(
        command=" ".join(argv),
        cwd=str(effective_cwd),
        return_code=-1,
        error=f"cwd outside workspace_root: {effective_cwd}",
    )
```

### 新增测试

在 `tests/test_command_runner.py` 加：

```python
def test_command_runner_rejects_python_dash_c():
    r = CommandRunner(workspace_root=".")
    res = r.run('python -c "import os; os.system(\'echo pwned\')"')
    assert res.return_code == -1
    assert "forbidden" in (res.error or "").lower() or "rejected" in (res.error or "").lower()

def test_command_runner_rejects_shell_chaining_via_str():
    r = CommandRunner(workspace_root=".")
    # shell metachars no longer interpreted; "rm" not allowlisted
    res = r.run("echo ok; rm -rf /tmp/x")
    assert res.return_code == -1

def test_command_runner_accepts_list_argv():
    r = CommandRunner(workspace_root=".")
    res = r.run(["echo", "hello"])
    assert res.return_code == 0
```

### T2 验收标准

1. `rg "shell=True" src/edagent_vivado/` 只允许出现在 **测试文件** 或注释里，业务代码 0 处。
2. 新增 3 个测试通过。
3. 全量测试仍 0 failed。
4. 现有调用 `run("vivado -mode batch -source x.tcl")` 仍能工作（向后兼容）。

提交：

```bash
git commit -am "T2: command_runner shell=False with argv allowlist"
```

### 常见坑
- 某些 Vivado Tcl 命令带空格参数（如 `-source "C:\path with space\x.tcl"`），改 argv 后 shlex.split 会正确处理，但调用方传字符串时记得用引号。
- Windows 上 `subprocess.run(argv, shell=False)` 默认查 `PATH`，但 `.bat` 必须给全路径或用 `shell=True`——Vivado 本身是 `vivado.bat`。这点是**例外**：要么给 `vivado_path` 配置全路径，要么 Vivado 走单独的 `_run_vivado_argv` 函数允许 `.bat`。

---

## T3. 审批后写文件加 workspace 沙箱

### 目标
人工批准 patch 后，Agent 提议的路径不能逃出项目根目录。

### 改文件
`src/edagent_vivado/harness/file_patch_policy.py`

### 当前问题（第 74–101 行）

```python
def apply_approved_file_item(fi) -> tuple[bool, str]:
    fp = Path(fi.path)
    if fi.action == "create":
        if fp.exists():
            return False, ...
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(fi.content)
        return True, "created"
    ...
```

- `fi.path` 没 resolve、没 root containment 检查。
- 末尾 fallthrough 默认 write_text（未知 action 也写）。

### 改造

#### 步骤 1：新增 root containment helper

文件顶部加：

```python
class PatchPathError(ValueError):
    pass

def _ensure_under_root(path: Path, root: Path) -> Path:
    """Resolve and verify path is under root. Raise PatchPathError otherwise."""
    abs_root = root.resolve()
    abs_path = (root / path).resolve() if not path.is_absolute() else path.resolve()
    try:
        abs_path.relative_to(abs_root)
    except ValueError as exc:
        raise PatchPathError(
            f"path {abs_path} is outside project root {abs_root}"
        ) from exc
    return abs_path
```

#### 步骤 2：改 `apply_approved_file_item` 签名

```python
def apply_approved_file_item(fi, *, project_root: str | Path) -> tuple[bool, str]:
    """Apply one approved FileItem within project_root sandbox."""
    try:
        fp = _ensure_under_root(Path(fi.path), Path(project_root))
    except PatchPathError as exc:
        return False, f"refused: {exc}"

    if fi.action == "create":
        if fp.exists():
            return False, f"refused: file already exists: {fi.path}"
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(fi.content)
        return True, "created"

    if fi.action == "modify":
        if not fp.exists():
            return False, f"refused: file not found: {fi.path}"
        parsed = parse_modify_payload(fi.content)
        if not parsed:
            return False, "refused: invalid modify payload"
        old_text, new_text = parsed
        ok, msg = apply_text_patch(fp, old_text, new_text)
        return ok, msg

    if fi.action == "delete":
        if fp.exists():
            fp.unlink()
        return True, "deleted"

    # explicit reject unknown action (no fallthrough!)
    return False, f"refused: unknown action: {fi.action!r}"
```

#### 步骤 3：调用方传 `project_root`

找出所有 `apply_approved_file_item(` 调用点：

```bash
rg "apply_approved_file_item" src/
```

改每个调用处，从 `task` / `session` / `project` 上下文取 `root_path`，作为 `project_root` 传入。典型位置是 `harness/approval_apply.py`：

```python
from edagent_vivado.repository.store import project_get

proj = project_get(task["project_id"]) if task.get("project_id") else None
root = proj.get("root_path") if proj else "."
ok, msg = apply_approved_file_item(fi, project_root=root)
```

### 新增测试

在 `tests/test_file_patch_policy.py` 加：

```python
def test_apply_refuses_outside_root(tmp_path):
    from edagent_vivado.harness.file_patch_policy import apply_approved_file_item
    from types import SimpleNamespace
    fi = SimpleNamespace(path="../../etc/passwd", action="create", content="x")
    ok, msg = apply_approved_file_item(fi, project_root=tmp_path)
    assert not ok
    assert "outside" in msg

def test_apply_refuses_absolute_outside(tmp_path):
    from edagent_vivado.harness.file_patch_policy import apply_approved_file_item
    from types import SimpleNamespace
    fi = SimpleNamespace(path="/etc/passwd", action="create", content="x")
    ok, msg = apply_approved_file_item(fi, project_root=tmp_path)
    assert not ok

def test_apply_refuses_unknown_action(tmp_path):
    from edagent_vivado.harness.file_patch_policy import apply_approved_file_item
    from types import SimpleNamespace
    fi = SimpleNamespace(path="ok.txt", action="overwrite", content="x")
    ok, msg = apply_approved_file_item(fi, project_root=tmp_path)
    assert not ok
    assert "unknown action" in msg
```

### T3 验收标准

1. 3 个新测试通过。
2. 所有原本调用 `apply_approved_file_item` 的地方都传了 `project_root`，没漏。
3. 全量测试 0 failed。
4. 手工试一次：在 UI 提议 `../../tmp/x.txt`，审批通过后看到 `refused: path ... is outside project root`。

提交：

```bash
git commit -am "T3: sandbox file patch apply to project root"
```

---

## T4. Web API 加 token 鉴权 + 默认绑定 localhost

### 目标
1. 不暴露未鉴权的 API 到任何非 localhost。
2. 提供一个简单的 bearer token 机制，让本地前端/MCP/Cursor 用同一个 token 访问。
3. CORS 收紧到已知 origins。

### 改文件
- `src/edagent_vivado/web/app.py`
- 新增 `src/edagent_vivado/web/auth.py`
- `src/edagent_vivado/cli.py`（启动命令）

### 设计

启动时：
- 从 env `SYNTHIA_API_TOKEN` 读 token；若未设置，**自动生成**一个 32 字节随机 token 并写进 `~/.synthia/token`，启动日志里 INFO 输出一次。
- 默认 host=`127.0.0.1`。若用户显式设 `--host 0.0.0.0`，**强制**要求 `SYNTHIA_API_TOKEN` 已显式设置且 ≥16 字符，否则拒绝启动。

请求：
- 所有 `/api/...` 路径都要 `Authorization: Bearer <token>` 或 `?token=...`（用于 EventSource SSE）。
- `/health` 例外，允许无 token 探活。

### 步骤

#### 步骤 1：新建 `src/edagent_vivado/web/auth.py`

```python
"""API token authentication — Phase 0."""
from __future__ import annotations

import os
import secrets
from pathlib import Path

from fastapi import HTTPException, Request

_TOKEN: str | None = None
_TOKEN_FILE = Path.home() / ".synthia" / "token"


def ensure_token() -> str:
    """Load token from env, then from ~/.synthia/token; generate if missing."""
    global _TOKEN
    if _TOKEN:
        return _TOKEN
    env_tok = os.environ.get("SYNTHIA_API_TOKEN", "").strip()
    if env_tok:
        _TOKEN = env_tok
        return _TOKEN
    if _TOKEN_FILE.exists():
        _TOKEN = _TOKEN_FILE.read_text(encoding="utf-8").strip()
        if _TOKEN:
            return _TOKEN
    _TOKEN = secrets.token_urlsafe(32)
    _TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    _TOKEN_FILE.write_text(_TOKEN, encoding="utf-8")
    try:
        os.chmod(_TOKEN_FILE, 0o600)
    except OSError:
        pass
    return _TOKEN


def require_token(request: Request) -> None:
    """FastAPI dependency: validate Authorization or ?token=."""
    expected = ensure_token()
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        provided = auth[7:].strip()
    else:
        provided = request.query_params.get("token", "")
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="invalid or missing token")


def is_public_path(path: str) -> bool:
    """Paths that bypass token check."""
    if path in ("/api/health", "/health"):
        return True
    # Static assets and SPA
    if path.startswith("/assets/") or not path.startswith("/api/"):
        return True
    return False
```

#### 步骤 2：`app.py` 装中间件

打开 `src/edagent_vivado/web/app.py`，在 `create_app()` 里 CORS 之后加：

```python
from edagent_vivado.web.auth import ensure_token, require_token, is_public_path
from starlette.middleware.base import BaseHTTPMiddleware

# 启动时确保 token 已生成
token = ensure_token()
logging.getLogger(__name__).info("Synthia API token loaded (len=%d). See ~/.synthia/token", len(token))

class _TokenMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if is_public_path(request.url.path):
            return await call_next(request)
        try:
            require_token(request)
        except HTTPException as exc:
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
        return await call_next(request)

app.add_middleware(_TokenMiddleware)
```

把 CORS 改成：

```python
import os as _os
_origins = _os.environ.get("SYNTHIA_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)
```

#### 步骤 3：CLI 启动检查

打开 `src/edagent_vivado/cli.py`，找 `web` 命令（约第 479 行）：

```python
@app.command()
def web(host: str = "127.0.0.1", port: int = 8484, ...):
```

在函数体最前面加：

```python
import os as _os, sys as _sys
if host not in ("127.0.0.1", "localhost", "::1"):
    tok = _os.environ.get("SYNTHIA_API_TOKEN", "").strip()
    if not tok or len(tok) < 16:
        _sys.stderr.write(
            "ERROR: binding to non-localhost requires SYNTHIA_API_TOKEN env var (>=16 chars).\n"
            "       Run: export SYNTHIA_API_TOKEN=$(openssl rand -hex 32)\n"
        )
        raise SystemExit(2)
```

#### 步骤 4：前端 fetch 加 token

`frontend/src/lib/api.ts`（如果不存在就建一个统一的 fetch 包装）：

```ts
const TOKEN_KEY = 'synthia.api.token'

export function getApiToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setApiToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t)
}

export async function apiFetch(input: RequestInfo, init: RequestInit = {}) {
  const token = getApiToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(input, { ...init, headers })
}
```

并在 `SettingsPage.tsx` 加一个「API Token」输入框，调 `setApiToken`。

首次运行：用户从终端日志看到 token 路径 `~/.synthia/token`，复制粘贴到 Settings。

#### 步骤 5：SSE EventSource 不能加 header，用 query param

找所有 `new EventSource(...)`，改成：

```ts
const url = `/api/v1/sessions/${sid}/stream?token=${encodeURIComponent(getApiToken())}`
const es = new EventSource(url)
```

### T4 验收标准

1. 不带 token 访问 `curl http://127.0.0.1:8484/api/v1/projects` 返回 `401`。
2. 带 token 访问返回 200。
3. `--host 0.0.0.0` 启动时若 `SYNTHIA_API_TOKEN` 未设置，进程退出码 2。
4. 前端 SettingsPage 能填 token，填完后所有页面正常加载。
5. SSE stream 在带 `?token=` 后能连通。
6. `/api/health`（如果存在）无需 token。

提交：

```bash
git commit -am "T4: API bearer token auth + localhost default + CORS tightening"
```

### 常见坑
- **CORS 与 token**：`allow_credentials=False` 时 `Authorization` header 仍能传，不需要 credentials。但如果以后做 cookie session，记得把 origins 缩到具体列表。
- **Cursor / MCP client**：未来的 MCP 调用要在 transport 配置里加 token，不要硬编码到代码里。

---

## T5. 修 `a.kind` 与 `run_simulation` 假成功

### 目标
- 修一个会让 artifact 列表丢失的 bug。
- 让"假装跑成功"的 capability 改成明确"未实现"。

### T5.1 修 `a.kind`

**改文件**：`src/edagent_vivado/agent/run_capability.py`

**当前代码**（第 76 行）：

```python
"artifacts": [{"path": a.path, "kind": a.kind} for a in result.artifacts],
```

**改成**：

```python
"artifacts": [
    {"path": a.path, "kind": getattr(a, "artifact_type", "")}
    for a in result.artifacts
],
```

### T5.2 修 `run_simulation`

**改文件**：`src/edagent_vivado/connectors/vivado/connector.py`

**当前代码**（第 147–154 行）：

```python
if cap == "run_simulation":
    return ToolRunResult(
        request_id=req.request_id,
        success=True,
        exit_code=0,
        edagent_outcome="execution_succeeded",
        error="",
    )
```

**改成**：

```python
if cap == "run_simulation":
    return ToolRunResult(
        request_id=req.request_id,
        success=False,
        exit_code=2,
        edagent_outcome="execution_failed",
        error="run_simulation capability not implemented yet (planned v1.0 Phase 5)",
    )
```

并到 `connectors/vivado/capabilities.py` 把 `run_simulation` 的 `enabled` 字段设 False，或加 `unstable: true` 标记。

### T5 验收标准

1. 让一个 capability 成功后，前端能看到 artifacts 列表（手工跑一遍 mock synth）。
2. 调用 `run_simulation` 返回 `success=False` 且 error 含 "not implemented"。
3. 测试新增（在 `tests/test_run_capability.py`）：

```python
def test_artifacts_in_payload_uses_artifact_type(monkeypatch):
    # ... call run_connector_capability with a mock that produces 1 Artifact
    # ... assert "kind" key in returned JSON points to artifact_type value
    pass
```

提交：

```bash
git commit -am "T5: fix artifact serialization key + run_simulation honesty"
```

---

## T6. SPA 静态路径穿越修复

### 改文件
`src/edagent_vivado/web/app.py`

### 当前问题（约第 60–67 行）

```python
@app.get("/{full_path:path}")
async def spa_fallback(full_path: str = ""):
    if full_path.startswith("api/"):
        raise HTTPException(404)
    fp = static_dir / full_path
    if full_path and fp.is_file():
        return FR(str(fp))
    return HTMLResponse(...)
```

`full_path = "../../../etc/passwd"` 会让 `static_dir / full_path` 跳出 static_dir。

### 改成

```python
@app.get("/{full_path:path}")
async def spa_fallback(full_path: str = ""):
    if full_path.startswith("api/"):
        raise HTTPException(404)
    if full_path:
        try:
            requested = (static_dir / full_path).resolve()
            requested.relative_to(static_dir.resolve())
        except (ValueError, OSError):
            raise HTTPException(404)
        if requested.is_file():
            return FR(str(requested))
    return HTMLResponse((static_dir / "index.html").read_text(encoding="utf-8"))
```

同样的修法应用到 `web/dashboard.py::get_run` 和 `get_run_log`：

```python
@router.get("/api/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_\-:.]{1,128}", run_id):
        raise HTTPException(400, "invalid run_id")
    # ... 后续不变
```

### T6 验收标准

```bash
curl -i 'http://127.0.0.1:8484/..%2F..%2F..%2Fetc%2Fpasswd'
# 期望 404，body 不含 root:x:0
```

新测试 `tests/test_web_app_security.py`：

```python
def test_spa_fallback_rejects_traversal(client):
    r = client.get("/../../etc/passwd")
    assert r.status_code in (404, 422)
```

提交：

```bash
git commit -am "T6: SPA static + dashboard run_id path traversal fixes"
```

---

## T7. 开分支 + 写 5 篇 ADR

### 目标
把关键决策写成 Architecture Decision Records（ADR），将来回头看不用再重新讨论。

### 建文件夹

```bash
mkdir -p docs/adr
```

### ADR 模板 `docs/adr/_template.md`

```markdown
# ADR-XXXX: 标题

> 状态：Draft / Accepted / Superseded
> 日期：YYYY-MM-DD
> 决策人：xxx
> 关联：spec.md §X / update.md §Y

## 背景
（为什么会有这个决策需求？1-3 段。）

## 选项

### 选项 A
- 描述
- 优点
- 缺点

### 选项 B
- ...

## 决策
（选了哪个，一句话。）

## 后果
- 正面
- 负面
- 需要后续处理的

## 参考
- 链接 / spec 章节 / 代码位置
```

### 5 篇 ADR

按下面内容各写一篇，文件名严格按编号：

#### `docs/adr/0001-xpr-first-manifest-internal.md`

**决策**：用户看到 `.xpr`，系统执行用 internal manifest（`.synthia/eda.yaml`）。每次 run 前做 fingerprint check，冲突时显式提示，**不自动反向写回 GUI 改动**。

**后果**：v1.0 不需要做双向同步引擎，复杂度降一个量级。代价是 GUI 改了工程后第一次 run 会提示用户手动 sync。

#### `docs/adr/0002-nextjs-not-now.md`

**决策**：**不切 Next.js**。继续在现有 Vite + React 19 + TS + Zustand + i18next 上做 Cursor 感 + Claude 配色 重设计。

**后果**：节省 4–8 周纯重写时间。代价是放弃 SSR / NextAuth 这套生态，未来需要 auth/route guard 时自己实现（FastAPI side 已经在做）。

#### `docs/adr/0003-internal-python-connector-external-mcp.md`

**决策**：内部主链路是 Python Connector（强类型、能做事务/审批/审计），MCP 仅作外部协议（v1.0 Phase 9+），不替换内部。

#### `docs/adr/0004-auto-mode-with-tiered-approval.md`

**决策**：默认 Auto Mode。Risk 分级：

| Risk | 处理 |
|---|---|
| low | 自动执行 |
| medium | 自动执行，记录审计 |
| high | 等待人工审批 |
| critical | 默认拒绝 |

RTL/XDC 改动 = high；删除文件 / 烧录设备 / 覆盖 .xpr = high；任意 `rm -rf` / 改环境 = critical。

#### `docs/adr/0005-sqlite-for-v1-postgres-later.md`

**决策**：v1.0 继续 SQLite。v1.1 引入 SQLAlchemy ORM + Alembic baseline，v1.2 默认 PG。期间保留 SQLite for dev/test。

#### `docs/adr/0006-rtl-prompt-permissive-v1.md`

**决策**：v1.0 RTL 可自由进入 prompt（Policy A）。futureWork.md §1.1 已记录风险与缓解计划。

### T7 验收标准

```bash
ls docs/adr/
# 应有 _template.md 和 0001 - 0006 共 7 个文件
```

每篇 ADR 至少 300 字，明确写出"决策"和"后果"两节。

提交：

```bash
git add docs/adr && git commit -m "T7: add 6 ADRs for Synthia phase 0 decisions"
```

---

## T8. `synthia` CLI 软链 + 品牌别名

### 目标
让用户能用 `synthia web` 或 `edagent web`，两个都工作。但**不改包名**（避免破坏现有 import）。

### 改文件
`pyproject.toml`

### 改造

找到 `[project.scripts]` 段：

```toml
[project.scripts]
edagent = "edagent_vivado.cli:app"
edagent-web = "edagent_vivado.web.dashboard:start_server"
```

**加** 两行：

```toml
[project.scripts]
edagent = "edagent_vivado.cli:app"
edagent-web = "edagent_vivado.web.dashboard:start_server"
synthia = "edagent_vivado.cli:app"          # Synthia brand alias
synthia-web = "edagent_vivado.web.dashboard:start_server"
```

重新安装：

```bash
pip install -e ".[dev]"
```

### 同步改 banner

`src/edagent_vivado/cli.py` 顶部加一行：

```python
app = typer.Typer(help="Synthia — FPGA/EDA Agent Workbench (formerly EdAgent-Vivado)")
```

或直接在 `app = typer.Typer(...)` 现有调用上改 help 文本。

### T8 验收标准

```bash
synthia --help        # 应显示 Synthia 帮助
synthia-web --port 9000   # 应能启动
edagent --help        # 仍然工作
```

提交：

```bash
git commit -am "T8: add synthia CLI alias (edagent still works)"
```

---

# 前端设计任务

> 假设你已经在 `frontend/` 跑过 `npm install`，并且 `npm run dev` 能在 http://127.0.0.1:5173 看到现有 UI。
>
> 现有的样式系统使用纯 CSS Variables，没有 Tailwind，文件分散在 `frontend/src/styles/`。我们**不引入 Tailwind**，继续在现有 CSS 体系上调整。

---

## D1. 更新颜色 token（Claude 暖色）

### 目标
让默认主题更接近 Claude 官网/产品的暖色调，去除过 SaaS 的蓝色。

### 改文件
`frontend/src/styles/themes.css`

### 改造步骤

#### 步骤 1：备份现有

```bash
cp frontend/src/styles/themes.css frontend/src/styles/themes.css.bak
```

#### 步骤 2：替换默认 warm 主题颜色块

打开 `themes.css`，找到 `[data-theme='warm']`（在 `:root` 之后），替换颜色变量为下面的值：

```css
:root,
[data-theme='warm'] {
  --bg: #FAF7F2;
  --bg-subtle: #F2EDE3;
  --surface: #FFFFFF;
  --surface-raised: #FFFFFF;
  --surface-inset: #F7F3EB;

  --border: #E5DDD0;
  --border-hover: #D4C9B5;
  --border-strong: #C8BCA5;

  --text: #1F1B17;
  --text-secondary: #5C544A;
  --muted: #8B847A;
  --subtle: #ADA69F;

  --accent: #CC785C;
  --accent-hover: #B5634A;
  --accent-on: #FFFFFF;
  --accent-subtle: rgba(204, 120, 92, 0.10);
  --accent-border: rgba(204, 120, 92, 0.30);

  --success: #7C8F5E;
  --success-subtle: rgba(124, 143, 94, 0.10);
  --success-border: rgba(124, 143, 94, 0.30);
  --warning: #C99547;
  --warning-subtle: rgba(201, 149, 71, 0.10);
  --warning-border: rgba(201, 149, 71, 0.30);
  --error: #B85450;
  --error-subtle: rgba(184, 84, 80, 0.10);
  --error-border: rgba(184, 84, 80, 0.30);
  --info: #7A8FA8;
  --info-subtle: rgba(122, 143, 168, 0.10);
  --info-border: rgba(122, 143, 168, 0.30);
}
```

#### 步骤 3：新增 / 替换 dark 主题（命名为 `obsidian` 或新建 `claude-dark`）

```css
[data-theme='claude-dark'] {
  --bg: #1A1815;
  --bg-subtle: #211E1A;
  --surface: #2A2622;
  --surface-raised: #322D28;
  --surface-inset: #1F1C18;

  --border: #3A3530;
  --border-hover: #4A443D;
  --border-strong: #5A5249;

  --text: #EDE8DF;
  --text-secondary: #B8B0A3;
  --muted: #8B847A;
  --subtle: #6B6359;

  --accent: #D97757;
  --accent-hover: #E8896B;
  --accent-on: #1A1815;
  --accent-subtle: rgba(217, 119, 87, 0.15);
  --accent-border: rgba(217, 119, 87, 0.40);

  --success: #8FA572;
  --success-subtle: rgba(143, 165, 114, 0.15);
  --success-border: rgba(143, 165, 114, 0.35);
  --warning: #D4A458;
  --warning-subtle: rgba(212, 164, 88, 0.15);
  --warning-border: rgba(212, 164, 88, 0.35);
  --error: #C9695F;
  --error-subtle: rgba(201, 105, 95, 0.15);
  --error-border: rgba(201, 105, 95, 0.35);
  --info: #8FA3BC;
  --info-subtle: rgba(143, 163, 188, 0.15);
  --info-border: rgba(143, 163, 188, 0.35);
}
```

#### 步骤 4：把默认主题切到 `claude-dark`

打开 `frontend/src/lib/theme.ts`，找到默认主题常量（搜 `'warm'` 或 `'obsidian'`），改成 `'claude-dark'`。

或者，让 `App.tsx` 启动时根据 `prefers-color-scheme` 自动选 warm / claude-dark：

```ts
useEffect(() => {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const saved = localStorage.getItem('synthia.theme')
  const theme = saved || (prefersDark ? 'claude-dark' : 'warm')
  document.documentElement.setAttribute('data-theme', theme)
}, [])
```

### D1 验收标准

1. 启动 `npm run dev`，默认看到 **暖橙色 accent + 米色背景**（白天）或 **深棕黑底 + 焦糖橙 accent**（夜里）。
2. **没有任何蓝色 button / link**（除非语义是 info）。
3. 切换主题（如果有切换器）三种主题都不崩，对比度尚可读。
4. 浏览器 devtools 选中任意元素，CSS 变量都能从 `:root` 解析到。

提交：

```bash
cd frontend && git add src/styles/themes.css src/lib/theme.ts && git commit -m "D1: Claude-inspired warm + claude-dark color tokens"
```

---

## D2. AppShell 改为 Cursor 三栏

### 目标
当前 AppShell 是「左侧 nav rail + main」两栏。改成 Cursor 风格的「**左 240px / 中 自适应 / 右 360px 可收**」三栏，顶部 36px topbar。

### 改文件
- `frontend/src/components/layout/AppShell.tsx`
- `frontend/src/styles/global.css`（或新建 `frontend/src/components/layout/AppShell.css`）

### 改造步骤

#### 步骤 1：扩展 shellStore

`frontend/src/stores/shellStore.ts` 加一个 `rightPanelCollapsed` 状态（搜文件，看是否已有；没有就加）：

```ts
interface ShellState {
  navCollapsed: boolean
  rightCollapsed: boolean
  toggleNavCollapsed: () => void
  toggleRightCollapsed: () => void
}

// 默认 false，可读 localStorage
```

#### 步骤 2：AppShell 改 layout

```tsx
import { NavLink, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, /* icons */ } from 'lucide-react'
import { useShellStore } from '../../stores/shellStore'

export function AppShell({
  children,
  right,
}: {
  children: React.ReactNode
  right?: React.ReactNode
}) {
  const { t } = useTranslation()
  const location = useLocation()
  const navCollapsed = useShellStore((s) => s.navCollapsed)
  const rightCollapsed = useShellStore((s) => s.rightCollapsed)
  const toggleNav = useShellStore((s) => s.toggleNavCollapsed)
  const toggleRight = useShellStore((s) => s.toggleRightCollapsed)

  return (
    <div className={[
      'app-shell',
      navCollapsed && 'nav-collapsed',
      right && !rightCollapsed && 'right-open',
    ].filter(Boolean).join(' ')}>
      <header className="topbar">
        <div className="topbar-brand">Synthia</div>
        <div className="topbar-context">{/* 当前 project chip */}</div>
        <div className="topbar-status">{/* connector health, model picker */}</div>
      </header>

      <aside className="nav-rail" aria-label="Navigation">
        {/* 现有 nav items */}
      </aside>

      <main className="app-main">{children}</main>

      {right && (
        <aside className={`right-panel ${rightCollapsed ? 'collapsed' : ''}`}>
          <button className="right-toggle" onClick={toggleRight}>
            {rightCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
          {!rightCollapsed && right}
        </aside>
      )}
    </div>
  )
}
```

#### 步骤 3：写新 CSS

在 `global.css` 末尾追加（或新建独立文件 import 之）：

```css
.app-shell {
  display: grid;
  grid-template-columns: 240px 1fr;
  grid-template-rows: 36px 1fr;
  grid-template-areas:
    "topbar topbar"
    "nav main";
  height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: var(--font-size-base);
  line-height: var(--line-height);
}

.app-shell.nav-collapsed {
  grid-template-columns: 48px 1fr;
}

.app-shell.right-open {
  grid-template-columns: 240px 1fr 360px;
  grid-template-areas:
    "topbar topbar topbar"
    "nav main right";
}

.app-shell.right-open.nav-collapsed {
  grid-template-columns: 48px 1fr 360px;
}

.topbar {
  grid-area: topbar;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.topbar-brand {
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.02em;
  color: var(--text);
}

.topbar-context {
  flex: 1;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.topbar-status {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--muted);
}

.nav-rail {
  grid-area: nav;
  border-right: 1px solid var(--border);
  background: var(--bg-subtle);
  overflow-y: auto;
  padding: 8px 6px;
}

.app-main {
  grid-area: main;
  overflow: auto;
}

.right-panel {
  grid-area: right;
  border-left: 1px solid var(--border);
  background: var(--bg-subtle);
  position: relative;
  overflow-y: auto;
  padding: 12px;
}

.right-panel.collapsed {
  padding: 0;
}

.right-toggle {
  position: absolute;
  top: 12px;
  left: -12px;
  width: 24px;
  height: 24px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  display: grid;
  place-items: center;
  cursor: pointer;
}
```

#### 步骤 4：让具体页面传 `right`

例如在 `TerminalPage.tsx`：

```tsx
return (
  <AppShell right={<TerminalRightPanel runId={...} />}>
    <TerminalMainArea />
  </AppShell>
)
```

`TerminalRightPanel` 内部用三段：Run / Artifacts / Approvals 竖排。

### D2 验收标准

1. 打开 `/term`，看到 **三栏**：左 nav / 中 chat / 右 Run+Artifact+Approval。
2. 点击右边 toggle 按钮，右栏能 360px ↔ 0px 切换。
3. 点击左 nav 折叠按钮，从 240px ↔ 48px 切换，主区域宽度跟着变。
4. 顶栏始终可见，高度 36px。
5. 浏览器窗口缩到 1024x600 也不破版（侧栏可滚，主区域不溢出）。

提交：

```bash
git commit -am "D2: AppShell three-column Cursor-like layout"
```

---

## D3. `StatusPill` 新组件

### 目标
统一所有状态展示——running / succeeded / failed / queued / needs_approval。

### 新建文件
`frontend/src/components/common/StatusPill.tsx`

```tsx
import { Check, Circle, Pause, X } from 'lucide-react'

export type StatusKind =
  | 'queued' | 'running' | 'succeeded' | 'failed'
  | 'needs_approval' | 'cancelled' | 'unknown'

const META: Record<StatusKind, { label: string; icon: React.ComponentType<{ size?: number }>; tone: string }> = {
  queued: { label: 'queued', icon: Circle, tone: 'muted' },
  running: { label: 'running', icon: Circle, tone: 'accent' },
  succeeded: { label: 'succeeded', icon: Check, tone: 'success' },
  failed: { label: 'failed', icon: X, tone: 'error' },
  needs_approval: { label: 'needs approval', icon: Pause, tone: 'warning' },
  cancelled: { label: 'cancelled', icon: X, tone: 'muted' },
  unknown: { label: 'unknown', icon: Circle, tone: 'muted' },
}

export function StatusPill({
  status,
  label,
}: {
  status: StatusKind
  label?: string
}) {
  const meta = META[status] || META.unknown
  const Icon = meta.icon
  const isRunning = status === 'running'
  return (
    <span className={`status-pill tone-${meta.tone} ${isRunning ? 'pulse' : ''}`}>
      <Icon size={11} />
      <span>{label || meta.label}</span>
    </span>
  )
}
```

### CSS（`frontend/src/styles/global.css` 追加）

```css
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  border: 1px solid currentColor;
  background: transparent;
}

.status-pill.tone-muted { color: var(--muted); }
.status-pill.tone-accent { color: var(--accent); background: var(--accent-subtle); border-color: var(--accent-border); }
.status-pill.tone-success { color: var(--success); background: var(--success-subtle); border-color: var(--success-border); }
.status-pill.tone-warning { color: var(--warning); background: var(--warning-subtle); border-color: var(--warning-border); }
.status-pill.tone-error { color: var(--error); background: var(--error-subtle); border-color: var(--error-border); }

.status-pill.pulse svg {
  animation: pulse-fade 1.6s ease-in-out infinite;
}

@keyframes pulse-fade {
  0%, 100% { opacity: 0.45; }
  50%      { opacity: 1; }
}
```

### D3 验收标准

1. 在任意页面随便放 `<StatusPill status="running" />`、`<StatusPill status="succeeded" />` 等 6 种状态，都能看到。
2. `running` 的图标在脉冲动画。
3. 颜色与 D1 token 一致（不会出现独立 hex）。

提交：

```bash
git commit -am "D3: add StatusPill component"
```

---

## D4. `ToolCallBlock` 重写

### 目标
当前 `ToolCallBlock.tsx` 是聊天气泡风。改成 **Cursor 风格的 inline 卡片**：mono 字体头部 + 折叠的输出 + StatusPill。

### 改文件
`frontend/src/components/terminal/ToolCallBlock.tsx`

### 改造（关键结构，具体 props 适配现有调用方）

```tsx
import { useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { StatusPill, type StatusKind } from '../common/StatusPill'

interface Props {
  toolName: string
  args?: Record<string, unknown>
  output?: string
  status: StatusKind
  elapsedMs?: number
  errorMessage?: string
}

export function ToolCallBlock({ toolName, args, output, status, elapsedMs, errorMessage }: Props) {
  const [expanded, setExpanded] = useState(status === 'failed' || status === 'needs_approval')

  return (
    <div className={`tool-call-block status-${status}`}>
      <header className="tcb-head" onClick={() => setExpanded((v) => !v)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="tcb-tool">tool · {toolName}</span>
        {args && Object.entries(args).slice(0, 3).map(([k, v]) => (
          <span key={k} className="tcb-arg">{k}={String(v).slice(0, 40)}</span>
        ))}
        <span className="tcb-spacer" />
        {elapsedMs != null && <span className="tcb-elapsed">{(elapsedMs / 1000).toFixed(1)}s</span>}
        <StatusPill status={status} />
      </header>
      {expanded && (
        <div className="tcb-body">
          {output && <pre className="tcb-output">{output.slice(0, 4000)}</pre>}
          {errorMessage && <div className="tcb-error">{errorMessage}</div>}
        </div>
      )}
    </div>
  )
}
```

### CSS

```css
.tool-call-block {
  margin: 8px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  overflow: hidden;
}

.tool-call-block.status-failed {
  border-left: 2px solid var(--error);
}

.tool-call-block.status-needs_approval {
  border-left: 2px solid var(--warning);
}

.tool-call-block.status-running {
  border-left: 2px solid var(--accent);
}

.tcb-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 12.5px;
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid transparent;
}

.tool-call-block:not(.collapsed) .tcb-head { border-bottom-color: var(--border); }

.tcb-tool { color: var(--text); font-weight: 600; }
.tcb-arg { color: var(--text-secondary); font-size: 12px; }
.tcb-spacer { flex: 1; }
.tcb-elapsed {
  color: var(--muted);
  font-size: 11px;
  font-feature-settings: "tnum";
}

.tcb-body {
  padding: 8px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
}

.tcb-output {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
  max-height: 320px;
  overflow: auto;
}

.tcb-error {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--error-subtle);
  border-left: 2px solid var(--error);
  color: var(--error);
}
```

### D4 验收标准

1. Tool call 显示为 inline 卡片，**不再是聊天气泡**。
2. 头部 mono 字体；右侧依次显示 elapsed + StatusPill。
3. 默认折叠；失败/等审批时**自动展开**。
4. 点击头部展开/收起。
5. 失败时左侧有红色 2px 竖条。

提交：

```bash
git commit -am "D4: ToolCallBlock as inline Cursor-style card"
```

---

## D5. `ApprovalBlock` 重写

### 改文件
`frontend/src/components/terminal/ApprovalBlock.tsx`

### 关键结构

```tsx
export function ApprovalBlock({ approval, onApprove, onReject, onAskRevise }: Props) {
  return (
    <div className="approval-block">
      <header className="approval-head">
        <span className="approval-icon">⚠</span>
        <span className="approval-title">Approval Required</span>
        <span className="approval-id">{approval.id}</span>
      </header>
      <div className="approval-meta">
        <span>{approval.action_type}</span>
        <span>·</span>
        <span className="approval-path">{approval.target_file}</span>
        <span>·</span>
        <span className="risk-badge">risk={approval.risk_level}</span>
      </div>
      {approval.diff && (
        <pre className="approval-diff">
          {approval.diff}
        </pre>
      )}
      {approval.reason && (
        <div className="approval-why">
          <strong>Why:</strong> {approval.reason}
        </div>
      )}
      <div className="approval-actions">
        <button className="btn-primary" onClick={onApprove}>Approve</button>
        <button className="btn-ghost" onClick={onReject}>Reject</button>
        <button className="btn-ghost" onClick={onAskRevise}>Ask Agent to revise</button>
      </div>
    </div>
  )
}
```

### CSS（关键）

```css
.approval-block {
  border: 1px solid var(--warning-border);
  background: var(--warning-subtle);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  margin: 12px 0;
}

.approval-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--warning);
}

.approval-id { margin-left: auto; color: var(--muted); font-size: 11px; }

.approval-meta {
  display: flex;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
  margin: 6px 0 10px;
}

.approval-diff {
  margin: 0 0 10px;
  background: var(--surface-inset);
  border: 1px solid var(--border);
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  max-height: 280px;
  overflow: auto;
}

/* diff 染色 — 真正的 diff 视图需要 parser，但简单的可以用前缀+/-着色 */
.approval-diff { color: var(--text); }

.approval-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.btn-primary {
  padding: 6px 14px;
  background: var(--accent);
  color: var(--accent-on);
  border: 1px solid var(--accent);
  border-radius: var(--radius-xs);
  font-size: 13px;
  cursor: pointer;
}
.btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }

.btn-ghost {
  padding: 6px 14px;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  font-size: 13px;
  cursor: pointer;
}
.btn-ghost:hover { background: var(--surface-inset); color: var(--text); }
```

### D5 验收标准

1. 任意 approval pending 时显示琥珀色卡片，含 diff、原因、3 个按钮。
2. Approve → 触发后端 approve，卡片消失或显示已批准。
3. Reject 同理。
4. 颜色用 token，无 hex。

提交：

```bash
git commit -am "D5: ApprovalBlock with diff viewer + tiered actions"
```

---

## D6. `Composer` 改造

### 改文件
`frontend/src/components/terminal/Composer.tsx`

### 关键变更

1. 居中 max-width 880px。
2. 顶部 hint 行：`⌘K commands · ⌘↩ send · ↑↓ history`。
3. 多行 textarea，回车键 = 发送；Shift+Enter = 换行；Cmd+Enter / Ctrl+Enter = 强制发送。
4. 右下角按钮：运行中 = Stop（红描边）；空闲 = ↩。
5. 上方挂 PlanChip（如果当前 task 有未执行 plan）。

```tsx
import { useEffect, useRef, useState } from 'react'

export function Composer({ onSend, onStop, running, pendingPlan }: Props) {
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  function send() {
    if (!text.trim() || running) return
    onSend(text)
    setText('')
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="composer">
      {pendingPlan && <PlanChip plan={pendingPlan} />}
      <div className="composer-hint">
        ⌘K commands · ⌘↩ send · ↑↓ history
      </div>
      <div className="composer-row">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="Ask Synthia…"
          rows={2}
        />
        {running ? (
          <button className="btn-stop" onClick={onStop}>Stop</button>
        ) : (
          <button className="btn-send" onClick={send} disabled={!text.trim()}>↩</button>
        )}
      </div>
    </div>
  )
}
```

### CSS

```css
.composer {
  max-width: 880px;
  margin: 0 auto;
  padding: 8px 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}

.composer-hint {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 6px;
}

.composer-row {
  display: flex;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
}

.composer-row:focus-within { border-color: var(--accent-border); }

.composer textarea {
  flex: 1;
  resize: none;
  background: transparent;
  border: 0;
  outline: 0;
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 1.5;
  color: var(--text);
}

.btn-stop {
  background: transparent;
  border: 1px solid var(--error-border);
  color: var(--error);
  padding: 4px 10px;
  border-radius: var(--radius-xs);
  font-size: 12px;
  cursor: pointer;
}

.btn-send {
  background: var(--accent);
  border: 0;
  color: var(--accent-on);
  padding: 4px 12px;
  border-radius: var(--radius-xs);
  font-size: 14px;
  cursor: pointer;
}

.btn-send:disabled { opacity: 0.4; cursor: not-allowed; }
```

### D6 验收标准

1. 输入框居中，最大宽 880px。
2. Enter 直接发送；Shift+Enter 换行。
3. 运行中显示红描边 Stop。
4. focus 时输入框边框变成 accent 色。

提交：

```bash
git commit -am "D6: Composer centered with hint + stop/send button"
```

---

## D7. `⌘K` 命令面板

### 目标
按 `⌘K` (Mac) / `Ctrl+K` (Win) 弹出命令面板，可快速：
- 切换 project
- 跳转页面（runs / reports / approvals / connectors）
- 创建新 session
- 切换主题

### 安装库

```bash
cd frontend && npm install cmdk
```

### 新建文件
`frontend/src/components/common/CommandPalette.tsx`

```tsx
import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { useNavigate } from 'react-router-dom'

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const nav = useNavigate()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <Command.Dialog open={open} onOpenChange={setOpen} label="Command Palette">
      <Command.Input placeholder="Type a command or search…" />
      <Command.List>
        <Command.Empty>No results.</Command.Empty>

        <Command.Group heading="Navigate">
          <Command.Item onSelect={() => { nav('/'); setOpen(false) }}>Projects</Command.Item>
          <Command.Item onSelect={() => { nav('/runs'); setOpen(false) }}>Runs</Command.Item>
          <Command.Item onSelect={() => { nav('/reports'); setOpen(false) }}>Reports</Command.Item>
          <Command.Item onSelect={() => { nav('/approvals'); setOpen(false) }}>Approvals</Command.Item>
          <Command.Item onSelect={() => { nav('/connectors'); setOpen(false) }}>Connectors</Command.Item>
          <Command.Item onSelect={() => { nav('/settings'); setOpen(false) }}>Settings</Command.Item>
        </Command.Group>

        <Command.Group heading="Theme">
          <Command.Item onSelect={() => {
            document.documentElement.setAttribute('data-theme', 'warm')
            localStorage.setItem('synthia.theme', 'warm')
            setOpen(false)
          }}>Light (warm)</Command.Item>
          <Command.Item onSelect={() => {
            document.documentElement.setAttribute('data-theme', 'claude-dark')
            localStorage.setItem('synthia.theme', 'claude-dark')
            setOpen(false)
          }}>Dark (claude)</Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  )
}
```

### 挂载到 App

`frontend/src/app/App.tsx` 或 `providers.tsx`：

```tsx
import { CommandPalette } from '../components/common/CommandPalette'

// ... in render
return (
  <>
    <CommandPalette />
    {/* rest */}
  </>
)
```

### CSS（cmdk 不带样式，自己写）

```css
[cmdk-overlay] {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 100;
}

[cmdk-dialog] {
  position: fixed;
  top: 96px; left: 50%;
  transform: translateX(-50%);
  width: 560px; max-width: 90vw;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: 101;
  overflow: hidden;
}

[cmdk-input] {
  width: 100%;
  padding: 12px 16px;
  border: 0;
  outline: 0;
  background: transparent;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 14px;
}

[cmdk-list] {
  max-height: 360px;
  overflow: auto;
  padding: 6px;
}

[cmdk-group-heading] {
  padding: 6px 10px;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

[cmdk-item] {
  padding: 8px 10px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
}

[cmdk-item][data-selected="true"] {
  background: var(--accent-subtle);
  color: var(--text);
}

[cmdk-empty] {
  padding: 16px;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
```

### D7 验收标准

1. 任意页面按 `⌘K` 或 `Ctrl+K` 弹出面板。
2. 输入字符过滤可见，回车跳转。
3. 选中项有 accent 浅色背景。
4. ESC 关闭。
5. 切换主题项实际改变页面颜色。

提交：

```bash
git commit -am "D7: ⌘K command palette via cmdk"
```

---

# Phase 0 整体验收

完成所有 T1–T8 + D1–D7 后，执行下面的清单。所有项必须 ✓。

### 后端验收

| # | 检查 | 命令 / 操作 | 期望 |
|---|---|---|---|
| 1 | 全量测试绿 | `python -m pytest -k "not agent_smoke" -q` | `0 failed` |
| 2 | 无 shell=True | `rg "shell=True" src/edagent_vivado/ -t py` | 无输出（或仅注释） |
| 3 | API 401 默认 | `curl -i http://127.0.0.1:8484/api/v1/projects` | `HTTP/1.1 401` |
| 4 | API token 通过 | `curl -H "Authorization: Bearer $(cat ~/.synthia/token)" http://127.0.0.1:8484/api/v1/projects` | 200 |
| 5 | --host 0.0.0.0 拒启动 | `synthia web --host 0.0.0.0`（无 token） | exit 2 |
| 6 | 路径穿越 | `curl 'http://127.0.0.1:8484/..%2F..%2F..%2Fetc%2Fpasswd' -H "Authorization: Bearer $TOKEN"` | 404 |
| 7 | 文件 patch 沙箱 | 跑测试 `test_apply_refuses_outside_root` | passed |
| 8 | a.kind 修复 | 手工跑一次 mock synth via API，看 artifacts 列表 | 含 `kind` 字段且非空 |
| 9 | run_simulation 诚实 | 调 capability `run_simulation` | success=False, error 含 "not implemented" |
| 10 | synthia 别名 | `synthia --help` | 显示帮助 |
| 11 | 6 篇 ADR 在位 | `ls docs/adr/0001*.md docs/adr/0006*.md` | 都存在 |

### 前端验收

| # | 检查 | 操作 | 期望 |
|---|---|---|---|
| 1 | 暗色默认 | 全新浏览器 incognito 打开 http://127.0.0.1:5173 | 深棕黑底 + 焦糖橙 accent |
| 2 | 浅色可切 | ⌘K → Theme → Light | 米色背景 + 焦糖橙 |
| 3 | 三栏布局 | 进 `/term` | 左 nav / 中 chat / 右 panel 三段 |
| 4 | 右栏可收 | 点击 right toggle | 360px ↔ 0px |
| 5 | Tool call inline | 跑一次任务有 tool call | 显示 mono 头部 + StatusPill |
| 6 | StatusPill 6 态 | 检查 storybook 或测试页 | 6 种颜色正确 |
| 7 | ApprovalBlock | 制造一个 pending approval | 琥珀色卡片 + 3 按钮 |
| 8 | Composer | Enter 发送 / Shift+Enter 换行 | 行为正确 |
| 9 | ⌘K 面板 | 按 ⌘K 或 Ctrl+K | 弹出，能跳转 |
| 10 | 无蓝色 | 视觉检查 | 没有 SaaS-blue 按钮/链接 |
| 11 | 终端绿字消失 | 进 /term | 不再是 monospace 全绿 |

### Git / 文档验收

| # | 检查 | 命令 | 期望 |
|---|---|---|---|
| 1 | 在正确分支 | `git branch --show-current` | `product/synthia-phase0` |
| 2 | 所有任务 commit | `git log --oneline product/synthia-phase0 ^master` | 至少 15 条 |
| 3 | futureWork 在位 | `cat futureWork.md \| head -5` | 标题正确 |
| 4 | ADR 6 篇 | `ls docs/adr/` | 0001–0006 + _template |
| 5 | 手册在位 | `cat SynthiaUpdate/PHASE0_HANDBOOK.md \| head -3` | 标题正确 |

### 全部通过后

```bash
git push origin product/synthia-phase0
# 在 GitHub / Gitea 开 PR 到 master，标题：
# "Phase 0: security hygiene, test fixes, Synthia visual rebrand"
```

PR 描述贴上面验收表，逐项打勾。

---

# Phase 0 之后

按 `SynthiaUpdate/update.md` 第 4 节进入 Phase 1。

**Phase 1 焦点：** `web/api_v1.py` (3244 行) 拆成 `web/routes/*.py`，每路由配 Pydantic schema。这是为 xpr-first（Phase 3）和未来 MCP（Phase 9）做接口准备。

**Phase 1 验收预告：**

1. `wc -l src/edagent_vivado/web/api_v1.py` ≤ 200 行（仅作 router 聚合）。
2. `ls src/edagent_vivado/web/routes/*.py` 至少 10 个文件。
3. OpenAPI schema 自动生成（`/openapi.json` 包含所有路由 + request/response model）。
4. 旧前端（Vite）零改动可用。
5. `python -m pytest` 仍 0 failed。

---

## 附录 A：每个里程碑的验收节奏

| Phase | 主任务 | 关键验收（一句话） | 估时 |
|---|---|---|---|
| 0 | 安全 + 视觉重构 | `pytest 0 fail` + `shell=True` 清零 + ⌘K 可用 | 2w |
| 1 | API 拆分 | api_v1.py ≤200 行 + OpenAPI 自动生成 | 3w |
| 2 | Connector 单一入口 | `rg VivadoRunner` 业务层 0 命中 | 3w |
| 3 | xpr-first | 能从真实 .xpr 导入并跑 mock synth | 4w |
| 4 | RunOrchestrator | 刷新页面 step 状态不丢；事件可重放 | 5w |
| 5 | Reports/Artifacts | DRC + Methodology + Bitstream parser 落地 | 3w |
| 6 | Chat UI 全闭环 | 用户输自然语言 → run → 完成 → 总结 | 4w |
| 7 | Approval 状态机 | XDC patch 完整 propose→approve→apply→rerun 链 | 3w |
| 8 | RBAC backend | Viewer 不能 create_run / download_bit | 2w |
| 9 | MCP v1 | Cursor 能调用 synthia 触发 run | 2w |
| 10 | Benchmark v1 | 跑 3 case，1 fail，最终 CSV 完整 | 3w |
| 11 | PG + Redis + Worker | 双 worker 不冲突；run 排队可见 | 3w |
| 12 | v1.1 Hardware | program_device 强审批 + hash 校验 | 3w |

**总周期粗算：** v1.0 至 Phase 10 约 8–9 个月单人 vibe coding。

---

## 附录 B：碰到问题怎么办

1. **测试莫名挂**：先 `git diff` 看自己改了什么；多半是 import 没更新。
2. **前端样式没变**：清缓存 `npm run dev` 重启；`data-theme` 没设到 `<html>` 上。
3. **API 401 但 token 正确**：检查浏览器 fetch 是否真的带了 `Authorization` header（Network tab）；SSE 必须用 `?token=`。
4. **Vivado mock 跑挂**：`unset VIVADO_REMOTE_HOST`，或 `force_mock=True`，见 `AGENTS.md`。
5. **PR review 被自己 review 卡住**：先把验收表逐项跑一遍；不通过就 fix-up 一个新 commit，最后 squash 也行。
6. **不确定怎么做**：去 `spec.md` 找对应章节；都没有就先记到 `futureWork.md` 里，**不要硬猜**。

---

## 附录 C：术语小词典

| 词 | 解释 |
|---|---|
| **EdAgent** | 当前包名 / 内核代号；不在 v1.0 改 |
| **Synthia** | 产品对外品牌；CLI 别名 / Web UI 上用 |
| **Connector** | 工业软件适配层；v1.0 仅有 Vivado |
| **Capability** | Connector 暴露的一项能力，如 `run_synthesis` |
| **Manifest** | 项目描述（eda.yaml）；v1.0 对用户透明 |
| **xpr** | Vivado 的项目文件；用户看到的主数据 |
| **Run** | 一次执行流程；包含多个 Step |
| **Step** | Run 内一步；状态机的最小单位 |
| **Artifact** | 一次 Run 的产出物（log/rpt/dcp/bit） |
| **PatchProposal** | Agent 建议的代码改动 |
| **Approval** | 一次审批状态机条目 |
| **HITL** | Human In The Loop — 人工介入审批 |
| **Auto Mode** | 默认 agent 模式；低风险自动跑 |
| **ADR** | Architecture Decision Record |
| **vibe coding** | 不被严格 milestone 绑死的、灵活节奏的开发 |
