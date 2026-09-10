-- 0021: 权限交互进 core 会话事件（permission_request / permission_decision）
--
-- 可请求名单内的工具调用由 runtime 挂起、用户在 UI 卡片上裁决。请求与裁决
-- 作为会话事件落库：卡片刷新后仍在流内可见，裁决留痕可回放。红线 GJB 操作
-- 不经过此机制（beforeToolCall 硬拦，与用户意愿无关）。

ALTER TABLE task_conversation_event DROP CONSTRAINT IF EXISTS task_conversation_event_event_kind_check;
ALTER TABLE task_conversation_event
  ADD CONSTRAINT task_conversation_event_event_kind_check
  CHECK (event_kind IN (
    'user_message','assistant_message','assistant_thinking',
    'tool_call','tool_result','status',
    'permission_request','permission_decision'
  ));

INSERT INTO schema_migrations(version) VALUES ('0021_permission_events') ON CONFLICT (version) DO NOTHING;
