#!/usr/bin/env node

// Exercise the packaged launcher and its exact published runtime pair with no
// local overrides or existing managed cache. A missing platform blocks release.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const source = readFileSync(join(root, "src/version.zig"), "utf8");
const pairedVersion = source.match(/paired_cottontail_version = "([^"]+)"/)?.[1];
assert(pairedVersion, "Hutch must declare an exact paired Cottontail version");
const platform = {
  "darwin-arm64": "macos-arm64",
  "darwin-x64": "macos-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "win32-x64": "windows-x64",
  "win32-arm64": "windows-arm64",
}[`${process.platform}-${process.arch}`];
assert(platform, `unsupported runtime smoke platform: ${process.platform}-${process.arch}`);
const fixture = mkdtempSync(join(tmpdir(), "hutch-published-pair-"));
const home = join(fixture, "home");
const project = join(fixture, "project");
const artifactBase = `hutch-v${version}-${platform}`;
const executableName = (name) => process.platform === "win32" ? `${name}.exe` : name;
const launcher = join(fixture, artifactBase, "bin", executableName("hutch"));
const engine = join(fixture, artifactBase, "bin", executableName("hutch-engine"));
const env = { ...process.env, HUTCH_HOME: home, HUTCH_NO_UPDATE_CHECK: "1" };
for (const key of [
  "HUTCH_ENGINE_BINARY", "HUTCH_DEFAULT_CLI", "HUTCH_LAUNCHER_PATH", "HUTCH_RUNTIME",
  "HUTCH_ACTIVE_CHANNEL", "COTTONTAIL_BINARY", "DASH_COTTONTAIL",
  "DASH_USE_LOCAL_COTTONTAIL", "DASH_LOCAL_COTTONTAIL_ROOT", "COTTONTAIL_ROOT",
  "DASH_COTTONTAIL_SELECTOR", "DASH_RELEASE_OFFLINE", "DASH_ARTIFACTS_BASE_URL",
]) delete env[key];

function run(command, args, environment = env) {
  const result = spawnSync(command, args, {
    cwd: project, env: environment, encoding: "utf8", timeout: 300_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

try {
  mkdirSync(project);
  run("tar", ["-xzf", join(root, "release", `${artifactBase}.tar.gz`), "-C", fixture]);
  assert.equal(existsSync(home), false, "runtime smoke must begin with an empty managed store");
  assert.equal(run(launcher, ["--version"]), version);
  assert.equal(run(engine, ["--version"]), version);
  const runtimePath = run(launcher, ["cottontail", "path"]);
  assert(runtimePath.startsWith(join(home, "releases", "cottontail", pairedVersion)), runtimePath);
  assert.equal(run(launcher, ["cottontail", "version"]), pairedVersion);
  writeFileSync(join(project, "identity.js"),
    'console.log(JSON.stringify({version: process.versions.cottontail, platform: process.platform, arch: process.arch}));\n');
  const identity = JSON.parse(run(launcher, ["identity.js"], { ...env, HUTCH_RUNTIME: "cottontail" }));
  assert.deepEqual(identity, { version: pairedVersion, platform: process.platform, arch: process.arch });
  assert.equal(run(launcher, ["cottontail", "path"], { ...env, DASH_RELEASE_OFFLINE: "1" }), runtimePath);
  console.log(`Packaged Hutch ${version} resolved and executed Cottontail ${pairedVersion} on ${platform}`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
