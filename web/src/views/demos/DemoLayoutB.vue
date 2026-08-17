<script setup lang="ts">
import { ref } from "vue";
import { demoProject, demoFeed, demoArtifacts, demoRuns } from "./shared.ts";
import "./demo.css";

const tab = ref<"flow" | "artifacts" | "runs">("flow");
const icon = (s?: string) => (s === "ok" ? "✓" : s === "fail" ? "✗" : s === "run" ? "⟳" : s === "wait" ? "⏸" : "");

// ── 就地审批（演示态）─────────────────────────────────────────
const decision = ref<"none" | "approved" | "rejected">("none");
const expandedDoc = ref<string | null>(null);
const rejectReason = ref("");
const pendingDocs = [
  { name: "《PLDS 结构设计说明》", version: "v1", preview: "uart_top / baud_gen / uart_tx / uart_rx 四单元；单时钟域；rxd 单级同步。" },
  { name: "《PLDS 详细设计说明》", version: "v2", preview: "CLKS_PER_BIT=10417；IDLE→START→DATA→STOP；中点采样 5208；frame_err 单拍。" },
];

function approve() { decision.value = "approved"; }
function reject() { if (rejectReason.value.trim()) decision.value = "rejected"; }
function reset() { decision.value = "none"; rejectReason.value = ""; expandedDoc.value = null; }
</script>

