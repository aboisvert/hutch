// Executed by the actual managed Bun in bun-toolchain-smoke.js on every host.
// Publicly compromised certificate fixture from Bun's security regression:
// https://github.com/oven-sh/bun/pull/46300 (MIT).
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { connect, rootCertificates } from "node:tls";

const distrustedRoots = new Set([
  "86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B",
  "125609AA301DA0A249B97A8239CB6A34216F44DCAC9F3954B14292F2E8C8608F",
  "BC4D809B15189D78DB3E1D8CF4F9726A795DA1643CA5F1358E1DDB0EDC0D7EB3",
]);
assert(rootCertificates.length > 100, "Bun must retain its normal public trust store");
for (const pem of rootCertificates) {
  const certificate = new X509Certificate(pem);
  assert(!distrustedRoots.has(certificate.fingerprint256.replaceAll(":", "")),
    `Distrusted emSign root remains bundled: ${certificate.subject}`);
}

const fixture = name => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const cert = fixture("emsign-blocked-intermediate.pem");
assert.equal(createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("hex"),
  "49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f");
// The localhost leaf was signed using this publicly compromised CA's known
// scalar 230. Its generated key is a test fixture, never a production secret.
const key = fixture("tls-test-key.pem");
const server = createServer({ key, cert: fixture("emsign-test-leaf.pem") + "\n" + cert }, (_request, response) => response.end("verified"));
server.on("tlsClientError", () => {});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
try {
  const code = await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, ca: cert, checkServerIdentity: () => undefined });
    socket.setTimeout(5000, () => socket.destroy(new Error("TLS security probe timed out")));
    socket.once("error", error => resolve(error.code));
    socket.once("secureConnect", () => { socket.destroy(); reject(new Error("Bun accepted a blocked public key")); });
  });
  assert.equal(code, "CERT_REVOKED", "node:tls must reject the compromised key even with an explicit CA");
  await assert.rejects(fetch(`https://127.0.0.1:${port}`, {
    tls: { ca: cert, checkServerIdentity: () => undefined }, signal: AbortSignal.timeout(5000),
  }), error => error.code === "CERT_REVOKED", "fetch must reject the compromised key");

  const control = fixture("tls-control-cert.pem");
  const controlServer = createServer({ key, cert: control }, (_request, response) => {
    response.setHeader("Connection", "close");
    response.end("verified");
  });
  controlServer.listen(0, "127.0.0.1");
  await once(controlServer, "listening");
  const controlPort = controlServer.address().port;
  try {
    const socket = connect({ host: "127.0.0.1", port: controlPort, ca: control, checkServerIdentity: () => undefined });
    socket.setTimeout(5000, () => socket.destroy(new Error("TLS control timed out")));
    try {
      await once(socket, "secureConnect");
      assert.equal(socket.authorized, true, "An unrelated explicitly trusted key must still work");
    } finally { socket.destroy(); }
    const response = await fetch(`https://127.0.0.1:${controlPort}`, {
      tls: { ca: control, checkServerIdentity: () => undefined }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(await response.text(), "verified");
  } finally {
    await new Promise((resolve, reject) => controlServer.close(error => error ? reject(error) : resolve()));
  }
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log(`OK Bun ${process.versions.bun}: emSign roots removed; node:tls and fetch reject compromised keys`);
