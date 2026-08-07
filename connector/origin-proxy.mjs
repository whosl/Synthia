import http from "node:http";
import https from "node:https";
import fs from "node:fs";
const root = "/etc/synthia-mtls";
const tls = { ca: fs.readFileSync(`${root}/client-ca.pem`), cert: fs.readFileSync(`${root}/origin-client.crt.pem`), key: fs.readFileSync(`${root}/origin-client.key.pem`), servername: "DESKTOP-DVFFB09", rejectUnauthorized: true };
const server = http.createServer((req, res) => {
  const upstream = https.request({ ...tls, hostname: "192.168.31.66", port: 8443, path: req.url, method: req.method, headers: { ...req.headers, host: "DESKTOP-DVFFB09" } }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on("error", error => { res.writeHead(502, { "content-type": "text/plain" }); res.end(`origin unavailable: ${error.code ?? "tls"}`); });
  req.pipe(upstream);
});
server.listen(18443, "127.0.0.1", () => console.log("synthia origin proxy listening on 127.0.0.1:18443"));
