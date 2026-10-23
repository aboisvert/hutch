import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';
const suffix = process.platform === 'win32' ? '.exe' : '';
const engine = resolve('zig-out/bin/hutch-engine' + suffix);
const launcher = resolve('zig-out/bin/hutch' + suffix);
const cottontailVersion = readFileSync('src/version.zig', 'utf8').match(/paired_cottontail_version = "([^"]+)"/)[1];
test('default Bun scripts, shell arguments, tests, exit status and explicit Cottontail', () => {
 const root = mkdtempSync(join(tmpdir(), 'hutch-bun-runner-'));
 const env = { ...process.env, HUTCH_ENGINE_BINARY: engine, HUTCH_LAUNCHER_PATH: launcher };
 for (const key of ['HUTCH_RUNTIME', 'COTTONTAIL_BINARY', 'DASH_COTTONTAIL', 'DASH_USE_LOCAL_COTTONTAIL']) delete env[key];
 const run = (args, extra = {}) => spawnSync(engine, args, { cwd: root, env: {...env, ...extra}, encoding: 'utf8', timeout: 30000 });
 try {
  writeFileSync(join(root, 'identity.ts'), 'console.log(JSON.stringify({bun:process.versions.bun,cottontail:process.versions.cottontail,args:process.argv.slice(2)}));');
  writeFileSync(join(root, 'hutch.config.ts'), `// @hutch cottontail=${cottontailVersion}
export default { scripts: { identity: 'hutch identity.ts', argv: ['hutch', 'identity.ts'], fail: 'exit 23', input: 'cat' } };`);
  for (const args of [['identity.ts'], ['run','identity.ts'], ['identity'], ['run','identity'], ['argv']]) {
   const result = run([...args, 'a b', '$(not-executed)', '"quoted"']);
   assert.equal(result.status, 0, result.stderr);
   const value = JSON.parse(result.stdout.trim());
   assert.equal(typeof value.bun, 'string');
   assert.equal(value.cottontail, undefined);
   assert.deepEqual(value.args, ['a b', '$(not-executed)', '"quoted"']);
  }
  assert.equal(run(['fail']).status, 23);
  const input = spawnSync(engine, ['input'], {cwd:root,env,encoding:'utf8',input:'stdin survives\n',timeout:30000});
  assert.equal(input.status, 0, input.stderr);
  assert.equal(input.stdout, 'stdin survives\n');
  writeFileSync(join(root, 'runtime.test.ts'), `import {test,expect} from 'bun:test'; test('real Bun',()=>expect(process.versions.cottontail).toBeUndefined());`);
  assert.equal(run(['test','runtime.test.ts']).status, 0);
  const experimental = run(['identity.ts'], {HUTCH_RUNTIME:'cottontail'});
  assert.equal(experimental.status, 0, experimental.stderr);
  assert.equal(typeof JSON.parse(experimental.stdout.trim()).cottontail, 'string');
 } finally { rmSync(root, {recursive:true,force:true}); }
});

