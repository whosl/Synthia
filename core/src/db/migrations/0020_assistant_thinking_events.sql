-- 0016: 思维链进 core 会话事件（assistant_thinking）
--
-- runtime 在 free-agent 轮次 finalize 时把模型思维链作为 assistant_thinking
-- 事件同步进 task_conversation_event，刷新页面后 durableConversation 重放保持
-- 时序。此前 event_kind 的 CHECK 白名单只允许 user/assistant/tool/status 四类，
-- 思维链只留在 runtime audit（会话尾部堆叠，顺序失真）。

ALTER TABLE task_conversation_event DROP CONSTRAINT IF EXISTS task_conversation_event_event_kind_check;
ALTER TABLE task_conversation_event
  ADD CONSTRAINT task_conversation_event_event_kind_check
  CHECK (event_kind IN ('user_message','assistant_message','assistant_thinking','tool_call','tool_result','status'));

INSERT INTO schema_migrations(version) VALUES ('0020_assistant_thinking_events') ON CONFLICT (version) DO NOTHING;
