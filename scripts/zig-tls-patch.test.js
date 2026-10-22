import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { patchZigTls, tlsPatch } from "./patch-zig-tls.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = value => createHash("sha256").update(value).digest("hex");
async function fixture(t, pristine = true) {
  const destination = await mkdtemp(path.join(tmpdir(), "hutch-zig-tls-patch-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  for (const file of tlsPatch.files) {
    let source = await readFile(path.join(root, "vendors/zig", file.path), "utf8");
    assert.equal(sha256(source), file.patchedSha256, "setup must apply the pinned policy before tests");
    if (pristine) for (const edit of [...file.edits].reverse()) source = source.replace(edit.after, edit.before);
    const target = path.join(destination, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return destination;
}

test("TLS patch authenticates pristine sources and is idempotent", async t => {
  const destination = await fixture(t);
  await assert.rejects(patchZigTls(destination, { checkOnly: true }), /patch missing/);
  assert.equal((await patchZigTls(destination)).changed, true);
  assert.equal((await patchZigTls(destination, { checkOnly: true })).changed, false);
  for (const file of tlsPatch.files) assert.equal(sha256(await readFile(path.join(destination, file.path))), file.patchedSha256);
});

test("TLS patch validates all files before writing and fails closed on drift", async t => {
  const destination = await fixture(t);
  const last = tlsPatch.files.at(-1);
  await writeFile(path.join(destination, last.path), "unexpected compiler source\n");
  await assert.rejects(patchZigTls(destination), /source drift/);
  assert.equal(sha256(await readFile(path.join(destination, tlsPatch.files[0].path))), tlsPatch.files[0].pristineSha256);
});

test("TLS patch recovers a partially patched install and normalizes CRLF", async t => {
  const destination = await fixture(t);
  const first = tlsPatch.files[0];
  await writeFile(path.join(destination, first.path), (await readFile(path.join(root, "vendors/zig", first.path), "utf8")).replaceAll("\n", "\r\n"));
  await patchZigTls(destination);
  for (const file of tlsPatch.files) assert.equal(sha256(await readFile(path.join(destination, file.path))), file.patchedSha256);
});

test("TLS verification never rewrites already patched CRLF sources", async t => {
  const destination = await fixture(t, false);
  const target = path.join(destination, tlsPatch.files[0].path);
  const source = (await readFile(target, "utf8")).replaceAll("\n", "\r\n");
  await writeFile(target, source);
  assert.equal((await patchZigTls(destination, { checkOnly: true })).changed, false);
  assert.equal(await readFile(target, "utf8"), source);
});
