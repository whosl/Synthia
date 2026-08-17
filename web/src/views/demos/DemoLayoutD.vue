<script setup lang="ts">
import { demoProject, demoFeed, demoArtifacts, demoRuns } from "./shared.ts";
import "./demo.css";

const icon = (s?: string) => (s === "ok" ? "✓" : s === "fail" ? "✗" : s === "run" ? "⟳" : s === "wait" ? "⏸" : "");
</script>

<template>
  <div class="demo-root">
    <div class="demo-banner" style="position:sticky;top:0;background:var(--c-bg);z-index:2">
      布局预览 <b>D · 分组滚动式</b> — 四个区块一屏滚到底
      <span style="margin-left:auto">
        <a href="#d1" style="color:var(--c-accent)">状态</a> ·
        <a href="#d2" style="color:var(--c-accent)">对话</a> ·
        <a href="#d3" style="color:var(--c-accent)">产物</a> ·
        <a href="#d4" style="color:var(--c-accent)">记录</a>
      </span>
    </div>
    <div class="d-scroll" style="flex:1">
      <!-- ① 状态卡 -->
      <section id="d1" style="padding:16px;border-bottom:1px solid var(--c-border)">
        <div class="d-pane-title">① 项目状态 · {{ demoProject.name }}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
          <span v-for="g in demoProject.gates" :key="g.id" class="d-chip" :class="g.state">{{ g.id }} {{ g.name }}</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <span v-for="m in demoProject.milestones" :key="m.id" class="d-chip mile" :class="{ off: !m.active }">{{ m.id }} {{ m.name }}</span>
        </div>
        <div class="d-note-wait" style="margin-top:12px">⏸ 等待 {{ demoProject.awaitingGate }} 人工批准</div>
      </section>

      <!-- ② 对话工作台 -->
      <section id="d2" style="padding:16px;border-bottom:1px solid var(--c-border)">
        <div class="d-pane-title">② 对话工作台</div>
        <div class="d-feed" style="max-width:860px">
          <template v-for="(it, i) in demoFeed" :key="i">
            <div v-if="it.kind === 'user'" class="d-msg-user">{{ it.text }}</div>
            <div v-else-if="it.kind === 'text'" class="d-msg-text">{{ it.text }}</div>
            <div v-else-if="it.kind === 'doc'" class="d-row"><span class="d-doc">📄 {{ it.text }}<span class="meta">{{ it.meta }}</span></span></div>
            <div v-else-if="it.kind === 'tool'" class="d-tool" :class="it.status"><span :class="{ spin: it.status === 'run' }">{{ icon(it.status) }}</span>{{ it.text }}<span class="dur">{{ it.meta }}</span></div>
            <div v-else-if="it.kind === 'gate'" class="d-row d-gate-ok">✓ {{ it.text }}</div>
            <div v-else-if="it.kind === 'note'" class="d-note-wait">⏸ {{ it.text }}</div>
          </template>
        </div>
        <div class="d-input" style="padding:12px 0 0;border-top:none;max-width:860px"><div class="box">输入消息…</div><button class="d-btn">发送</button></div>
      </section>

      <!-- ③ 产物库 -->
      <section id="d3" style="padding:16px;border-bottom:1px solid var(--c-border)">
        <div class="d-pane-title">③ 产物库</div>
        <div v-for="a in demoArtifacts" :key="a.doc" class="d-art" style="max-width:860px">
          <div class="head"><b>{{ a.doc }}</b><span class="d-chip">v{{ a.version }} {{ a.state }}</span><span style="color:var(--c-text-dim);font-size:11px">{{ a.time }}</span></div>
          <div class="body">{{ a.content }}</div>
        </div>
      </section>

      <!-- ④ 运行记录 -->
      <section id="d4" style="padding:16px">
        <div class="d-pane-title">④ 运行记录</div>
        <table class="d-table" style="max-width:860px">
          <thead><tr><th>工具运行</th><th>状态</th><th>耗时</th><th>备注</th></tr></thead>
          <tbody>
            <tr v-for="r in demoRuns" :key="r.op + r.state">
              <td>{{ r.op }}</td>
              <td :class="r.state === 'succeeded' ? 'd-ok' : r.state === 'failed' ? 'd-fail' : 'd-run'">{{ r.state === 'succeeded' ? '成功' : r.state === 'failed' ? '失败' : '运行中' }}</td>
              <td>{{ r.duration }}</td><td style="color:var(--c-text-dim)">{{ r.note ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>
