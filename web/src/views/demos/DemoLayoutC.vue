<script setup lang="ts">
import { ref, computed } from "vue";
import { demoStages, demoFeed } from "./shared.ts";
import "./demo.css";

const sel = ref("G3");
const icon = (s?: string) => (s === "ok" ? "✓" : s === "fail" ? "✗" : s === "run" ? "⟳" : s === "wait" ? "⏸" : "");

type SubmissionState = "approved" | "in_review" | "rejected" | "none";
interface GatePanel {
  title: string;
  docs: { name: string; version: string; preview: string }[];
  submission: SubmissionState;
  milestone?: string;
  approverNote?: string;
}

const panels = ref<Record<string, GatePanel>>({
  G1: {
    title: "需求审查",
    docs: [{ name: "《研制（开发）技术要求》", version: "v1", preview: "功能：UART 全双工收发 9600 8N1；位时间误差 ≤0.5%；环回 4 字节自检。" }],
    submission: "approved",
    milestone: "B0 需求里程碑",
    approverNote: "admin · 08-14 10:15 批准",
  },
  G2: {
    title: "行为审查",
    docs: [{ name: "《PLDS 需求规格说明》", version: "v1", preview: "UART-SRS-FUN-001 复位后 tx 空闲高；FUN-002 tx_start 单拍触发；TIM-001 位周期 10417±1。" }],
    submission: "approved",
    milestone: "（非里程碑门，无基线）",
    approverNote: "admin · 08-14 11:02 批准",
  },
  G3: {
    title: "设计审查",
    docs: [
      { name: "《PLDS 结构设计说明》", version: "v1", preview: "uart_top / baud_gen / uart_tx / uart_rx 四单元；单时钟域；rxd 单级同步。" },
      { name: "《PLDS 详细设计说明》", version: "v2", preview: "CLKS_PER_BIT=10417；IDLE→START→DATA→STOP；中点采样 5208；frame_err 单拍。" },
    ],
    submission: "in_review",
    milestone: "B1 设计里程碑",
  },
  G4: {
    title: "RTL审查",
    docs: [],
    submission: "none",
  },
});

const expandedDoc = ref<string | null>(null);
const rejectReason = ref("");
const decision = ref<"none" | "approved" | "rejected">("none");

const current = computed(() => panels.value[sel.value]);

function approve() {
  decision.value = "approved";
}
function reject() {
  if (!rejectReason.value.trim()) return;
  decision.value = "rejected";
}
function reset() {
  decision.value = "none";
  rejectReason.value = "";
}
const selGate = (id: string) => { if (id.startsWith("G")) { sel.value = id; decision.value = "none"; rejectReason.value = ""; } };
</script>