<template>
  <div class="demo-root">
    <div class="demo-banner">
      布局预览 <b>B+就地审批</b> — 对话为主角，审批卡在信息流内就地完成
      <button class="d-btn ghost" style="margin-left:auto" @click="reset">重置演示状态</button>
    </div>
    <div style="flex:1;display:grid;grid-template-columns:1.6fr 1fr;min-height:0">
      <!-- 左：对话 -->
      <section style="display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--c-border)">
        <div style="padding:10px 16px;border-bottom:1px solid var(--c-border)">
          <b>{{ demoProject.name }}</b>
        </div>
        <div class="d-scroll" style="flex:1;padding:16px">
          <div class="d-feed">
            <template v-for="(it, i) in demoFeed" :key="i">
              <div v-if="it.kind === 'user'" class="d-msg-user">{{ it.text }}</div>
              <div v-else-if="it.kind === 'text'" class="d-msg-text">{{ it.text }}</div>
              <div v-else-if="it.kind === 'doc'" class="d-row"><span class="d-doc">📄 {{ it.text }}<span class="meta">{{ it.meta }}</span></span></div>
              <div v-else-if="it.kind === 'tool'" class="d-tool" :class="it.status"><span :class="{ spin: it.status === 'run' }">{{ icon(it.status) }}</span>{{ it.text }}<span class="dur">{{ it.meta }}</span></div>
              <div v-else-if="it.kind === 'gate'" class="d-row d-gate-ok">✓ {{ it.text }}</div>
            </template>

            <!-- 就地审批卡（信息流内） -->
            <div v-if="decision === 'none'" style="border:1px solid var(--c-warn);border-radius:10px;padding:12px;background:var(--c-panel);max-width:95%">
              <div class="d-row" style="color:var(--c-warn);margin-bottom:8px">⏸ <b>G3 设计审查等待你批准</b><span style="color:var(--c-text-dim);font-size:11px">提交 sub_g3_demo</span></div>
              <div class="d-pane-title">待审候选产物（{{ pendingDocs.length }}）</div>
              <div v-for="d in pendingDocs" :key="d.name" class="d-art" style="margin-bottom:6px">
                <div class="head">
                  <b style="font-size:13px">{{ d.name }}</b>
                  <span class="d-chip">{{ d.version }} 候选</span>
                  <a style="color:var(--c-accent);font-size:12px;margin-left:auto;cursor:pointer" @click="expandedDoc = expandedDoc === d.name ? null : d.name">
                    {{ expandedDoc === d.name ? "收起" : "展开" }}
                  </a>
                </div>
                <div v-if="expandedDoc === d.name" class="body" style="margin-top:6px">{{ d.preview }}</div>
              </div>
              <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
                <button class="d-btn" style="width:fit-content" @click="approve">✓ 批准并建立 B1 设计里程碑</button>
                <div style="display:flex;gap:8px">
                  <input v-model="rejectReason" placeholder="驳回理由（必填）"
                    style="flex:1;border:1px solid var(--c-border);border-radius:6px;padding:6px 8px;background:var(--c-bg);color:var(--c-text)" />
                  <button class="d-btn ghost" :style="{ opacity: rejectReason.trim() ? 1 : 0.4 }" @click="reject">驳回</button>
                </div>
              </div>
            </div>

            <!-- 审批结果（追加进信息流） -->
            <div v-else-if="decision === 'approved'" class="d-row" style="border:1px solid var(--c-ok);border-radius:10px;padding:10px;background:var(--c-panel);max-width:95%">
              <div>
                <div class="d-gate-ok" style="font-size:14px">✓ 已批准 G3 设计审查</div>
                <div style="color:var(--c-accent);margin-top:4px">🏁 已建立 <b>B1 设计里程碑</b></div>
                <div style="color:var(--c-text-dim);font-size:12px;margin-top:4px">批准人：admin · 刚刚</div>
              </div>
            </div>
            <div v-else class="d-row" style="border:1px solid var(--c-danger);border-radius:10px;padding:10px;background:var(--c-panel);max-width:95%">
              <div>
                <div class="d-fail" style="font-size:14px">✗ 已驳回 G3 设计审查提交</div>
                <div style="color:var(--c-text-dim);font-size:12px;margin-top:4px">理由：{{ rejectReason }}</div>
                <div style="color:var(--c-text-dim);font-size:12px">提交已退回，Agent 可修改后重新提交</div>
              </div>
            </div>

            <!-- 批准后对话继续 -->
            <template v-if="decision === 'approved'">
              <div class="d-msg-text">设计审查已通过。继续推进 RTL 实现阶段。</div>
              <div class="d-tool run"><span class="spin">⟳</span>RTL 生成<span class="dur">进行中…</span></div>
            </template>
          </div>
        </div>
        <div class="d-input"><div class="box">输入消息，与 Synthia 对话…</div><button class="d-btn">发送</button></div>
      </section>

      <!-- 右：标签 -->
      <section style="display:flex;flex-direction:column;min-height:0">
        <div class="d-tabs">
          <span :class="{ on: tab === 'flow' }" @click="tab = 'flow'">流程</span>
          <span :class="{ on: tab === 'artifacts' }" @click="tab = 'artifacts'">产物</span>
          <span :class="{ on: tab === 'runs' }" @click="tab = 'runs'">记录</span>
        </div>
        <div class="d-scroll" style="flex:1;padding:14px">
          <template v-if="tab === 'flow'">
            <div class="d-pane-title">阶段门</div>
            <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">
              <span v-for="g in demoProject.gates" :key="g.id" class="d-chip" :class="g.state" style="width:fit-content">{{ g.id }} {{ g.name }}</span>
            </div>
            <div class="d-pane-title">里程碑</div>
            <div style="display:flex;flex-direction:column;gap:6px">
              <span v-for="m in demoProject.milestones" :key="m.id" class="d-chip mile" :class="{ off: !m.active && !(m.id === 'B1' && decision === 'approved') }" style="width:fit-content">{{ m.id }} {{ m.name }}</span>
            </div>
          </template>
          <template v-else-if="tab === 'artifacts'">
            <div v-for="a in demoArtifacts" :key="a.doc" class="d-art">
              <div class="head"><b style="font-size:13px">{{ a.doc }}</b><span class="d-chip">v{{ a.version }}</span></div>
              <div class="body">{{ a.content.slice(0, 60) }}…</div>
            </div>
          </template>
          <template v-else>
            <div v-for="r in demoRuns" :key="r.op + r.state" class="d-row" style="justify-content:space-between;border-bottom:1px solid var(--c-border);padding:6px 0">
              <span>{{ r.op }}</span>
              <span :class="r.state === 'succeeded' ? 'd-ok' : r.state === 'failed' ? 'd-fail' : 'd-run'">{{ r.state === 'succeeded' ? '成功' : r.state === 'failed' ? '失败' : '运行中' }}</span>
            </div>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>
