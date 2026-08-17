<script setup lang="ts">
import { ref } from "vue";
import { demoProject, demoStages, demoFeed, demoArtifacts, demoRuns } from "./shared.ts";
import "./demo.css";

const tab = ref<"preview" | "artifacts" | "runs">("preview");
const icon = (s?: string) => (s === "ok" ? "✓" : s === "fail" ? "✗" : s === "run" ? "⟳" : s === "wait" ? "⏸" : "");
</script>

<template>
  <div class="demo-root">
    <!-- 常驻状态条 -->
    <div style="display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid var(--c-border);background:var(--c-panel)">
      <b>{{ demoProject.name }}</b>
      <span style="color:var(--c-text-dim);font-size:12px">{{ demoProject.part }}</span>
      <span style="flex:1"></span>
      <span v-for="g in demoProject.gates" :key="g.id" class="d-chip" :class="g.state">{{ g.id }} {{ g.name }}</span>
      <span style="width:12px"></span>
      <span v-for="m in demoProject.milestones" :key="m.id" class="d-chip mile" :class="{ off: !m.active }">{{ m.id }} {{ m.name }}</span>
    </div>
    <div class="demo-banner">布局预览 <b>A · 驾驶舱式</b> — 流程状态常驻顶部，下三栏，右侧标签页切换产物/记录</div>

    <div style="flex:1;display:grid;grid-template-columns:1.2fr 0.8fr 1.2fr;min-height:0">
      <!-- 左：对话信息流 -->
      <section class="d-scroll" style="padding:14px;border-right:1px solid var(--c-border)">
        <div class="d-pane-title">对话</div>
        <div class="d-feed">
          <template v-for="(it, i) in demoFeed" :key="i">
            <div v-if="it.kind === 'user'" class="d-msg-user">{{ it.text }}</div>
            <div v-else-if="it.kind === 'text'" class="d-msg-text">{{ it.text }}</div>
            <div v-else-if="it.kind === 'doc'" class="d-row"><span class="d-doc">📄 {{ it.text }}<span class="meta">{{ it.meta }}</span></span></div>
            <div v-else-if="it.kind === 'tool'" class="d-tool" :class="it.status"><span :class="{ spin: it.status === 'run' }">{{ icon(it.status) }}</span>{{ it.text }}<span class="dur">{{ it.meta }}</span></div>
            <div v-else-if="it.kind === 'gate'" class="d-row d-gate-ok">✓ {{ it.text }}<span style="color:var(--c-text-dim);font-size:11px">{{ it.meta }}</span></div>
            <div v-else-if="it.kind === 'note'" class="d-note-wait">⏸ {{ it.text }}</div>
          </template>
        </div>
      </section>

      <!-- 中：阶段链 -->
      <section class="d-scroll" style="padding:14px;border-right:1px solid var(--c-border)">
        <div class="d-pane-title">阶段链</div>
        <div v-for="s in demoStages" :key="s.id" class="d-stage" :class="[s.state, { 'gate-node': s.gate }]">
          <span class="dot"></span>{{ s.name }}
          <span v-if="s.state === 'current'" style="color:var(--c-warn);font-size:11px">等待批准</span>
        </div>
      </section>

      <!-- 右：标签页 -->
      <section style="display:flex;flex-direction:column;min-height:0">
        <div class="d-tabs">
          <span :class="{ on: tab === 'preview' }" @click="tab = 'preview'">产物预览</span>
          <span :class="{ on: tab === 'artifacts' }" @click="tab = 'artifacts'">产物库</span>
          <span :class="{ on: tab === 'runs' }" @click="tab = 'runs'">运行记录</span>
        </div>
        <div class="d-scroll" style="flex:1;padding:14px">
          <template v-if="tab === 'preview'">
            <div class="d-pane-title">《PLDS 需求规格说明》 候选 v1</div>
            <div class="d-art"><div class="body">
              <b>UART-SRS-FUN-001</b> 上电复位后 tx 保持空闲高电平<br><br>
              <b>UART-SRS-FUN-002</b> tx_start 单拍脉冲触发一帧发送（起始位 + 8 数据位 + 停止位）<br><br>
              <b>UART-SRS-TIM-001</b> 位周期 10417±1 系统时钟（9600 bps，100MHz）<br><br>
              <b>UART-SRS-CKR-001</b> 单一 100MHz 时钟域，rxd 输入单级同步
            </div></div>
          </template>
          <template v-else-if="tab === 'artifacts'">
            <div v-for="(g, t) in { 需求: demoArtifacts.filter(a => a.type === '需求'), 设计: demoArtifacts.filter(a => a.type === '设计'), 实现: demoArtifacts.filter(a => a.type === '实现') }" :key="t">
              <div class="d-pane-title" style="margin-top:6px">{{ t }}</div>
              <div v-for="a in g" :key="a.doc" class="d-art">
                <div class="head"><b>{{ a.doc }}</b><span class="d-chip">v{{ a.version }} {{ a.state }}</span></div>
              </div>
            </div>
          </template>
          <template v-else>
            <table class="d-table">
              <thead><tr><th>工具运行</th><th>状态</th><th>耗时</th><th>备注</th></tr></thead>
              <tbody>
                <tr v-for="r in demoRuns" :key="r.op + r.state">
                  <td>{{ r.op }}</td>
                  <td :class="r.state === 'succeeded' ? 'd-ok' : r.state === 'failed' ? 'd-fail' : 'd-run'">
                    {{ r.state === 'succeeded' ? '成功' : r.state === 'failed' ? '失败' : '运行中' }}
                  </td>
                  <td>{{ r.duration }}</td><td style="color:var(--c-text-dim)">{{ r.note ?? '' }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>
      </section>
    </div>

    <div class="d-banner-wait">⏸ 等待 <b>{{ demoProject.awaitingGate }}</b> 人工批准 <button class="d-btn">去审批</button></div>
    <div class="d-input"><div class="box">输入消息，与 Synthia 对话…</div><button class="d-btn">发送</button></div>
  </div>
</template>