<template>
  <div class="demo-root">
    <div class="demo-banner">
      布局预览 <b>C+就地审批</b> — 点左侧门节点，右侧就地查看与批准/驳回，不离开项目页
      <button class="d-btn ghost" style="margin-left:auto" @click="reset">重置演示状态</button>
    </div>
    <div style="flex:1;display:grid;grid-template-columns:170px 1.2fr 1.1fr;min-height:0">
      <!-- 左：流程轨道 -->
      <aside style="border-right:1px solid var(--c-border);padding:14px 10px;background:var(--c-panel)" class="d-scroll">
        <div class="d-pane-title" style="padding-left:6px">流程轨道</div>
        <template v-for="s in demoStages" :key="s.id">
          <div class="d-stage" :class="[s.state, { 'gate-node': s.gate }]"
            :style="s.gate ? 'cursor:pointer;' + (sel === s.id ? 'background:var(--c-sidebar-active);border-radius:6px;' : '') : ''"
            @click="s.gate && selGate(s.id)">
            <span class="dot"></span>{{ s.name }}
          </div>
          <div v-if="s.gate && s.id !== 'G4'" style="width:1px;height:10px;background:var(--c-border);margin-left:9px"></div>
        </template>
      </aside>

      <!-- 中：对话 -->
      <section class="d-scroll" style="padding:14px;border-right:1px solid var(--c-border)">
        <div class="d-pane-title">对话</div>
        <div class="d-feed">
          <template v-for="(it, i) in demoFeed" :key="i">
            <div v-if="it.kind === 'user'" class="d-msg-user">{{ it.text }}</div>
            <div v-else-if="it.kind === 'text'" class="d-msg-text">{{ it.text }}</div>
            <div v-else-if="it.kind === 'doc'" class="d-row"><span class="d-doc">📄 {{ it.text }}<span class="meta">{{ it.meta }}</span></span></div>
            <div v-else-if="it.kind === 'tool'" class="d-tool" :class="it.status"><span :class="{ spin: it.status === 'run' }">{{ icon(it.status) }}</span>{{ it.text }}<span class="dur">{{ it.meta }}</span></div>
            <div v-else-if="it.kind === 'gate'" class="d-row d-gate-ok">✓ {{ it.text }}</div>
            <div v-else-if="it.kind === 'note'" class="d-note-wait">⏸ {{ it.text }}</div>
          </template>
        </div>
      </section>

      <!-- 右：门内容 + 就地审批 -->
      <section class="d-scroll" style="padding:14px">
        <div class="d-pane-title">{{ sel }} · {{ current.title }}</div>

        <!-- 已批准态 -->
        <template v-if="current.submission === 'approved'">
          <div v-for="d in current.docs" :key="d.name" class="d-art">
            <div class="head"><b style="font-size:13px">{{ d.name }}</b><span class="d-chip">{{ d.version }} 候选</span></div>
          </div>
          <div class="d-row d-gate-ok" style="margin-top:12px">✓ 已批准 <span v-if="current.milestone" style="color:var(--c-accent);font-size:12px">（{{ current.milestone }}）</span></div>
          <div style="color:var(--c-text-dim);font-size:12px;margin-top:4px">{{ current.approverNote }}</div>
        </template>

        <!-- 未到阶段 -->
        <template v-else-if="current.submission === 'none'">
          <div class="d-art"><div class="body">尚未到该阶段。需先完成 RTL 实现、编译检查、仿真、综合与实现。</div></div>
        </template>

        <!-- 待审批：就地审批面板 -->
        <template v-else>
          <div v-if="decision === 'none'">
            <div class="d-pane-title" style="margin-bottom:6px">待审候选产物（{{ current.docs.length }}）</div>
            <div v-for="d in current.docs" :key="d.name" class="d-art">
              <div class="head">
                <b style="font-size:13px">{{ d.name }}</b>
                <span class="d-chip">{{ d.version }} 候选</span>
                <a style="color:var(--c-accent);font-size:12px;margin-left:auto;cursor:pointer" @click="expandedDoc = expandedDoc === d.name ? null : d.name">
                  {{ expandedDoc === d.name ? "收起" : "展开内容" }}
                </a>
              </div>
              <div v-if="expandedDoc === d.name" class="body" style="margin-top:6px">{{ d.preview }}</div>
            </div>

            <div style="border-top:1px solid var(--c-border);margin-top:14px;padding-top:12px">
              <div class="d-pane-title">审批操作（提交 sub_g3_demo）</div>
              <div style="display:flex;flex-direction:column;gap:8px">
                <button class="d-btn" style="width:fit-content" @click="approve">✓ 批准并建立{{ current.milestone }}</button>
                <div style="display:flex;gap:8px;align-items:center">
                  <input v-model="rejectReason" placeholder="驳回理由（必填）"
                    style="flex:1;border:1px solid var(--c-border);border-radius:6px;padding:6px 8px;background:var(--c-panel);color:var(--c-text)" />
                  <button class="d-btn ghost" :style="{ opacity: rejectReason.trim() ? 1 : 0.4 }" @click="reject">驳回</button>
                </div>
              </div>
            </div>
          </div>

          <!-- 审批后反馈 -->
          <div v-else-if="decision === 'approved'" style="margin-top:12px">
            <div class="d-row d-gate-ok" style="font-size:15px">✓ 已批准</div>
            <div class="d-row" style="color:var(--c-accent);margin-top:8px">🏁 已建立 <b>{{ current.milestone }}</b></div>
            <div style="color:var(--c-text-dim);font-size:12px;margin-top:8px">批准人：admin · 刚刚 · 项目继续推进至 RTL 实现阶段</div>
          </div>
          <div v-else style="margin-top:12px">
            <div class="d-row d-fail" style="font-size:15px">✗ 已驳回</div>
            <div style="color:var(--c-text-dim);font-size:12px;margin-top:8px">理由：{{ rejectReason }}</div>
            <div style="color:var(--c-text-dim);font-size:12px;margin-top:4px">提交已退回，Agent 可修改后重新提交</div>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>
