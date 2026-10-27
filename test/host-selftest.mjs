/**
 * test/host-selftest.mjs —— Host 半边端到端自检（`node test/host-selftest.mjs`）。
 *
 * 不依赖 cordis、不联网：用一个假的 ctx 收集 `apply()` 注册的路由，直接调用路由的 fetch，
 * 并在 os.tmpdir() 下现建「bare 远程 + clone 工作区」的临时 git 仓库，覆盖
 * docs/route-contract.md 里 7 条路由的语义与全部边界（非仓库、空仓库、基准回退、
 * 改回一致、未跟踪、删除、改名、二进制、CRLF/BOM、冲突、超限、越界路径、git 缺失等）。
 *
 * 结束打印 PASS/FAIL 汇总；有失败时进程退出码非 0。临时目录在 finally 里清掉。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { apply, createRouter, createRuntime, inject, name } from '../index.js';

const execFileAsync = promisify(execFile);
const API = '/api/edit-files';

let passed = 0;
const failed = [];

async function test(title, run) {
  try {
    await run();
    passed += 1;
    console.log(`PASS  ${title}`);
  } catch (error) {
    failed.push({ title, error });
    console.error(`FAIL  ${title}`);
    const detail = String(error?.stack ?? error).split('\n').slice(0, 8).map((line) => `      ${line}`).join('\n');
    console.error(detail);
  }
}

async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 20000,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  return stdout.trim();
}

function collectRoutes(config) {
  const registered = [];
  const inspectProviders = [];
  const ctx = {
    connection: { fetch: { register: (route) => registered.push(route) } },
    effect(run) {
      const dispose = run();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    // Host 半边会尝试挂 cordis_inspect 自检入口；自检里给一个最小 registry，
    // 既验证参数形状，也保证看不到 cordisInspect 的组合照常工作。
    inject(deps, callback) {
      assert.deepEqual(deps, ['cordisInspect']);
      return callback({
        cordisInspect: {
          register(provider) {
            inspectProviders.push(provider);
            return () => {};
          },
        },
      });
    },
  };
  apply(ctx, config);
  collectRoutes.inspectProviders = inspectProviders;
  return registered;
}

function makeCaller(routes) {
  const byPath = new Map(routes.map((route) => [route.path, route]));
  return async function call(method, routePath, options = {}) {
    const url = new URL(`http://localhost${routePath}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    const init = { method, headers: {} };
    if (options.rawBody !== undefined) {
      init.body = options.rawBody;
      init.headers['content-type'] = 'application/json';
    } else if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
      init.headers['content-type'] = 'application/json';
    }
    const route = byPath.get(routePath);
    assert.ok(route, `路由未注册：${routePath}`);
    assert.ok(route.methods.includes(method), `路由 ${routePath} 不接收 ${method}`);
    const response = await route.fetch(new Request(url, init));
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, headers: response.headers, data };
  };
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-edit-files-selftest-'));
  const remoteDir = path.join(tmpRoot, 'remote.git');
  const repoDir = path.join(tmpRoot, 'repo');
  const notRepoDir = path.join(tmpRoot, 'not-a-repo');
  const outsideTxt = path.join(tmpRoot, 'outside.txt');
  const aTxt = path.join(repoDir, 'a.txt');
  const keepTxt = path.join(repoDir, 'keep.txt');
  const deepTxt = path.join(repoDir, 'nested', 'deep.txt');
  const blobBin = path.join(repoDir, 'blob.bin');

  let realRepo = repoDir;

  try {
    // ── 临时仓库：bare 远程 + clone 工作区，本地配好 user 才能 commit ──
    await git(['init', '-q', '--bare', remoteDir], tmpRoot);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remoteDir);
    await git(['clone', '-q', remoteDir, repoDir], tmpRoot);
    await git(['config', 'user.name', 'DSH Edit Files Self Test'], repoDir);
    await git(['config', 'user.email', 'selftest@example.invalid'], repoDir);
    realRepo = await fs.realpath(repoDir);

    await fs.writeFile(aTxt, 'alpha\nbeta\ngamma\n');
    await fs.writeFile(keepTxt, 'keep\n');
    await fs.mkdir(path.join(repoDir, 'nested'));
    await fs.writeFile(deepTxt, 'deep-1\ndeep-2\n');
    await fs.writeFile(blobBin, Buffer.from([0, 1, 2, 3, 10]));
    await fs.writeFile(outsideTxt, 'outside\n');
    await fs.mkdir(notRepoDir);
    await git(['add', '-A'], repoDir);
    await git(['commit', '-q', '-m', 'init'], repoDir);
    await git(['push', '-q', '-u', 'origin', 'main'], repoDir);
    await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repoDir);

    const routes = collectRoutes({});
    const call = makeCaller(routes);
    const tinyRoutes = collectRoutes({ maxFileBytes: 32, maxDiffLines: 3, maxChangedFiles: 1 });
    const callTiny = makeCaller(tinyRoutes);
    const fallbackRoutes = collectRoutes({ maxFileBytes: 0, maxDiffLines: 'oops', maxChangedFiles: -1 });
    const callFallback = makeCaller(fallbackRoutes);

    // ── 1. 装配 / health ──
    await test('index.js 导出 name / inject 与内部工厂符合 cordis 约定', async () => {
      assert.equal(name, 'edit-files');
      assert.deepEqual(inject, ['connection']);
      assert.equal(typeof createRouter, 'function');
      assert.equal(typeof createRuntime, 'function');
      assert.deepEqual(createRuntime({ maxFileBytes: 10 }).limits, { maxFileBytes: 10, maxDiffLines: 4000, maxChangedFiles: 3000 });
    });

    await test('apply 注册 7 条路由，全部 requestBody=buffered 且各自单独注册', async () => {
      assert.equal(routes.length, 7);
      assert.equal(new Set(routes.map((route) => route.path)).size, 7);
      for (const route of routes) {
        assert.equal(route.requestBody, 'buffered');
        assert.ok(Array.isArray(route.methods) && route.methods.length > 0);
        assert.equal(typeof route.fetch, 'function');
      }
      const methods = Object.fromEntries(routes.map((route) => [route.path, route.methods]));
      assert.deepEqual(methods[`${API}/health`], ['GET']);
      assert.deepEqual(methods[`${API}/git/info`], ['GET']);
      assert.deepEqual(methods[`${API}/git/changes`], ['GET']);
      assert.deepEqual(methods[`${API}/git/diff`], ['GET']);
      assert.deepEqual(methods[`${API}/git/file`], ['GET']);
      assert.deepEqual(methods[`${API}/file/read`], ['POST']);
      assert.deepEqual(methods[`${API}/file/write`], ['POST']);
    });

    await test('apply 单条路由注册失败不会抛异常', async () => {
      const ctx = {
        connection: { fetch: { register() { throw new Error('boom'); } } },
        effect(run) {
          const dispose = run();
          return () => {
            if (typeof dispose === 'function') dispose();
          };
        },
        inject(_deps, callback) {
          return callback({ cordisInspect: { register: () => () => {} } });
        },
      };
      assert.doesNotThrow(() => apply(ctx, {}));
    });

    await test('GET /health：返回插件名、版本、7 条路由与默认 limits', async () => {
      const { status, headers, data } = await call('GET', `${API}/health`);
      assert.equal(status, 200);
      assert.match(headers.get('content-type') ?? '', /^application\/json/);
      assert.equal(headers.get('cache-control'), 'no-store');
      assert.equal(data.ok, true);
      assert.equal(data.name, 'dsh-plugin-edit-files');
      assert.equal(data.version, '0.1.0');
      assert.deepEqual(data.routes, [
        `${API}/health`,
        `${API}/git/info`,
        `${API}/git/changes`,
        `${API}/git/diff`,
        `${API}/git/file`,
        `${API}/file/read`,
        `${API}/file/write`,
      ]);
      assert.deepEqual(data.limits, { maxFileBytes: 2097152, maxDiffLines: 4000, maxChangedFiles: 3000 });
    });

    await test('配置坏值回退默认；自定义 limits 生效', async () => {
      const fallback = await callFallback('GET', `${API}/health`);
      assert.deepEqual(fallback.data.limits, { maxFileBytes: 2097152, maxDiffLines: 4000, maxChangedFiles: 3000 });
      const tiny = await callTiny('GET', `${API}/health`);
      assert.deepEqual(tiny.data.limits, { maxFileBytes: 32, maxDiffLines: 3, maxChangedFiles: 1 });
    });

    // ── 2. 非仓库 ──
    await test('git/info：非仓库返回 isRepo:false（200，原样回 path）', async () => {
      const { status, data } = await call('GET', `${API}/git/info`, { query: { path: notRepoDir } });
      assert.equal(status, 200);
      assert.deepEqual(data, { ok: true, isRepo: false, path: notRepoDir });
    });

    await test('git/changes：非仓库返回 {ok:true,isRepo:false}', async () => {
      const { status, data } = await call('GET', `${API}/git/changes`, { query: { path: notRepoDir } });
      assert.equal(status, 200);
      assert.deepEqual(data, { ok: true, isRepo: false });
    });

    await test('git/file：非仓库返回 isRepo:false + file:null', async () => {
      const { status, data } = await call('GET', `${API}/git/file`, { query: { path: path.join(notRepoDir, 'x.txt') } });
      assert.equal(status, 200);
      assert.deepEqual(data, { ok: true, isRepo: false, file: null });
    });

    await test('git/diff：非仓库返回 400 not-a-repo', async () => {
      const { status, data } = await call('GET', `${API}/git/diff`, { query: { path: notRepoDir, file: 'x.txt' } });
      assert.equal(status, 400);
      assert.deepEqual(data, { ok: false, reason: 'not-a-repo' });
    });

    // ── 3. 仓库信息 ──
    await test('git/info：目录路径返回 branch/base/upstream/ahead/behind/remote', async () => {
      const { status, data } = await call('GET', `${API}/git/info`, { query: { path: repoDir } });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.isRepo, true);
      assert.equal(data.path, repoDir);
      assert.equal(data.root, realRepo);
      assert.equal(data.branch, 'main');
      assert.equal(data.detached, false);
      assert.equal(data.upstream, 'origin/main');
      assert.equal(data.hasUpstream, true);
      assert.equal(data.base, 'origin/main');
      assert.equal(data.baseKind, 'upstream');
      assert.equal(data.remoteName, 'origin');
      assert.ok(String(data.remoteUrl).endsWith('remote.git'));
      assert.match(String(data.head), /^[0-9a-f]{7,}$/);
      assert.equal(data.ahead, 0);
      assert.equal(data.behind, 0);
      assert.match(String(data.gitVersion), /^\d+\.\d+/);
    });

    await test('git/info：文件路径取 dirname 当起点', async () => {
      const { status, data } = await call('GET', `${API}/git/info`, { query: { path: aTxt } });
      assert.equal(status, 200);
      assert.equal(data.isRepo, true);
      assert.equal(data.root, realRepo);
      assert.equal(data.path, aTxt);
    });

    await test('git/info：路径不存在 → 404 not-found；缺 path → 400 missing-path', async () => {
      const missing = await call('GET', `${API}/git/info`, { query: { path: path.join(realRepo, 'no-such-file.txt') } });
      assert.equal(missing.status, 404);
      assert.deepEqual(missing.data, { ok: false, reason: 'not-found' });
      const noParam = await call('GET', `${API}/git/info`);
      assert.equal(noParam.status, 400);
      assert.equal(noParam.data.reason, 'missing-path');
    });

    // ── 4. 干净仓库：与远程一致的文件不出现 ──
    await test('git/changes：干净仓库 files 为空，totals 归零', async () => {
      const { status, data } = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.isRepo, true);
      assert.equal(data.root, realRepo);
      assert.equal(data.branch, 'main');
      assert.equal(data.base, 'origin/main');
      assert.equal(data.baseKind, 'upstream');
      assert.equal(data.upstream, 'origin/main');
      assert.ok(String(data.remoteUrl).endsWith('remote.git'));
      assert.equal(data.ahead, 0);
      assert.equal(data.behind, 0);
      assert.deepEqual(data.files, []);
      assert.deepEqual(data.totals, { files: 0, additions: 0, deletions: 0, untracked: 0 });
      assert.equal(data.truncated, false);
    });

    // ── 5. 修改 → 列出；改回 → 消失 ──
    await test('修改文件：changes 列出 M 且 additions/deletions 正确', async () => {
      await fs.writeFile(aTxt, 'alpha\nbeta\ngamma\ndelta\n');
      const { data } = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.deepEqual(data.files, [
        { path: 'a.txt', oldPath: null, status: 'M', additions: 1, deletions: 0, binary: false, untracked: false, staged: false },
      ]);
      assert.deepEqual(data.totals, { files: 1, additions: 1, deletions: 0, untracked: 0 });
    });

    await test('git/file：单独判断文件 changed=true', async () => {
      const { status, data } = await call('GET', `${API}/git/file`, { query: { path: aTxt } });
      assert.equal(status, 200);
      assert.equal(data.isRepo, true);
      assert.equal(data.root, realRepo);
      assert.equal(data.branch, 'main');
      assert.equal(data.base, 'origin/main');
      assert.equal(data.baseKind, 'upstream');
      assert.equal(data.file.path, 'a.txt');
      assert.equal(data.file.status, 'M');
      assert.equal(data.file.additions, 1);
      assert.equal(data.file.deletions, 0);
      assert.equal(data.file.binary, false);
      assert.equal(data.file.untracked, false);
      assert.equal(data.file.changed, true);
    });

    await test('git/diff：返回 unified diff 与行数，newText=null', async () => {
      const { status, data } = await call('GET', `${API}/git/diff`, { query: { path: repoDir, file: 'a.txt' } });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.file, 'a.txt');
      assert.equal(data.status, 'M');
      assert.equal(data.untracked, false);
      assert.equal(data.binary, false);
      assert.equal(data.truncated, false);
      assert.equal(data.additions, 1);
      assert.equal(data.deletions, 0);
      assert.equal(data.newText, null);
      assert.match(data.diff, /@@ /);
      assert.match(data.diff, /^\+delta$/m);
      assert.match(data.diff, /--- a\/a\.txt/);
      assert.match(data.diff, /\+\+\+ b\/a\.txt/);
    });

    await test('改回与远程一致：文件从 changes 列表消失（核心语义）', async () => {
      await fs.writeFile(aTxt, 'alpha\nbeta\ngamma\n');
      const { data } = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.deepEqual(data.files, []);
      const single = await call('GET', `${API}/git/file`, { query: { path: aTxt } });
      assert.equal(single.status, 200);
      assert.equal(single.data.file, null);
    });

    // ── 6. 本地已提交但未推的改动也算 ──
    await test('本地提交未推：ahead 计数 + changes 仍列出', async () => {
      await fs.writeFile(aTxt, 'alpha\nbeta\ngamma\nlocal\n');
      await git(['commit', '-q', '-am', 'local unpushed change'], repoDir);
      const info = await call('GET', `${API}/git/info`, { query: { path: repoDir } });
      assert.equal(info.data.ahead, 1);
      assert.equal(info.data.behind, 0);
      const { data } = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.deepEqual(data.files, [
        { path: 'a.txt', oldPath: null, status: 'M', additions: 1, deletions: 0, binary: false, untracked: false, staged: false },
      ]);
      await git(['reset', '-q', '--hard', 'origin/main'], repoDir);
    });

    // ── 7. 未跟踪新增 ──
    await test('未跟踪文件：status=A、untracked=true，diff 回 newText', async () => {
      const newTxt = path.join(repoDir, 'new.txt');
      await fs.writeFile(newTxt, 'brand new\n');
      const { data } = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.deepEqual(data.files, [
        { path: 'new.txt', oldPath: null, status: 'A', additions: 0, deletions: 0, binary: false, untracked: true, staged: false },
      ]);
      assert.deepEqual(data.totals, { files: 1, additions: 0, deletions: 0, untracked: 1 });

      const diff = await call('GET', `${API}/git/diff`, { query: { path: repoDir, file: 'new.txt' } });
      assert.equal(diff.status, 200);
      assert.equal(diff.data.status, 'A');
      assert.equal(diff.data.untracked, true);
      assert.equal(diff.data.binary, false);
      assert.equal(diff.data.diff, '');
      assert.equal(diff.data.newText, 'brand new\n');
      assert.equal(diff.data.truncated, false);

      const file = await call('GET', `${API}/git/file`, { query: { path: newTxt } });
      assert.equal(file.data.file.status, 'A');
      assert.equal(file.data.file.untracked, true);
      assert.equal(file.data.file.changed, true);

      await fs.rm(newTxt);
    });

    // ── 8. 删除 ──
    await test('删除已跟踪文件：status=D，diff 指向 /dev/null', async () => {
      await fs.rm(deepTxt);
      const { data } = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.deepEqual(data.files, [
        { path: 'nested/deep.txt', oldPath: null, status: 'D', additions: 0, deletions: 2, binary: false, untracked: false, staged: false },
      ]);
      const diff = await call('GET', `${API}/git/diff`, { query: { path: repoDir, file: 'nested/deep.txt' } });
      assert.equal(diff.status, 200);
      assert.equal(diff.data.status, 'D');
      assert.equal(diff.data.deletions, 2);
      assert.match(diff.data.diff, /\+\+\+ \/dev\/null/);
      const file = await call('GET', `${API}/git/file`, { query: { path: deepTxt } });
      assert.equal(file.data.file.status, 'D');
      assert.equal(file.data.file.changed, true);
      await git(['checkout', '--', 'nested/deep.txt'], repoDir);
    });

    // ── 9. 二进制 ──
    await test('二进制修改：binary=true、行数记 0', async () => {
      await fs.writeFile(blobBin, Buffer.from([0, 1, 2, 3, 4, 5, 10]));
      const { data } = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.deepEqual(data.files, [
        { path: 'blob.bin', oldPath: null, status: 'M', additions: 0, deletions: 0, binary: true, untracked: false, staged: false },
      ]);
      const diff = await call('GET', `${API}/git/diff`, { query: { path: repoDir, file: 'blob.bin' } });
      assert.equal(diff.status, 200);
      assert.equal(diff.data.binary, true);
      assert.equal(diff.data.additions, 0);
      assert.equal(diff.data.newText, null);
      await git(['checkout', '--', 'blob.bin'], repoDir);
    });

    // ── 10. 改名 ──
    await test('重命名：status=R、oldPath 给原路径、path 给新路径', async () => {
      await git(['mv', 'keep.txt', 'renamed.txt'], repoDir);
      const { data } = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.equal(data.files.length, 1);
      assert.equal(data.files[0].path, 'renamed.txt');
      assert.equal(data.files[0].oldPath, 'keep.txt');
      assert.equal(data.files[0].status, 'R');
      assert.equal(data.files[0].untracked, false);
      await git(['reset', '-q', '--hard', 'origin/main'], repoDir);
    });

    // ── 11. 暂存状态 ──
    await test('暂存修改：staged=true；暂存新增文件按已跟踪 A 处理（diff 走 git）', async () => {
      await fs.appendFile(aTxt, 'staged\n');
      await git(['add', 'a.txt'], repoDir);
      const changes = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.equal(changes.data.files[0].path, 'a.txt');
      assert.equal(changes.data.files[0].status, 'M');
      assert.equal(changes.data.files[0].staged, true);

      const stagedTxt = path.join(repoDir, 'staged.txt');
      await fs.writeFile(stagedTxt, 'staged file\n');
      await git(['add', 'staged.txt'], repoDir);
      const stagedChanges = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      const stagedEntry = stagedChanges.data.files.find((entry) => entry.path === 'staged.txt');
      assert.ok(stagedEntry, '暂存新增文件应出现');
      assert.equal(stagedEntry.status, 'A');
      assert.equal(stagedEntry.untracked, false);
      assert.equal(stagedEntry.staged, true);

      const diff = await call('GET', `${API}/git/diff`, { query: { path: repoDir, file: 'staged.txt' } });
      assert.equal(diff.status, 200);
      assert.equal(diff.data.status, 'A');
      assert.equal(diff.data.untracked, false);
      assert.match(diff.data.diff, /^\+staged file$/m);

      await git(['reset', '-q', '--hard', 'origin/main'], repoDir);
    });

    // ── 12. base 回退规则 ──
    await test('base：没有上游但有 origin/HEAD → remote-head', async () => {
      await git(['branch', '--unset-upstream'], repoDir);
      const { data } = await call('GET', `${API}/git/info`, { query: { path: repoDir } });
      assert.equal(data.hasUpstream, false);
      assert.equal(data.upstream, null);
      assert.equal(data.baseKind, 'remote-head');
      assert.equal(data.base, 'origin/main');
      assert.equal(data.ahead, null);
      assert.equal(data.behind, null);
    });

    await test('base：上游与 origin/HEAD 都没有 → HEAD（本地提交不再算改动）', async () => {
      await git(['symbolic-ref', '-d', 'refs/remotes/origin/HEAD'], repoDir);
      const info = await call('GET', `${API}/git/info`, { query: { path: repoDir } });
      assert.equal(info.data.baseKind, 'head');
      assert.equal(info.data.base, 'HEAD');

      await fs.appendFile(keepTxt, 'head-base\n');
      await git(['commit', '-q', '-am', 'head base commit'], repoDir);
      const afterCommit = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.equal(afterCommit.data.baseKind, 'head');
      assert.deepEqual(afterCommit.data.files, []);

      await fs.appendFile(keepTxt, 'uncommitted\n');
      const afterEdit = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.equal(afterEdit.data.files.length, 1);
      assert.equal(afterEdit.data.files[0].path, 'keep.txt');

      await git(['reset', '-q', '--hard', 'origin/main'], repoDir);
      await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repoDir);
      await git(['branch', '--set-upstream-to=origin/main', 'main'], repoDir);
      const restored = await call('GET', `${API}/git/info`, { query: { path: repoDir } });
      assert.equal(restored.data.baseKind, 'upstream');
    });

    await test('git/info：detached HEAD → detached=true、branch=null', async () => {
      await git(['checkout', '-q', '--detach'], repoDir);
      const { data } = await call('GET', `${API}/git/info`, { query: { path: repoDir } });
      assert.equal(data.isRepo, true);
      assert.equal(data.detached, true);
      assert.equal(data.branch, null);
      await git(['checkout', '-q', 'main'], repoDir);
    });

    // ── 13. 空仓库 ──
    await test('空仓库：base=null/baseKind=empty，所有文件按 untracked 列出', async () => {
      const emptyRemote = path.join(tmpRoot, 'empty.git');
      const emptyRepo = path.join(tmpRoot, 'empty-repo');
      await git(['init', '-q', '--bare', emptyRemote], tmpRoot);
      await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], emptyRemote);
      await git(['clone', '-q', emptyRemote, emptyRepo], tmpRoot);
      await git(['config', 'user.name', 'DSH Edit Files Self Test'], emptyRepo);
      await git(['config', 'user.email', 'selftest@example.invalid'], emptyRepo);
      await fs.writeFile(path.join(emptyRepo, 'hello.txt'), 'hello\n');

      const info = await call('GET', `${API}/git/info`, { query: { path: emptyRepo } });
      assert.equal(info.status, 200);
      assert.equal(info.data.isRepo, true);
      assert.equal(info.data.base, null);
      assert.equal(info.data.baseKind, 'empty');
      assert.equal(info.data.head, null);
      assert.equal(info.data.branch, 'main');

      const changes = await call('GET', `${API}/git/changes`, { query: { path: emptyRepo } });
      assert.equal(changes.status, 200);
      assert.equal(changes.data.base, null);
      assert.equal(changes.data.baseKind, 'empty');
      assert.deepEqual(changes.data.files, [
        { path: 'hello.txt', oldPath: null, status: 'A', additions: 0, deletions: 0, binary: false, untracked: true, staged: false },
      ]);
      assert.deepEqual(changes.data.totals, { files: 1, additions: 0, deletions: 0, untracked: 1 });

      const diff = await call('GET', `${API}/git/diff`, { query: { path: emptyRepo, file: 'hello.txt' } });
      assert.equal(diff.status, 200);
      assert.equal(diff.data.untracked, true);
      assert.equal(diff.data.newText, 'hello\n');
    });

    // ── 14. git/file 边界 ──
    await test('git/file：未变化文件回 file:null；仓库内不存在的文件也能判断', async () => {
      const unchanged = await call('GET', `${API}/git/file`, { query: { path: keepTxt } });
      assert.equal(unchanged.status, 200);
      assert.equal(unchanged.data.isRepo, true);
      assert.equal(unchanged.data.file, null);

      const missing = await call('GET', `${API}/git/file`, { query: { path: path.join(repoDir, 'deleted-or-missing.txt') } });
      assert.equal(missing.status, 200);
      assert.equal(missing.data.isRepo, true);
      assert.equal(missing.data.file, null);

      const directory = await call('GET', `${API}/git/file`, { query: { path: repoDir } });
      assert.equal(directory.status, 200);
      assert.equal(directory.data.isRepo, true);
      assert.equal(directory.data.file, null);

      const noParam = await call('GET', `${API}/git/file`);
      assert.equal(noParam.status, 400);
      assert.equal(noParam.data.reason, 'missing-path');
    });

    await test('git/info：changes 也能接受文件路径（取 dirname）', async () => {
      const { status, data } = await call('GET', `${API}/git/changes`, { query: { path: aTxt } });
      assert.equal(status, 200);
      assert.equal(data.isRepo, true);
      assert.equal(data.root, realRepo);
      assert.deepEqual(data.files, []);
    });

    // ── 15. diff 越界守卫 ──
    await test('git/diff：file=../outside 被 400 outside-repo 拒绝', async () => {
      const { status, data } = await call('GET', `${API}/git/diff`, { query: { path: repoDir, file: '../outside.txt' } });
      assert.equal(status, 400);
      assert.deepEqual(data, { ok: false, reason: 'outside-repo' });
    });

    await test('git/diff：绝对路径逃出仓库同样被拒；仓库内 .. 归一化仍允许', async () => {
      const absolute = await call('GET', `${API}/git/diff`, { query: { path: repoDir, file: outsideTxt } });
      assert.equal(absolute.status, 400);
      assert.equal(absolute.data.reason, 'outside-repo');

      const normalized = await call('GET', `${API}/git/diff`, { query: { path: repoDir, file: '../repo/a.txt' } });
      assert.equal(normalized.status, 200);
      assert.equal(normalized.data.file, 'a.txt');
    });

    await test('git/diff：缺 file → 400 missing-file；缺 path → 400 missing-path', async () => {
      const noFile = await call('GET', `${API}/git/diff`, { query: { path: repoDir } });
      assert.equal(noFile.status, 400);
      assert.equal(noFile.data.reason, 'missing-file');
      const noPath = await call('GET', `${API}/git/diff`, { query: { file: 'a.txt' } });
      assert.equal(noPath.status, 400);
      assert.equal(noPath.data.reason, 'missing-path');
    });

    // ── 16. limits：截断与超限 ──
    await test('maxChangedFiles：列表被截断且 truncated=true', async () => {
      await fs.appendFile(aTxt, 'one\n');
      await fs.appendFile(keepTxt, 'one\n');
      const { data } = await callTiny('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.equal(data.truncated, true);
      assert.equal(data.files.length, 1);
      assert.equal(data.totals.files, 1);
      await git(['reset', '-q', '--hard', 'origin/main'], repoDir);
    });

    await test('maxDiffLines：diff 截断到前 N 行并标记 truncated', async () => {
      await fs.appendFile(aTxt, Array.from({ length: 10 }, (_, index) => `line-${index}`).join('\n') + '\n');
      const { data } = await callTiny('GET', `${API}/git/diff`, { query: { path: repoDir, file: 'a.txt' } });
      assert.equal(data.truncated, true);
      assert.equal(data.diff.split('\n').length, 3);
      await git(['reset', '-q', '--hard', 'origin/main'], repoDir);
    });

    await test('maxFileBytes：未跟踪文件 newText 截断到上限并标记 truncated', async () => {
      const bigTxt = path.join(repoDir, 'big-untracked.txt');
      await fs.writeFile(bigTxt, `${'q'.repeat(100)}\n`);
      const { data } = await callTiny('GET', `${API}/git/diff`, { query: { path: repoDir, file: 'big-untracked.txt' } });
      assert.equal(data.status, 'A');
      assert.equal(data.truncated, true);
      assert.equal(data.binary, false);
      assert.equal(data.newText.length, 32);
      await fs.rm(bigTxt);
    });

    await test('file/read：超过 maxFileBytes → 413 too-large（含 size/limit）', async () => {
      const medium = path.join(tmpRoot, 'medium.txt');
      await fs.writeFile(medium, 'x'.repeat(64));
      const normal = await call('POST', `${API}/file/read`, { body: { path: medium } });
      assert.equal(normal.status, 200);
      assert.equal(normal.data.content, 'x'.repeat(64));
      const tooLarge = await callTiny('POST', `${API}/file/read`, { body: { path: medium } });
      assert.equal(tooLarge.status, 413);
      assert.equal(tooLarge.data.reason, 'too-large');
      assert.equal(tooLarge.data.size, 64);
      assert.equal(tooLarge.data.limit, 32);
    });

    await test('file/write：超过 maxFileBytes → 413 too-large', async () => {
      const target = path.join(tmpRoot, 'too-large-write.txt');
      const { status, data } = await callTiny('POST', `${API}/file/write`, { body: { path: target, content: 'y'.repeat(100) } });
      assert.equal(status, 413);
      assert.equal(data.reason, 'too-large');
      assert.equal(data.limit, 32);
    });

    // ── 17. 符号链接与特殊文件名 ──
    await test('符号链接目录：git 换成解析后的仓库根，入口仍可用', async () => {
      const linkDir = path.join(tmpRoot, 'repo-link');
      await fs.symlink(repoDir, linkDir, 'dir');
      const info = await call('GET', `${API}/git/info`, { query: { path: linkDir } });
      assert.equal(info.status, 200);
      assert.equal(info.data.isRepo, true);
      assert.equal(info.data.root, realRepo);

      const changes = await call('GET', `${API}/git/changes`, { query: { path: linkDir } });
      assert.equal(changes.status, 200);
      assert.equal(changes.data.root, realRepo);
      assert.deepEqual(changes.data.files, []);

      const file = await call('GET', `${API}/git/file`, { query: { path: path.join(linkDir, 'a.txt') } });
      assert.equal(file.status, 200);
      assert.equal(file.data.isRepo, true);
      assert.equal(file.data.root, realRepo);
      assert.equal(file.data.file, null);
    });

    await test('仓库内符号链接指向仓库外：diff 不跟随读取（400 outside-repo）', async () => {
      const escapeLink = path.join(repoDir, 'escape-link.txt');
      await fs.symlink(outsideTxt, escapeLink, 'file');
      const changes = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.equal(changes.data.files.some((entry) => entry.path === 'escape-link.txt' && entry.untracked), true);
      const diff = await call('GET', `${API}/git/diff`, { query: { path: repoDir, file: 'escape-link.txt' } });
      assert.equal(diff.status, 400);
      assert.equal(diff.data.reason, 'outside-repo');
      await fs.rm(escapeLink);
    });

    await test('文件名含 glob 字符：paths 按字面匹配', async () => {
      const weird = path.join(repoDir, 'weird[1].txt');
      await fs.writeFile(weird, 'weird content\n');
      const changes = await call('GET', `${API}/git/changes`, { query: { path: repoDir } });
      assert.equal(changes.data.files.some((entry) => entry.path === 'weird[1].txt'), true);
      const diff = await call('GET', `${API}/git/diff`, { query: { path: repoDir, file: 'weird[1].txt' } });
      assert.equal(diff.status, 200);
      assert.equal(diff.data.newText, 'weird content\n');
      await fs.rm(weird);
    });

    // ── 18. file/read ──
    await test('file/read：返回 content/size/mtimeMs/eol/bom/mode', async () => {
      const editPath = path.join(repoDir, 'edit.txt');
      await fs.writeFile(editPath, 'line one\nline two\n');
      const stat = await fs.stat(editPath);
      const { status, data } = await call('POST', `${API}/file/read`, { body: { path: editPath } });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.path, editPath);
      assert.equal(data.content, 'line one\nline two\n');
      assert.equal(data.size, byteLength('line one\nline two\n'));
      assert.equal(data.eol, 'lf');
      assert.equal(data.bom, false);
      assert.equal(data.mode, stat.mode & 0o777);
      assert.ok(Math.abs(data.mtimeMs - stat.mtimeMs) <= 1);
    });

    await test('file/read：错误路径 → 404；目录 → 400 not-regular-file；缺 path → 400', async () => {
      const missing = await call('POST', `${API}/file/read`, { body: { path: path.join(tmpRoot, 'no-file.txt') } });
      assert.equal(missing.status, 404);
      assert.deepEqual(missing.data, { ok: false, reason: 'not-found' });
      const directory = await call('POST', `${API}/file/read`, { body: { path: tmpRoot } });
      assert.equal(directory.status, 400);
      assert.deepEqual(directory.data, { ok: false, reason: 'not-regular-file' });
      const noPath = await call('POST', `${API}/file/read`, { body: {} });
      assert.equal(noPath.status, 400);
      assert.equal(noPath.data.reason, 'missing-path');
    });

    await test('file/read：二进制 → 415；非法 UTF-8 占比过高也算二进制', async () => {
      const nulFile = path.join(tmpRoot, 'nul.bin');
      await fs.writeFile(nulFile, Buffer.from([0x41, 0x00, 0x42]));
      const nul = await call('POST', `${API}/file/read`, { body: { path: nulFile } });
      assert.equal(nul.status, 415);
      assert.deepEqual(nul.data, { ok: false, reason: 'binary' });

      const invalid = path.join(tmpRoot, 'invalid-utf8.bin');
      await fs.writeFile(invalid, Buffer.alloc(100, 0xff));
      const bad = await call('POST', `${API}/file/read`, { body: { path: invalid } });
      assert.equal(bad.status, 415);
      assert.equal(bad.data.reason, 'binary');
    });

    await test('file/read：CRLF / mixed / BOM 判定正确', async () => {
      const crlfPath = path.join(tmpRoot, 'crlf.txt');
      await fs.writeFile(crlfPath, 'one\r\ntwo\r\n');
      const crlf = await call('POST', `${API}/file/read`, { body: { path: crlfPath } });
      assert.equal(crlf.data.eol, 'crlf');
      assert.equal(crlf.data.content, 'one\r\ntwo\r\n');

      const mixedPath = path.join(tmpRoot, 'mixed.txt');
      await fs.writeFile(mixedPath, 'a\r\nb\nc\r\n');
      const mixed = await call('POST', `${API}/file/read`, { body: { path: mixedPath } });
      assert.equal(mixed.data.eol, 'mixed');

      const bomPath = path.join(tmpRoot, 'bom.txt');
      await fs.writeFile(bomPath, Buffer.from('\uFEFFhello\n', 'utf8'));
      const bom = await call('POST', `${API}/file/read`, { body: { path: bomPath } });
      assert.equal(bom.data.bom, true);
      assert.equal(bom.data.content, 'hello\n');
      assert.equal(bom.data.size, byteLength('\uFEFFhello\n'));
    });

    // ── 19. file/write ──
    await test('file/write：读改写往返，再次写入相同内容 → unchanged', async () => {
      const editPath = path.join(repoDir, 'edit.txt');
      const first = await call('POST', `${API}/file/read`, { body: { path: editPath } });
      const content = 'line one\nline two\nline three\n';
      const write = await call('POST', `${API}/file/write`, { body: { path: editPath, content, expectedMtimeMs: first.data.mtimeMs } });
      assert.equal(write.status, 200);
      assert.equal(write.data.ok, true);
      assert.equal(write.data.unchanged, false);
      assert.equal(write.data.created, false);
      assert.equal(write.data.bytes, byteLength(content));
      assert.equal(write.data.size, byteLength(content));
      assert.equal(typeof write.data.mtimeMs, 'number');
      assert.equal(await fs.readFile(editPath, 'utf8'), content);

      const second = await call('POST', `${API}/file/read`, { body: { path: editPath } });
      assert.equal(second.data.content, content);
      const again = await call('POST', `${API}/file/write`, { body: { path: editPath, content, expectedMtimeMs: second.data.mtimeMs } });
      assert.equal(again.status, 200);
      assert.equal(again.data.unchanged, true);
      assert.equal(again.data.created, false);
    });

    await test('file/write：expectedMtimeMs 过期 → 409 conflict；force 可覆盖', async () => {
      const editPath = path.join(repoDir, 'edit.txt');
      const current = await call('POST', `${API}/file/read`, { body: { path: editPath } });
      const staleMtime = current.data.mtimeMs - 10000;
      const conflict = await call('POST', `${API}/file/write`, {
        body: { path: editPath, content: 'conflicting\n', expectedMtimeMs: staleMtime },
      });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.data.ok, false);
      assert.equal(conflict.data.reason, 'conflict');
      const diskStat = await fs.stat(editPath);
      assert.ok(Math.abs(conflict.data.currentMtimeMs - diskStat.mtimeMs) <= 1);
      assert.notEqual(await fs.readFile(editPath, 'utf8'), 'conflicting\n');

      const forced = await call('POST', `${API}/file/write`, {
        body: { path: editPath, content: 'forced\n', expectedMtimeMs: staleMtime, force: true },
      });
      assert.equal(forced.status, 200);
      assert.equal(await fs.readFile(editPath, 'utf8'), 'forced\n');
    });

    await test('file/write：CRLF 转换不重复加 \\r；转换后与磁盘一致时 unchanged', async () => {
      const crlfPath = path.join(tmpRoot, 'write-crlf.txt');
      const created = await call('POST', `${API}/file/write`, { body: { path: crlfPath, content: 'one\ntwo\n', eol: 'crlf' } });
      assert.equal(created.status, 200);
      assert.equal(created.data.created, true);
      assert.equal(await fs.readFile(crlfPath, 'utf8'), 'one\r\ntwo\r\n');

      const unchanged = await call('POST', `${API}/file/write`, { body: { path: crlfPath, content: 'one\ntwo\n', eol: 'crlf' } });
      assert.equal(unchanged.status, 200);
      assert.equal(unchanged.data.unchanged, true);
    });

    await test('file/write：BOM 补回与去掉', async () => {
      const bomPath = path.join(tmpRoot, 'write-bom.txt');
      await call('POST', `${API}/file/write`, { body: { path: bomPath, content: 'world\n', bom: true } });
      const bytes = await fs.readFile(bomPath);
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const read = await call('POST', `${API}/file/read`, { body: { path: bomPath } });
      assert.equal(read.data.bom, true);
      assert.equal(read.data.content, 'world\n');

      const stripped = await call('POST', `${API}/file/write`, { body: { path: bomPath, content: 'plain\n', bom: false } });
      assert.equal(stripped.status, 200);
      const plainBytes = await fs.readFile(bomPath);
      assert.notDeepEqual([...plainBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    });

    await test('file/write：新建文件 created=true，权限位 = 0o666 & ~umask', async () => {
      const createdPath = path.join(repoDir, 'created-file.txt');
      const { status, data } = await call('POST', `${API}/file/write`, { body: { path: createdPath, content: 'created\n' } });
      assert.equal(status, 200);
      assert.equal(data.created, true);
      assert.equal(data.unchanged, false);
      const stat = await fs.stat(createdPath);
      assert.equal(stat.mode & 0o777, 0o666 & ~process.umask());
      await fs.rm(createdPath);
    });

    await test('file/write：保留原文件权限位', async () => {
      const modePath = path.join(tmpRoot, 'mode-file.txt');
      await fs.writeFile(modePath, 'before\n');
      await fs.chmod(modePath, 0o600);
      const read = await call('POST', `${API}/file/read`, { body: { path: modePath } });
      assert.equal(read.data.mode, 0o600);
      const write = await call('POST', `${API}/file/write`, {
        body: { path: modePath, content: 'after\n', expectedMtimeMs: read.data.mtimeMs },
      });
      assert.equal(write.status, 200);
      const stat = await fs.stat(modePath);
      assert.equal(stat.mode & 0o777, 0o600);
      assert.equal(await fs.readFile(modePath, 'utf8'), 'after\n');
    });

    await test('file/write：父目录不存在 → 400 no-parent；目标是目录 → 400 not-regular-file', async () => {
      const noParent = await call('POST', `${API}/file/write`, {
        body: { path: path.join(tmpRoot, 'missing-dir', 'x.txt'), content: 'x' },
      });
      assert.equal(noParent.status, 400);
      assert.deepEqual(noParent.data, { ok: false, reason: 'no-parent' });

      const directory = await call('POST', `${API}/file/write`, { body: { path: tmpRoot, content: 'x' } });
      assert.equal(directory.status, 400);
      assert.deepEqual(directory.data, { ok: false, reason: 'not-regular-file' });
    });

    await test('file/write：缺 content → 400 missing-content；缺 path → 400 missing-path', async () => {
      const noContent = await call('POST', `${API}/file/write`, { body: { path: path.join(tmpRoot, 'x.txt') } });
      assert.equal(noContent.status, 400);
      assert.equal(noContent.data.reason, 'missing-content');
      const noPath = await call('POST', `${API}/file/write`, { body: { content: 'x' } });
      assert.equal(noPath.status, 400);
      assert.equal(noPath.data.reason, 'missing-path');
    });

    await test('file/write：写入符号链接不破坏链接，落到它指向的真文件', async () => {
      const target = path.join(tmpRoot, 'symlink-target.txt');
      const link = path.join(tmpRoot, 'symlink-link.txt');
      await fs.writeFile(target, 'before\n');
      await fs.symlink(target, link, 'file');
      const { status } = await call('POST', `${API}/file/write`, { body: { path: link, content: 'after\n' } });
      assert.equal(status, 200);
      assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
      assert.equal(await fs.readFile(target, 'utf8'), 'after\n');
    });

    // ── 20. git 缺失 ──
    await test('git 可执行文件缺失：git/info 返回 503 git-unavailable', async () => {
      const originalPath = process.env.PATH;
      try {
        process.env.PATH = path.join(tmpRoot, 'no-such-bin-dir');
        const { status, data } = await call('GET', `${API}/git/info`, { query: { path: repoDir } });
        assert.equal(status, 503);
        assert.equal(data.ok, false);
        assert.equal(data.reason, 'git-unavailable');
        assert.equal(typeof data.error, 'string');
      } finally {
        process.env.PATH = originalPath;
      }
      const recovered = await call('GET', `${API}/git/info`, { query: { path: repoDir } });
      assert.equal(recovered.status, 200);
      assert.equal(recovered.data.isRepo, true);
    });

    // ── 21. query / body 双通道与坏 JSON ──
    await test('POST 路由也接受 query 参数；坏 JSON body 回退到 query', async () => {
      const editPath = path.join(repoDir, 'edit.txt');
      const viaQuery = await call('POST', `${API}/file/read`, { query: { path: editPath } });
      assert.equal(viaQuery.status, 200);
      assert.equal(viaQuery.data.ok, true);
      const malformed = await call('POST', `${API}/file/read`, { query: { path: editPath }, rawBody: '{not json' });
      assert.equal(malformed.status, 200);
      assert.equal(malformed.data.ok, true);
    });

    await test('未预期异常不会漏出路由：坏请求也得 JSON 500', async () => {
      // 让 route 收到一个 URL 畸形、但方法可用的请求；paramsOf 吞掉 URL 错误后应走 missing-path 而不是抛异常。
      const route = routes.find((item) => item.path === `${API}/git/info`);
      const response = await route.fetch({ method: 'GET', url: 'http://localhost', json: async () => ({}) });
      const data = JSON.parse(await response.text());
      assert.equal(response.status, 400);
      assert.equal(data.ok, false);
      assert.equal(data.reason, 'missing-path');
    });

    // ── 22. cordis_inspect 自检提供者 ──
    await test('cordis_inspect 自检提供者：EditFiles.status 回报路由与调用计数', async () => {
      const providers = collectRoutes.inspectProviders ?? [];
      assert.equal(providers.length, 1, '应当注册一个 Host inspect provider');
      const provider = providers[0];
      assert.equal(provider.manifest.id, 'EditFiles');
      assert.equal(provider.manifest.methods[0].name, 'status');
      const snapshot = await provider.query('status', {});
      assert.equal(snapshot.plugin, 'dsh-plugin-edit-files');
      assert.equal(snapshot.registeredRoutes.length, 7);
      assert.deepEqual(snapshot.registrationFailures, []);
      assert.ok(snapshot.totalHits > 0, '自检里已经调用过路由，计数应大于 0');
      assert.ok(snapshot.recentHits.length > 0);
      assert.ok(snapshot.recentHits[0].route.startsWith('/api/edit-files/'));
    });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function printSummary() {
  const total = passed + failed.length;
  console.log('');
  if (failed.length === 0) {
    console.log(`===== 自检汇总：${passed}/${total} 全部通过 ✔ =====`);
  } else {
    console.log(`===== 自检汇总：${passed}/${total} 通过，${failed.length} 失败 =====`);
    for (const item of failed) console.log(`  ✗ ${item.title}`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main()
  .then(printSummary)
  .catch((error) => {
    console.error('自检初始化失败：');
    console.error(error);
    process.exitCode = 1;
  });
