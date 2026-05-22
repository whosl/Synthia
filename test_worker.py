import time, json
from edagent_vivado.web.hapi_bridge import _agent_worker, _new_id, MESSAGE_STORE, SESSION_STORE, SEQ_COUNTERS
sid = _new_id()
SESSION_STORE[sid] = {"thinking": False}
MESSAGE_STORE[sid] = []
SEQ_COUNTERS[sid] = 0
_agent_worker(sid, "What is [Synth 8-439]? Answer in one sentence.")
time.sleep(15)
msgs = MESSAGE_STORE.get(sid, [])
for m in msgs:
    print(json.dumps(m, indent=2, ensure_ascii=False, default=str)[:3000])
