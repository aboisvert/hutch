import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createCoreFixture,
  executableName,
  hostContract,
} from "./v2-devkit-fixture.js";

const hutchRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hutchPragma = readFileSync(join(hutchRoot, "hutch.config.ts"), "utf8").match(
  /^\/\/\s*@hutch\s+cli=([^\s]+)\s+cottontail=([^\s]+)$/m,
);
assert.ok(hutchPragma, "Hutch's release pragma must carry exact CLI and Cottontail versions");
const currentHutchVersion = hutchPragma[1];
const pairedCottontailVersion = hutchPragma[2];

function nextPatchVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
	assert.ok(match, `expected an exact semantic version, got ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function run(command, args, options) {
  return new Promise((resolveResult, reject) => {
    const { input, ...spawnOptions } = options;
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: process.platform !== "win32",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      // A broken handoff guard can spawn a chain of waiting engines. Kill the
      // whole fixture process tree so that regression fails promptly in CI.
      if (child.pid) {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch {}
        }
      }
      reject(new Error(`Timed out running ${command} ${args.join(" ")}`));
    }, 60_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (status) => { clearTimeout(timer); resolveResult({ status, stdout, stderr }); });
    if (input !== undefined) child.stdin.end(input);
  });
}

function cacheHutchFixture(home, { version, engine, launcher }) {
  const revision = "b".repeat(40);
  const platform = hostContract().key;
  const root = join(home, "releases", "hutch", version, revision, platform);
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const selectedEngine = join(bin, executableName("hutch-engine"));
  const selectedLauncher = join(bin, executableName("hutch"));
  copyFileSync(engine, selectedEngine);
  copyFileSync(launcher, selectedLauncher);
  if (process.platform !== "win32") {
    chmodSync(selectedEngine, 0o755);
    chmodSync(selectedLauncher, 0o755);
  }
  writeFileSync(join(root, ".dash-installed"), "c".repeat(64));
  writeFileSync(join(root, "hutch-release.json"), JSON.stringify({
    schema: 1,
    kind: "archive",
    product: "hutch",
    channel: version.includes("-") ? "canary" : "production",
    version,
    revision,
    platform,
    launcher: `bin/${executableName("hutch")}`,
    executable: `bin/${executableName("hutch-engine")}`,
  }));
  writeFileSync(`${root}.lock`, "");
  return { root, engine: selectedEngine, launcher: selectedLauncher };
}

function resolveCottontail() {
  const configured = process.env.COTTONTAIL_BINARY ?? process.env.DASH_COTTONTAIL;
  if (configured) return resolve(configured);
  const hutch = join(hutchRoot, "zig-out", "bin", executableName("hutch"));
	const result = spawnSync(hutch, ["cottontail", "path"], {
		cwd: hutchRoot,
		encoding: "utf8",
		env: { ...process.env, HUTCH_ENGINE_BINARY: join(hutchRoot, "zig-out", "bin", executableName("hutch-engine")), HUTCH_NO_UPDATE_CHECK: "1" },
	});
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("hutch electrobun init lists and downloads the active remote template channel", async (t) => {
  const hutch = join(hutchRoot, "zig-out", "bin", executableName("hutch"));
  const engine = join(hutchRoot, "zig-out", "bin", executableName("hutch-engine"));
  assert.ok(existsSync(hutch), `Hutch must be built before this test: ${hutch}`);
  assert.ok(existsSync(engine), `Hutch engine must be built before this test: ${engine}`);

  const fixture = mkdtempSync(join(tmpdir(), "hutch-electrobun-init-"));
  const archiveSource = join(fixture, "archive-source");
  const templateRoot = join(archiveSource, "hello-world");
  const nativeTemplateRoot = join(archiveSource, "native-basic");
  const archivePath = join(fixture, "hello-world.tar.gz");
  const nativeArchivePath = join(fixture, "native-basic.tar.gz");
  const workspace = join(fixture, "workspace");
  const coreRoot = join(fixture, "core");
  const projectName = "sample-app";
  const version = "2.0.0";
  const cottontail = resolveCottontail();

  mkdirSync(join(templateRoot, "src"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const projectRoot = join(realpathSync(workspace), projectName);
  createCoreFixture(coreRoot, version);
  writeFileSync(join(templateRoot, "electrobun.config.ts"), `
export default {
  app: { name: "HelloWorld", identifier: "dev.electrobun.hello-world", version: "0.0.0" },
  build: {
    mainProcess: "cottontail",
    cottontail: { entrypoint: "src/index.ts" },
    mac: { icons: null, codesign: false, notarize: false, bundleCEF: false, bundleWGPU: false },
    win: { bundleCEF: false, bundleWGPU: false },
    linux: { bundleCEF: false, bundleWGPU: false },
  },
};
`);
  writeFileSync(
    join(templateRoot, "hutch.config.ts"),
    `export default { electrobun: { version: "${version}" }, scripts: { install: [process.execPath, "install.cjs"] } };\n`,
  );
  writeFileSync(
    join(templateRoot, "install.cjs"),
    'require("node:fs").writeFileSync(".configured-install-ran", process.cwd());\n',
  );
  writeFileSync(join(templateRoot, "src", "index.ts"), 'console.log("hello");\n');
  mkdirSync(join(nativeTemplateRoot, "src"), { recursive: true });
  writeFileSync(join(nativeTemplateRoot, "electrobun.config.ts"), `
export default {
  app: { name: "NativeBasic", identifier: "dev.electrobun.native-basic", version: "0.0.0" },
  build: {
    mainProcess: "cottontail",
    cottontail: { entrypoint: "src/index.ts" },
    mac: { icons: null, codesign: false, notarize: false, bundleCEF: false, bundleWGPU: false },
    win: { bundleCEF: false, bundleWGPU: false },
    linux: { bundleCEF: false, bundleWGPU: false },
  },
};
`);
  writeFileSync(
    join(nativeTemplateRoot, "hutch.config.ts"),
    `export default { electrobun: { version: "${version}" }, scripts: { dev: ["hutch", "electrobun", "dev"] } };\n`,
  );
  writeFileSync(join(nativeTemplateRoot, "src", "index.ts"), "console.log('native package-free');\n");
  const tar = spawnSync("tar", ["-czf", archivePath, "-C", archiveSource, "hello-world"], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  assert.equal(tar.status, 0, tar.stderr || tar.stdout);
  const nativeTar = spawnSync("tar", ["-czf", nativeArchivePath, "-C", archiveSource, "native-basic"], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  assert.equal(nativeTar.status, 0, nativeTar.stderr || nativeTar.stdout);
  const archive = readFileSync(archivePath);
  const checksum = createHash("sha256").update(archive).digest("hex");
  const nativeArchive = readFileSync(nativeArchivePath);
  const nativeChecksum = createHash("sha256").update(nativeArchive).digest("hex");
  const requestCounts = {
    channel: 0,
    helloArchive: 0,
    nativeArchive: 0,
    releaseManifest: 0,
    releaseArchive: 0,
  };
  let requiredHutchVersion = currentHutchVersion;
  let requiredCottontailVersion = pairedCottontailVersion;
  const corruptReleaseVersion = "98.0.0";
  const corruptReleaseArchive = Buffer.from("not the archive described by its checksum");

  let baseUrl;
  const server = createServer((request, response) => {
    if (request.url === "/channels/stable.json" || request.url === "/channels/beta.json") {
      requestCounts.channel += 1;
      const catalog = {
        schema: 1,
        kind: "electrobun-template-channel",
        channel: request.url === "/channels/beta.json" ? "beta" : "stable",
        version: "2.0.0",
        revision: "a".repeat(40),
        tools: {
          hutch: requiredHutchVersion,
          cottontail: requiredCottontailVersion,
        },
        templates: [
          {
            id: "hello-world",
            name: "Hello World",
            description: "A remote starter",
            mainProcess: "cottontail",
            archive: {
              url: `${baseUrl}/artifacts/${checksum}.tar.gz`,
              sha256: checksum,
              size: archive.length,
            },
          },
          {
            id: "native-basic",
            name: "Native Basic",
            description: "A package-free starter",
            mainProcess: "cottontail",
            archive: {
              url: `${baseUrl}/artifacts/${nativeChecksum}.tar.gz`,
              sha256: nativeChecksum,
              size: nativeArchive.length,
            },
          },
        ],
      };
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`${JSON.stringify(catalog)}\n`);
      }, 75);
      return;
    }
    if (request.url === `/artifacts/${checksum}.tar.gz`) {
      requestCounts.helloArchive += 1;
      response.writeHead(200, { "content-type": "application/gzip" });
      response.end(archive);
      return;
    }
    if (request.url === `/artifacts/${nativeChecksum}.tar.gz`) {
      requestCounts.nativeArchive += 1;
      response.writeHead(200, { "content-type": "application/gzip" });
      response.end(nativeArchive);
      return;
    }
    if (request.url?.startsWith("/hutch/releases/")) {
      requestCounts.releaseManifest += 1;
      if (request.url === `/hutch/releases/${corruptReleaseVersion}/manifest.json`) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          schema: 1,
          kind: "release",
          product: "hutch",
          version: corruptReleaseVersion,
          revision: "d".repeat(40),
          platforms: {
            [hostContract().key]: {
              archive: {
                url: `${baseUrl}/hutch/builds/corrupt.tar.gz`,
                sha256: "0".repeat(64),
                size: corruptReleaseArchive.length,
              },
            },
          },
        }));
        return;
      }
    }
    if (request.url === "/hutch/builds/corrupt.tar.gz") {
      requestCounts.releaseArchive += 1;
      response.writeHead(200, { "content-type": "application/gzip" });
      response.end(corruptReleaseArchive);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const dashHome = join(fixture, "dash-home");
  const env = {
    ...process.env,
    COTTONTAIL_BINARY: cottontail,
    DASH_COTTONTAIL: cottontail,
    DASH_HOME: dashHome,
    HUTCH_HOME: dashHome,
    DASH_ARTIFACTS_BASE_URL: baseUrl,
    ELECTROBUN_TEMPLATES_BASE_URL: baseUrl,
    HUTCH_ELECTROBUN_DEVKIT_ROOT: coreRoot,
    HUTCH_ENGINE_BINARY: engine,
    HUTCH_NO_UPDATE_CHECK: "1",
    HUTCH_ACTIVE_CHANNEL: "production",
  };

  try {
    const racedProjectName = "raced-app";
    const racedProjectRoot = join(realpathSync(workspace), racedProjectName);
    const raced = await Promise.all([
      run(
        hutch,
        ["electrobun", "init", racedProjectName, "--template=native-basic", "--skip-install"],
        { cwd: workspace, env },
      ),
      run(
        hutch,
        ["electrobun", "init", racedProjectName, "--template=native-basic", "--skip-install"],
        { cwd: workspace, env },
      ),
    ]);
    assert.deepEqual(
      raced.map((result) => result.status).sort(),
      [0, 1],
      raced.map((result) => result.stderr || result.stdout).join("\n"),
    );
    const rejectedRace = raced.find((result) => result.status === 1);
    assert.match(rejectedRace.stderr, /ProjectAlreadyExists/);
    assert.equal(
      readFileSync(join(racedProjectRoot, "src", "index.ts"), "utf8"),
      "console.log('native package-free');\n",
    );
    assert.ok(existsSync(join(racedProjectRoot, ".hutch", "devkit", "projection.json")));
    assert.ok(existsSync(join(workspace, `.${racedProjectName}.hutch-template.lock`)));
    assert.deepEqual(
      readdirSync(workspace).filter((name) => name.startsWith(`.${racedProjectName}.hutch-template-tmp-`)),
      [],
    );
    assert.equal(requestCounts.channel, 2, "each contending init must fetch the current catalog");
    assert.equal(requestCounts.nativeArchive, 1, "contending cold init must download one template archive");
    assert.equal(existsSync(join(dashHome, "cache")), false, "template metadata and archives must not persist");

    const listed = await run(hutch, ["electrobun", "init"], { cwd: workspace, env });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.match(listed.stdout, /Electrobun 2\.0\.0 templates \(stable\):/);
    assert.match(listed.stdout, /hello-world - A remote starter/);
    assert.match(listed.stdout, /native-basic - A package-free starter/);
    assert.equal(requestCounts.channel, 3, "listing templates must fetch the current catalog");

    const result = await run(
      hutch,
      ["electrobun", "init", projectName, "--template=hello-world"],
      { cwd: workspace, env },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      "Downloading hello-world from Electrobun 2.0.0 (stable)...\n" +
        "Preparing the Electrobun devkit and required toolchain...\n" +
        "Running hutch.config.ts install task if configured...\n" +
        `Created Electrobun project at ${projectRoot}\n` +
        "Next steps:\n" +
        `  cd ${projectName}\n` +
        "  hutch run dev\n",
    );
    assert.equal(existsSync(join(projectRoot, "package.json")), false);
    assert.equal(
      readFileSync(join(projectRoot, "src", "index.ts"), "utf8"),
      'console.log("hello");\n',
    );
    assert.doesNotMatch(readFileSync(join(projectRoot, "electrobun.config.ts"), "utf8"), /electrobun:/);
    assert.match(readFileSync(join(projectRoot, "hutch.config.ts"), "utf8"), /electrobun: \{ version: "2\.0\.0" \}/);
    assert.match(
      readFileSync(join(projectRoot, "hutch.config.ts"), "utf8"),
      new RegExp(`^// @hutch cli=${requiredHutchVersion.replaceAll(".", "\\.")} cottontail=${requiredCottontailVersion.replaceAll(".", "\\.")}\\n`),
    );
    assert.ok(existsSync(join(projectRoot, ".hutch", "devkit", "projection.json")));
    assert.equal(readFileSync(join(projectRoot, ".configured-install-ran"), "utf8"), projectRoot);
    assert.equal(requestCounts.channel, 4);
    assert.equal(requestCounts.helloArchive, 1);

    const nativeProjectName = "native-app";
    const nativeProjectRoot = join(realpathSync(workspace), nativeProjectName);
    const nativeResult = await run(
      hutch,
      ["electrobun", "init", nativeProjectName, "--template=native-basic"],
      { cwd: workspace, env },
    );
    assert.equal(nativeResult.status, 0, nativeResult.stderr || nativeResult.stdout);
    assert.equal(nativeResult.stderr, "");
    assert.match(nativeResult.stdout, /Preparing the Electrobun devkit and required toolchain/);
    assert.match(nativeResult.stdout, /Running hutch\.config\.ts install task if configured/);
    assert.ok(existsSync(join(nativeProjectRoot, "src", "index.ts")));
    assert.equal(existsSync(join(nativeProjectRoot, "package.json")), false);
    assert.equal(existsSync(join(nativeProjectRoot, ".configured-install-ran")), false);
    assert.ok(existsSync(join(nativeProjectRoot, ".hutch", "devkit", "projection.json")));
    assert.equal(requestCounts.channel, 5);
    assert.equal(requestCounts.nativeArchive, 2, "template archives must be fetched again for a new init");

    const skipped = await run(
      hutch,
      ["electrobun", "init", "skipped-app", "--template=hello-world", "--skip-install"],
      { cwd: workspace, env },
    );
    assert.equal(skipped.status, 0, skipped.stderr || skipped.stdout);
    assert.match(skipped.stdout, /Skipped configured install task \(--skip-install\)\./);
    assert.match(skipped.stdout, /hutch run --if-configured install/);
    assert.equal(existsSync(join(workspace, "skipped-app", ".configured-install-ran")), false);
    assert.ok(existsSync(join(workspace, "skipped-app", ".hutch", "devkit", "projection.json")));
    assert.equal(requestCounts.channel, 6);
    assert.equal(requestCounts.helloArchive, 2, "template archives must be discarded after extraction");

    requiredHutchVersion = nextPatchVersion(currentHutchVersion);
    const archivesBeforeHutchMismatch = {
      hello: requestCounts.helloArchive,
      native: requestCounts.nativeArchive,
    };
    const newerHutchRequired = await run(
      hutch,
      ["electrobun", "init", "needs-newer-hutch", "--template=hello-world", "--skip-install"],
      { cwd: workspace, env },
    );
    assert.equal(newerHutchRequired.status, 1);
    assert.match(
      newerHutchRequired.stderr,
      new RegExp(`could not prepare Hutch ${requiredHutchVersion.replaceAll(".", "\\.")}`),
    );
    assert.match(newerHutchRequired.stderr, /required by the stable templates: ReleaseDownloadFailed/);
    assert.doesNotMatch(newerHutchRequired.stderr, /TemplateRequiresNewerHutch/);
    assert.equal(existsSync(join(workspace, "needs-newer-hutch")), false);
    assert.deepEqual(
      {
        hello: requestCounts.helloArchive,
        native: requestCounts.nativeArchive,
      },
      archivesBeforeHutchMismatch,
      "an incompatible catalog must fail before downloading a template archive",
    );
    requiredHutchVersion = currentHutchVersion;

    requiredCottontailVersion = nextPatchVersion(pairedCottontailVersion);
    const archivesBeforeCottontailMismatch = {
      hello: requestCounts.helloArchive,
      native: requestCounts.nativeArchive,
    };
    const manifestsBeforeCottontailMismatch = requestCounts.releaseManifest;
    const incompatibleCottontail = await run(
      hutch,
      ["electrobun", "init", "needs-cottontail", "--template=hello-world", "--skip-install"],
      { cwd: workspace, env },
    );
    assert.equal(incompatibleCottontail.status, 1);
    assert.match(
      incompatibleCottontail.stderr,
      new RegExp(`requires exactly Cottontail ${requiredCottontailVersion.replaceAll(".", "\\.")}`),
    );
    assert.match(incompatibleCottontail.stderr, /try `hutch upgrade`/);
    assert.doesNotMatch(incompatibleCottontail.stderr, /IncompatibleTemplateCottontail/);
    assert.equal(existsSync(join(workspace, "needs-cottontail")), false);
    assert.equal(requestCounts.releaseManifest, manifestsBeforeCottontailMismatch,
      "a mismatched catalog naming the current Hutch cannot be repaired by handoff");
    assert.deepEqual(
      {
        hello: requestCounts.helloArchive,
        native: requestCounts.nativeArchive,
      },
      archivesBeforeCottontailMismatch,
      "a Cottontail mismatch must fail before downloading a template archive",
    );
    requiredCottontailVersion = pairedCottontailVersion;

    await t.test("a newer compatible Hutch keeps using its current engine", async () => {
      requiredHutchVersion = "0.0.1";
      const before = requestCounts.releaseManifest;
      const result = await run(hutch, ["electrobun", "init"], { cwd: workspace, env });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Electrobun 2\.0\.0 templates \(stable\)/);
      assert.doesNotMatch(result.stdout, /Using Hutch/);
      assert.equal(requestCounts.releaseManifest, before);
    });

    const handoffReport = join(fixture, "handoff-report.json");
    // Node is a portable stand-in for a selected release executable:
    // its first argument is the file `electrobun`, followed by the untouched
    // init arguments. The real engine is used separately for the loop check.
    writeFileSync(join(workspace, "electrobun"), `
const fs = require("node:fs");
fs.writeFileSync(process.env.HUTCH_HANDOFF_TEST_REPORT, JSON.stringify({
  args: process.argv.slice(2),
  cwd: fs.realpathSync(process.cwd()),
  input: fs.readFileSync(0, "utf8"),
  marker: process.env.HUTCH_ELECTROBUN_INIT_HANDOFF,
  launcher: process.env.HUTCH_LAUNCHER_PATH,
  launcherVersion: process.env.HUTCH_LAUNCHER_VERSION,
  defaultCLI: process.env.HUTCH_DEFAULT_CLI,
  defaultElectrobun: process.env.HUTCH_DEFAULT_ELECTROBUN,
  cottontailSelector: process.env.DASH_COTTONTAIL_SELECTOR,
  engineOverride: process.env.HUTCH_ENGINE_BINARY ?? null,
  localCottontail: process.env.COTTONTAIL_BINARY,
  activeChannel: process.env.HUTCH_ACTIVE_CHANNEL,
}));
console.log("selected engine stdout");
console.error("selected engine stderr");
process.exit(Number(process.env.HUTCH_HANDOFF_TEST_EXIT || 0));
`);
    writeFileSync(join(workspace, "hutch.config.ts"),
      `// @hutch cli=${currentHutchVersion} cottontail=${pairedCottontailVersion}\nexport default {};\n`);

    for (const { version: selectedVersion, flags } of [
      { version: "0.0.1", flags: [] },
      { version: "0.0.2-canary.1", flags: ["--beta"] },
    ]) {
      await t.test(`init hands off to the exact ${flags.length ? "beta" : "stable"} catalog pair`, async () => {
        requiredHutchVersion = selectedVersion;
        requiredCottontailVersion = nextPatchVersion(pairedCottontailVersion);
        const selected = cacheHutchFixture(dashHome, {
          version: selectedVersion,
          engine: process.execPath,
          launcher: hutch,
        });
        const selectionsPath = join(dashHome, "state", "selections.json");
        const selectionsBefore = existsSync(selectionsPath) ? readFileSync(selectionsPath, "utf8") : null;
        const countsBefore = { ...requestCounts };
        const args = ["init", "delegated app", "--template=hello-world", "--skip-install", ...flags];
        const result = await run(hutch, ["electrobun", ...args], {
          cwd: workspace,
          input: "picker input\n",
          env: {
            ...env,
            HUTCH_DEFAULT_CLI: "99.98.97",
            HUTCH_DEFAULT_ELECTROBUN: "99.98.95",
            DASH_COTTONTAIL_SELECTOR: "99.98.96",
            HUTCH_HANDOFF_TEST_REPORT: handoffReport,
          },
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /selected engine stdout/);
        assert.match(result.stderr, /selected engine stderr/);
        assert.deepEqual(JSON.parse(readFileSync(handoffReport, "utf8")), {
          args,
          cwd: realpathSync(workspace),
          input: "picker input\n",
          marker: selectedVersion,
          launcher: selected.launcher,
          launcherVersion: selectedVersion,
          defaultCLI: selectedVersion,
          defaultElectrobun: "99.98.95",
          cottontailSelector: requiredCottontailVersion,
          engineOverride: null,
          localCottontail: cottontail,
          activeChannel: "production",
        });
        assert.equal(existsSync(selectionsPath) ? readFileSync(selectionsPath, "utf8") : null, selectionsBefore,
          "an exact init handoff must not activate a different global release");
        assert.equal(requestCounts.releaseManifest, countsBefore.releaseManifest,
          "a cached exact release should not require a network release lookup");
        assert.equal(requestCounts.helloArchive, countsBefore.helloArchive,
          "the parent must hand off before installing a template");

        const failed = await run(hutch, ["electrobun", ...args], {
          cwd: workspace,
          env: { ...env, HUTCH_HANDOFF_TEST_REPORT: handoffReport, HUTCH_HANDOFF_TEST_EXIT: "37" },
        });
        assert.equal(failed.status, 37, "the selected engine's failure status must reach the caller");
      });
    }

    await t.test("the selected engine revalidates compatibility and cannot recurse", async () => {
      requiredHutchVersion = "0.0.3";
      requiredCottontailVersion = nextPatchVersion(pairedCottontailVersion);
      cacheHutchFixture(dashHome, { version: requiredHutchVersion, engine, launcher: hutch });
      const before = { ...requestCounts };
      const result = await run(hutch, ["electrobun", "init", "loop-app", "--template=hello-world"], {
        cwd: workspace,
        env,
      });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /requires exactly Cottontail/);
      assert.equal(requestCounts.channel, before.channel + 2,
        "both parent and selected engine validate the catalog exactly once");
      assert.equal(requestCounts.helloArchive, before.helloArchive);
      assert.equal(requestCounts.releaseManifest, before.releaseManifest);
      assert.equal(existsSync(join(workspace, "loop-app")), false);
    });

    await t.test("handoff rejects a downloaded release with the wrong checksum", async () => {
      requiredHutchVersion = corruptReleaseVersion;
      requiredCottontailVersion = pairedCottontailVersion;
      const before = { ...requestCounts };
      const result = await run(hutch, ["electrobun", "init", "corrupt-app", "--template=hello-world"], {
        cwd: workspace,
        env,
      });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /ReleaseArchiveChecksumMismatch/);
      assert.equal(requestCounts.releaseManifest, before.releaseManifest + 1);
      assert.equal(requestCounts.releaseArchive, before.releaseArchive + 1);
      assert.equal(requestCounts.helloArchive, before.helloArchive);
      assert.equal(existsSync(join(workspace, "corrupt-app")), false);
    });
    requiredHutchVersion = currentHutchVersion;
    requiredCottontailVersion = pairedCottontailVersion;

    const requestsBeforeEnvironmentOffline = { ...requestCounts };
    const environmentOffline = await run(
      hutch,
      [
        "electrobun",
        "init",
        "environment-offline-app",
        "--template=hello-world",
      ],
      { cwd: workspace, env: { ...env, DASH_RELEASE_OFFLINE: "1" } },
    );
    assert.notEqual(environmentOffline.status, 0);
    assert.match(environmentOffline.stderr, /template initialization requires network access/);
    assert.equal(existsSync(join(workspace, "environment-offline-app")), false);
    assert.deepEqual(
      requestCounts,
      requestsBeforeEnvironmentOffline,
      "offline init must fail before performing HTTP",
    );

    const requestsBeforeCliOffline = { ...requestCounts };
    const cliOffline = await run(
      hutch,
      [
        "electrobun",
        "init",
        "cli-offline-app",
        "--template=hello-world",
        "--offline",
      ],
      { cwd: workspace, env },
    );
    assert.notEqual(cliOffline.status, 0);
    assert.match(cliOffline.stderr, /template initialization requires network access/);
    assert.equal(existsSync(join(workspace, "cli-offline-app")), false);
    assert.deepEqual(
      requestCounts,
      requestsBeforeCliOffline,
      "the removed --offline option must fail before performing HTTP",
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(fixture, { recursive: true, force: true });
  }
});
