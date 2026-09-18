#!/usr/bin/env bash
#
# 沙箱侧 Step 1：用户态嵌入式 PostgreSQL 17（Debian13/Daytona：无预装 PG、
# 禁 apt；npm 走 npmmirror 秒装）。PG 拒绝以 root 运行，故建 pguser 并 su。
# 产物：127.0.0.1:5432 上的 synthia 库（trust 认证，仅回环）。
set -euo pipefail
cd "$(dirname "$0")"

PG_PORT=5432
PG_USER=pguser
BOOT="$PWD/pg-bootstrap"
NATIVE="$BOOT/node_modules/@embedded-postgres/linux-x64/native"
DATA="$PWD/pg-data"
HOME_PG="$PWD/pg-home"

command -v node >/dev/null || { echo "FAIL: node missing"; exit 1; }

# 1) zonky 嵌入式二进制（~60MB，npmmirror）
if [ ! -x "$NATIVE/bin/postgres" ]; then
  mkdir -p "$BOOT"
  (cd "$BOOT" && npm install --no-save --registry=https://registry.npmmirror.com \
    @embedded-postgres/linux-x64@17.10.0-beta.17 pg)
fi
export LD_LIBRARY_PATH="$NATIVE/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# 2) 非 root 运行用户
id "$PG_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$PG_USER"
mkdir -p "$HOME_PG" "$DATA"
chown -R "$PG_USER": "$HOME_PG" "$DATA"

# 3) initdb（UTF8 + trust，socket 收进 pg-home 避免 /var/run 不可写）
if [ ! -f "$DATA/PG_VERSION" ]; then
  su "$PG_USER" -s /bin/bash -c "\"$NATIVE/bin/initdb\" -D \"$DATA\" -E UTF8 --locale=C -A trust -U synthia"
fi

# 4) 启动（幂等：已在跑则跳过）
if ! "$NATIVE/bin/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  su "$PG_USER" -s /bin/bash -c "\"$NATIVE/bin/pg_ctl\" -D \"$DATA\" \
    -o \"-p $PG_PORT -k $HOME_PG -c listen_addresses=127.0.0.1\" \
    -l \"$HOME_PG/postgres.log\" -w start"
fi

# 5) 建库 + 验证 contrib 扩展（迁移/恢复需要 pgcrypto、pg_trgm）
cat > "$BOOT/ensure-db.cjs" <<'EOF'
const pg = require("pg");
(async () => {
  const admin = new pg.Client({ connectionString: "postgres://synthia@127.0.0.1:5432/postgres" });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", ["synthia"]);
  if (exists.rowCount === 0) await admin.query("CREATE DATABASE synthia");
  await admin.end();
  const db = new pg.Client({ connectionString: "postgres://synthia@127.0.0.1:5432/synthia" });
  await db.connect();
  await db.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await db.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  const version = await db.query("SHOW server_version");
  console.log("pg-ready version=" + version.rows[0].server_version + " extensions=ok");
  await db.end();
})().catch((error) => { console.error("FAIL: " + error.message); process.exit(1); });
EOF
(cd "$BOOT" && node ensure-db.cjs)
echo "OK: embedded postgres on 127.0.0.1:$PG_PORT (trust, loopback only)"