test('matching PATH Bun and managed fallback preserve runtime process semantics', {timeout: 300_000}, () => {
 const root = mkdtempSync(join(tmpdir(), 'hutch-bun-path-'));
 const defaultBunVersion = readFileSync('src/toolchain_store.zig', 'utf8').match(/default_bun_version = "([^"]+)"/)?.[1];
 assert.ok(defaultBunVersion, 'Hutch must declare its default Bun version');
 const platform = {
  'darwin-arm64': 'macos-arm64', 'darwin-x64': 'macos-x64',
  'linux-arm64': 'linux-arm64', 'linux-x64': 'linux-x64',
  'win32-arm64': 'windows-arm64', 'win32-x64': 'windows-x64',
 }[`${process.platform}-${process.arch}`];
 assert.ok(platform, 'the fixture needs the managed toolchain platform');
 const managedHome = join(root, 'managed-home');
 const matchingHome = join(root, 'matching-home');
 const mismatchBin = join(root, 'mismatched bin');
 const matchingBin = join(root, 'matching bin with spaces');
 const managedBun = join(managedHome, 'toolchains', 'bun', defaultBunVersion, platform, 'bun' + suffix);
 const matchingBun = join(matchingBin, 'bun' + suffix);
 const input = 'stdin survives runtime replacement\n';
 const inherited = 'inherited file descriptor survives runtime replacement\n';
 const args = ['a b', '$(not-executed)', '"quoted"', '', '工作-🚀'];
 const environment = {...process.env, HUTCH_HOME: managedHome, HUTCH_ENGINE_BINARY: engine, HUTCH_LAUNCHER_PATH: launcher, HUTCH_RUNTIME: 'bun', HUTCH_NO_UPDATE_CHECK: '1', HUTCH_PATH_TEST_VALUE: 'inherited value'};
 for (const key of ['COTTONTAIL_BINARY', 'DASH_COTTONTAIL', 'DASH_USE_LOCAL_COTTONTAIL', 'DASH_RELEASE_OFFLINE']) delete environment[key];
 const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') ?? 'PATH';
 const originalPath = environment[pathKey] ?? '';
 const withPath = directory => [join(root, 'missing-bin'), directory, originalPath].join(delimiter);
 const script = `#!/usr/bin/env bun
const {readFileSync} = require('node:fs');
console.log(JSON.stringify({bun:process.versions.bun,exe:process.execPath,pid:process.pid,args:process.argv.slice(2),value:process.env.HUTCH_PATH_TEST_VALUE,input:readFileSync(0,'utf8'),inherited:process.platform==='win32'?null:readFileSync(3,'utf8')}));
console.error('stderr survives runtime replacement');
process.exitCode=37;
`;
 const check = (binary, entrypoint, env, expectedBun, bootstrap = false) => {
  const descriptor = process.platform === 'win32' ? null : openSync(join(root, 'inherited.txt'), 'r');
  let result;
  try {
   result = spawnSync(binary, [entrypoint, ...args], {
    cwd:root,env,encoding:'utf8',input,timeout:180_000,
    stdio:descriptor === null ? undefined : ['pipe','pipe','pipe',descriptor],
   });
  } finally { if (descriptor !== null) closeSync(descriptor); }
  assert.ifError(result.error);
  assert.equal(result.status, 37, `${entrypoint}: ${result.stderr || result.stdout}`);
  const value = JSON.parse(result.stdout.trim());
  assert.equal(value.bun, defaultBunVersion);
  // Windows temp paths can use an 8.3 alias while Bun reports the long name.
  // Native realpath asks the OS to canonicalize both spellings of the file.
  assert.equal(realpathSync.native(value.exe), realpathSync.native(expectedBun));
  if (process.platform !== 'win32') assert.equal(value.pid, result.pid, 'POSIX runtime dispatch must replace the current process');
  assert.deepEqual(value.args, args);
  assert.equal(value.value, 'inherited value');
  assert.equal(value.input, input);
  if (descriptor !== null) assert.equal(value.inherited, inherited);
  if (bootstrap) assert.ok(result.stderr.endsWith('stderr survives runtime replacement\n'), result.stderr);
  else assert.equal(result.stderr, 'stderr survives runtime replacement\n');
 };
 try {
  mkdirSync(mismatchBin);
  mkdirSync(matchingBin);
  writeFileSync(join(root, 'inherited.txt'), inherited);
  // A real executable with a deliberately different version forces managed
  // resolution on every host, including Windows where shell stubs differ.
  copyFileSync(process.execPath, join(mismatchBin, 'bun' + suffix));
  chmodSync(join(mismatchBin, 'bun' + suffix), 0o755);
  for (const entrypoint of ['identity.js', 'identity-without-extension']) {
   writeFileSync(join(root, entrypoint), script, {mode:0o644});
  }
  const fallback = {...environment, [pathKey]:withPath(mismatchBin)};
  // Bootstrap with the real native engine. On CI this acquires the exact
  // managed Bun; all subsequent assertions run offline.
  check(engine, 'identity.js', fallback, managedBun, true);
  copyFileSync(managedBun, matchingBun);
  chmodSync(matchingBun, 0o755);
  const matching = {...environment, HUTCH_HOME:matchingHome, DASH_RELEASE_OFFLINE:'1', [pathKey]:withPath(matchingBin)};
  const cached = {...fallback, DASH_RELEASE_OFFLINE:'1'};
  for (const binary of [engine, launcher]) {
   for (const entrypoint of ['identity.js', './identity-without-extension']) {
    check(binary, entrypoint, matching, matchingBun);
    check(binary, entrypoint, cached, managedBun);
   }
  }
  assert.equal(existsSync(join(matchingHome, 'toolchains', 'bun')), false, 'a matching PATH Bun must run without a managed install');
 } finally { rmSync(root, {recursive:true,force:true}); }
});
