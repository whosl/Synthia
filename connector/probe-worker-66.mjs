import https from "node:https";
import fs from "node:fs";
const root = "D:/synthia-worker";
const password = fs.readFileSync(`${root}/pfx-password.txt`, "utf8");
const options = { hostname: "192.168.31.66", port: 8443, ca: fs.readFileSync(`${root}/client-ca.cer`), pfx: fs.readFileSync(`${root}/client.pfx`), passphrase: password, rejectUnauthorized: true, servername: "DESKTOP-DVFFB09" };
let sequence = 0;
function call(path, payload, capability = "connector.remote.v1") {
  return new Promise((resolve, reject) => {
    const envelope = { schema_version: "connector.remote.v1", correlation_id: `probe-${++sequence}`, idempotency_key: `probe-${path}-${sequence}`, actor: { actor_type: "service", actor_id: "synthia-probe" }, project_id: "p1", classification: "internal", capability_version: capability, payload };
    const req = https.request({ ...options, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(JSON.stringify(envelope)) } }, res => { let text = ""; res.setEncoding("utf8"); res.on("data", chunk => text += chunk); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) })); });
    req.on("error", reject); req.end(JSON.stringify(envelope));
  });
}
for (const [path, payload] of [["/registration", {}], ["/heartbeat", { connector_id: "vivado-66-xc7k70t" }], ["/discover", { connector_id: "vivado-66-xc7k70t" }]]) {
  const result = await call(path, payload);
  console.log(`${path} status=${result.status}`);
  console.log(JSON.stringify(result.body.payload ?? result.body));
}
