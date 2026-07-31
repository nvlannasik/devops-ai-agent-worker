import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { parseSocksProxy, buildSocksFetch } from "./socks.js";

test("parseSocksProxy parses url, auth, socks4/5, and rejects junk", () => {
  assert.deepEqual(parseSocksProxy("socks5://127.0.0.1:1080"), { type: 5, host: "127.0.0.1", port: 1080 });
  assert.deepEqual(parseSocksProxy("socks4://10.0.0.1:9050"), { type: 4, host: "10.0.0.1", port: 9050 });
  assert.deepEqual(parseSocksProxy("socks5://user:p%40ss@host:1081"), { type: 5, host: "host", port: 1081, userId: "user", password: "p@ss" });
  assert.equal(parseSocksProxy("socks5://host")?.port, 1080); // default port
  assert.equal(parseSocksProxy(""), null);
  assert.equal(parseSocksProxy("not a url"), null);
});

// Minimal no-auth SOCKS5 CONNECT server — enough to prove a fetch dispatched through the
// socks dispatcher actually traverses the proxy (catches wiring / undici-compat breakage).
function startSocksServer(): Promise<{ port: number; connects: string[]; close: () => void }> {
  const connects: string[] = [];
  const server = net.createServer((client) => {
    client.once("data", () => {
      client.write(Buffer.from([0x05, 0x00])); // greeting → no-auth
      client.once("data", (req) => {
        const atyp = req[3];
        let host: string;
        let offset: number;
        if (atyp === 0x01) {
          host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
          offset = 8;
        } else if (atyp === 0x03) {
          const len = req[4];
          host = req.subarray(5, 5 + len).toString();
          offset = 5 + len;
        } else {
          client.end();
          return;
        }
        const port = req.readUInt16BE(offset);
        connects.push(`${host}:${port}`);
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // success
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on("error", () => client.end());
      });
    });
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res({ port: (server.address() as net.AddressInfo).port, connects, close: () => server.close() })));
}

function startTarget(): Promise<{ port: number; close: () => void }> {
  // Connection: close so undici doesn't keep the socket pooled after the test (clean exit)
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { Connection: "close" });
    res.end("ok");
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })));
}

test("buildSocksFetch routes a request to the target VIA the SOCKS proxy", async () => {
  const target = await startTarget();
  const proxy = await startSocksServer();
  const socksFetch = buildSocksFetch({ type: 5, host: "127.0.0.1", port: proxy.port });

  const res = await socksFetch(`http://127.0.0.1:${target.port}/`);
  const body = await res.text();

  assert.equal(body, "ok"); // response actually came back through the proxy
  assert.ok(proxy.connects.some((c) => c.endsWith(`:${target.port}`)), `proxy should have seen a CONNECT to the target; saw ${JSON.stringify(proxy.connects)}`);

  target.close();
  proxy.close();
});
