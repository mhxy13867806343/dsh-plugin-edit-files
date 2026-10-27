/**
 * lib/git.js —— 只读 git 探测：仓库定位、基准（base）解析、改动列表、单文件 diff / 状态。
 *
 * 所有外部命令走 execFile（数组参数、不经过 shell），统一 20s 超时与输出上限；
 * 仓库根一律用 git 解析出的真实路径，避免 /var 与 /private/var 这类符号链接让后续路径比较失配。
 *
 * 「改动」的产品语义是**本地工作区 vs 远程基准**：
 *   git diff <base> 同时覆盖「本地已提交未推 + 暂存 + 未暂存」，再补 ls-files --others 的未跟踪文件。
 *   所以本地改动被改回与远程一致时，文件会从列表里自然消失 —— 这正是不展示“伪改动”的关键。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readTextFile } from './files.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 20000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
});

let cachedGitVersion;

function messageOf(error) {
  return error && error.message ? error.message : String(error ?? 'git failed');
}

function cleanEnv() {
  const env = { ...process.env };
  // 宿主环境里若带着这些变量，`git -C <repo>` 会被指到别的仓库/索引，探测结果全错。
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    delete env[key];
  }
  return { ...env, ...GIT_ENV };
}

async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      env: cleanEnv(),
    });
    return { ok: true, stdout };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, unavailable: true, error };
    return { ok: false, unavailable: false, error };
  }
}

async function gitVersion(cwd) {
  if (cachedGitVersion !== undefined) return { ok: true, version: cachedGitVersion };
  const result = await git(['--version'], cwd);
  if (!result.ok) return { ok: false, unavailable: result.unavailable === true, error: result.error };
  const match = result.stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
  cachedGitVersion = match ? match[1] : null;
  return { ok: true, version: cachedGitVersion };
}

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * 把路径规范成真实路径：存在的部分走 realpath，缺失的尾巴原样拼回去。
 * （macOS 的 os.tmpdir() 在 /var 下，而 git 报出来的根在 /private/var 下，不统一就永远判成“仓库外”。）
 */
async function canonicalize(input) {
  let current = path.resolve(String(input));
  const missing = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length > 0 ? path.join(real, ...missing) : real;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(String(input));
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** 文件名里可能有 * [ ] 或前导冒号，用 literal 魔法保证 git 按字面路径匹配。 */
function pathspec(relativePath) {
  return `:(literal)${relativePath}`;
}

async function resolveRootFrom(start) {
  let current = start;
  for (;;) {
    const stat = await statOrNull(current);
    if (stat && stat.isDirectory()) {
      const result = await git(['rev-parse', '--show-toplevel'], current);
      if (result.unavailable) return { kind: 'git-unavailable', error: messageOf(result.error) };
      if (result.ok) {
        const root = result.stdout.trim();
        if (root) return { kind: 'repo', root: path.resolve(root) };
      }
      // 不是仓库（或没有工作区，例如 bare）就继续向上找
    }
    const parent = path.dirname(current);
    if (parent === current) return { kind: 'not-repo' };
    current = parent;
  }
}

/**
 * 从任意路径定位仓库根。
 * `mustExist` 用于 git/info：契约规定路径不存在要回 not-found；其余接口允许文件已被删除。
 */
export async function openRepo(inputPath, options = {}) {
  const raw = String(inputPath ?? '');
  if (!raw) return { kind: 'missing-path' };
  const absolute = path.resolve(raw);
  const stat = await statOrNull(absolute);
  if (!stat) {
    if (options.mustExist === true) return { kind: 'not-found' };
    // 不存在时按“文件路径”处理：从它的父目录（会自动向上找到存在的祖先）开始找仓库
    return resolveRootFrom(await canonicalize(path.dirname(absolute)));
  }
  return resolveRootFrom(stat.isDirectory() ? await canonicalize(absolute) : await canonicalize(path.dirname(absolute)));
}

function parseNameStatusZ(text) {
  const parts = String(text).split('\0');
  const entries = [];
  for (let index = 0; index < parts.length;) {
    const rawStatus = parts[index];
    index += 1;
    if (!rawStatus) continue;
    const status = rawStatus[0].toUpperCase();
    if (status === 'R' || status === 'C') {
      const oldPath = parts[index] ?? '';
      const newPath = parts[index + 1] ?? '';
      index += 2;
      if (newPath) entries.push({ path: newPath, oldPath: oldPath || null, status });
    } else {
      const filePath = parts[index] ?? '';
      index += 1;
      if (filePath) entries.push({ path: filePath, oldPath: null, status });
    }
  }
  return entries;
}

function parseNumstatZ(text) {
  const stats = new Map();
  const parts = String(text).split('\0');
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (!record) continue;
    const match = record.match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/);
    if (!match) continue;
    let filePath = match[3];
    if (!filePath) {
      // 改名记录：路径字段被拆到后面两个 NUL 字段里（旧路径、新路径）
      index += 2;
      filePath = parts[index] ?? '';
    }
    const binary = match[1] === '-' || match[2] === '-';
    stats.set(filePath, {
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    });
  }
  return stats;
}

function comparePath(left, right) {
  const leftKey = left.path.toLowerCase();
  const rightKey = right.path.toLowerCase();
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

async function resolveMeta(root, options = {}) {
  const version = await gitVersion(root);
  if (!version.ok) return { ok: false, unavailable: true, error: version.error };

  // `--short HEAD` 一次同时解决「有没有 HEAD」和「head 短哈希」两件事；空仓库里它会失败。
  const shortHead = await git(['rev-parse', '--short', 'HEAD'], root);
  if (shortHead.unavailable) return { ok: false, unavailable: true, error: shortHead.error };
  const hasHead = shortHead.ok && shortHead.stdout.trim() !== '';
  const head = hasHead ? shortHead.stdout.trim() : null;

  const symbolic = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  if (symbolic.unavailable) return { ok: false, unavailable: true, error: symbolic.error };
  const branch = symbolic.ok && symbolic.stdout.trim() ? symbolic.stdout.trim() : null;
  const detached = branch === null && hasHead;

  let upstream = null;
  if (hasHead) {
    const upstreamResult = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
    if (upstreamResult.unavailable) return { ok: false, unavailable: true, error: upstreamResult.error };
    if (upstreamResult.ok) {
      const candidate = upstreamResult.stdout.trim();
      if (candidate) {
        const verify = await git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], root);
        if (verify.ok) upstream = candidate;
      }
    }
  }

  // 没有上游时退到 origin/HEAD；注意 symbolic-ref 的输出是 refs/remotes/origin/main，要剥前缀。
  let remoteHead = null;
  if (!upstream) {
    const symbolicRemote = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root);
    if (symbolicRemote.ok) {
      const target = symbolicRemote.stdout.trim().replace(/^refs\/remotes\//, '');
      if (target) {
        const verify = await git(['rev-parse', '--verify', '--quiet', `${target}^{commit}`], root);
        if (verify.ok) remoteHead = target;
      }
    }
  }

  let base = null;
  let baseKind = 'empty';
  if (hasHead) {
    if (upstream) {
      base = upstream;
      baseKind = 'upstream';
    } else if (remoteHead) {
      base = remoteHead;
      baseKind = 'remote-head';
    } else {
      base = 'HEAD';
      baseKind = 'head';
    }
  }

  let ahead = null;
  let behind = null;
  if (baseKind === 'upstream') {
    // 输出是 `<upstream>...HEAD`：左 = 只在 upstream 里的提交数（behind），右 = 只在 HEAD 里的（ahead）。
    const counts = await git(['rev-list', '--left-right', '--count', `${base}...HEAD`], root);
    if (counts.ok) {
      const numbers = counts.stdout.trim().split(/\s+/).map((value) => Number(value));
      if (numbers.length === 2 && numbers.every((value) => Number.isFinite(value))) {
        behind = numbers[0];
        ahead = numbers[1];
      }
    }
  }

  let remoteName = null;
  let remoteUrl = null;
  if (options.withRemotes === true) {
    if (upstream && upstream.includes('/')) remoteName = upstream.split('/')[0];
    else if (baseKind === 'remote-head' && base.includes('/')) remoteName = base.split('/')[0];
    if (!remoteName) {
      const remotes = await git(['remote'], root);
      if (remotes.ok) {
        const names = remotes.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
        if (names.length > 0) remoteName = names.includes('origin') ? 'origin' : names[0];
      }
    }
    if (remoteName) {
      const url = await git(['remote', 'get-url', remoteName], root);
      if (url.ok) remoteUrl = url.stdout.trim() || null;
      else {
        const configUrl = await git(['config', '--get', `remote.${remoteName}.url`], root);
        if (configUrl.ok) remoteUrl = configUrl.stdout.trim() || null;
      }
    }
  }

  return {
    ok: true,
    meta: { branch, detached, upstream, hasUpstream: upstream !== null, base, baseKind, remoteName, remoteUrl, head, ahead, behind, gitVersion: version.version },
  };
}

function unavailableMeta(result) {
  return { kind: 'git-unavailable', error: messageOf(result.error) };
}

export async function gitInfo(inputPath) {
  const opened = await openRepo(inputPath, { mustExist: true });
  if (opened.kind !== 'repo') return opened;
  const resolved = await resolveMeta(opened.root, { withRemotes: true });
  if (!resolved.ok) return unavailableMeta(resolved);
  const { meta } = resolved;
  return {
    kind: 'ok',
    payload: {
      ok: true,
      isRepo: true,
      path: String(inputPath),
      root: opened.root,
      branch: meta.branch,
      detached: meta.detached,
      upstream: meta.upstream,
      hasUpstream: meta.hasUpstream,
      base: meta.base,
      baseKind: meta.baseKind,
      remoteName: meta.remoteName,
      remoteUrl: meta.remoteUrl,
      head: meta.head,
      ahead: meta.ahead,
      behind: meta.behind,
      gitVersion: meta.gitVersion,
    },
  };
}

async function readTrackedChanges(root, base) {
  const [nameStatus, numstatResult, stagedResult] = await Promise.all([
    git(['diff', '--name-status', '-z', base, '--'], root),
    git(['diff', '--numstat', '-z', base, '--'], root),
    git(['diff', '--cached', '--name-status', '-z', 'HEAD', '--'], root),
  ]);
  if (nameStatus.unavailable || numstatResult.unavailable || stagedResult.unavailable) {
    return { kind: 'git-unavailable', error: messageOf(nameStatus.error ?? numstatResult.error ?? stagedResult.error) };
  }
  if (!nameStatus.ok) return { kind: 'git-failed', error: messageOf(nameStatus.error) };

  const stats = numstatResult.ok ? parseNumstatZ(numstatResult.stdout) : new Map();
  const staged = stagedResult.ok ? new Set(parseNameStatusZ(stagedResult.stdout).map((entry) => entry.path)) : new Set();
  const files = parseNameStatusZ(nameStatus.stdout).map((entry) => {
    const stat = stats.get(entry.path);
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      additions: stat ? stat.additions : 0,
      deletions: stat ? stat.deletions : 0,
      binary: stat ? stat.binary : false,
      untracked: false,
      staged: staged.has(entry.path),
    };
  });
  return { kind: 'ok', files };
}

async function readUntracked(root) {
  const result = await git(['ls-files', '--others', '--exclude-standard', '-z'], root);
  if (result.unavailable) return { kind: 'git-unavailable', error: messageOf(result.error) };
  if (!result.ok) return { kind: 'git-failed', error: messageOf(result.error) };
  const files = result.stdout
    .split('\0')
    .filter(Boolean)
    .map((filePath) => ({ path: filePath, oldPath: null, status: 'A', additions: 0, deletions: 0, binary: false, untracked: true, staged: false }));
  return { kind: 'ok', files };
}

export async function gitChanges(inputPath, limits) {
  const opened = await openRepo(inputPath);
  if (opened.kind !== 'repo') return opened;
  const root = opened.root;
  const resolved = await resolveMeta(root, { withRemotes: true });
  if (!resolved.ok) return unavailableMeta(resolved);
  const { branch, base, baseKind, upstream, remoteUrl, ahead, behind } = resolved.meta;

  let files = [];
  if (base !== null) {
    const tracked = await readTrackedChanges(root, base);
    if (tracked.kind !== 'ok') return tracked;
    files = tracked.files;
  }
  const untracked = await readUntracked(root);
  if (untracked.kind !== 'ok') return untracked;
  files = files.concat(untracked.files);
  files.sort(comparePath);

  const truncated = files.length > limits.maxChangedFiles;
  const listed = truncated ? files.slice(0, limits.maxChangedFiles) : files;
  // totals 按真正回传的列表统计，保证 totals.files 与 files.length 一致；被截断这件事由 truncated 表达。
  const totals = listed.reduce(
    (accumulator, file) => {
      accumulator.files += 1;
      accumulator.additions += file.additions;
      accumulator.deletions += file.deletions;
      if (file.untracked) accumulator.untracked += 1;
      return accumulator;
    },
    { files: 0, additions: 0, deletions: 0, untracked: 0 },
  );

  return {
    kind: 'ok',
    payload: { ok: true, isRepo: true, root, branch, base, baseKind, upstream, remoteUrl, ahead, behind, files: listed, totals, truncated },
  };
}

async function isTrackedFile(root, relativePath) {
  const result = await git(['ls-files', '--cached', '-z', '--', pathspec(relativePath)], root);
  if (!result.ok) return false;
  return result.stdout.split('\0').some((entry) => entry === relativePath);
}

async function isUntrackedFile(root, relativePath) {
  const result = await git(['ls-files', '--others', '--exclude-standard', '-z', '--', pathspec(relativePath)], root);
  if (!result.ok) return false;
  return result.stdout.split('\0').some((entry) => entry === relativePath);
}

/**
 * 单文件「相对 base 有没有变」。返回 { found, status, untracked, additions, deletions, binary } 或错误 kind。
 * 用 pathspec 限定只查这一个文件，比整份 changes 便宜；代价是 git 会关掉改名检测，
 * 所以“暂存区里的 A”要再用整份 name-status 校正一次，避免把改名目标误报成新增。
 */
async function fileChange(root, base, relativePath) {
  if (await isUntrackedFile(root, relativePath)) {
    return { found: true, status: 'A', untracked: true, additions: 0, deletions: 0, binary: false };
  }
  if (base === null) return { found: false };

  const nameStatus = await git(['diff', '--name-status', '-z', base, '--', pathspec(relativePath)], root);
  if (nameStatus.unavailable) return { kind: 'git-unavailable', error: messageOf(nameStatus.error) };
  if (!nameStatus.ok) return { kind: 'git-failed', error: messageOf(nameStatus.error) };
  const matched = parseNameStatusZ(nameStatus.stdout).filter((entry) => entry.path === relativePath || entry.oldPath === relativePath);
  let entry = matched.find((item) => item.path === relativePath) ?? null;
  if (!entry) return { found: false };

  let additions = 0;
  let deletions = 0;
  let binary = false;
  const numstatResult = await git(['diff', '--numstat', '-z', base, '--', pathspec(relativePath)], root);
  if (numstatResult.ok) {
    const stat = parseNumstatZ(numstatResult.stdout).get(relativePath);
    if (stat) {
      additions = stat.additions;
      deletions = stat.deletions;
      binary = stat.binary;
    }
  }

  if (entry.status === 'A' && (await isTrackedFile(root, relativePath))) {
    const full = await readTrackedChanges(root, base);
    if (full.kind === 'ok') {
      const exact = full.files.find((item) => item.path === relativePath);
      if (exact) {
        entry = exact;
        additions = exact.additions;
        deletions = exact.deletions;
        binary = exact.binary;
      }
    }
  }
  return { found: true, status: entry.status, untracked: false, additions, deletions, binary };
}

/** 仓库内的符号链接若指向仓库外，按“逃出仓库”处理，不把外面文件的内容读出去。 */
async function escapesRepoViaSymlink(root, absolutePath) {
  let real;
  try {
    real = await fs.realpath(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
  const relative = path.relative(root, real);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function limitLines(text, maxLines) {
  if (!text) return { text: '', truncated: false };
  const hadTrailingNewline = text.endsWith('\n');
  const lines = (hadTrailingNewline ? text.slice(0, -1) : text).split('\n');
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true };
}

export async function gitDiff(inputPath, fileParam, limits) {
  const requested = String(fileParam ?? '');
  if (!requested) return { kind: 'missing-file' };
  const opened = await openRepo(inputPath);
  if (opened.kind !== 'repo') return opened;
  const root = opened.root;

  const absolute = path.resolve(root, requested);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { kind: 'outside-repo' };
  }
  const relativePath = relative.split(path.sep).join('/');
  if (await escapesRepoViaSymlink(root, absolute)) return { kind: 'outside-repo' };

  const resolved = await resolveMeta(root);
  if (!resolved.ok) return unavailableMeta(resolved);
  const base = resolved.meta.base;

  const change = await fileChange(root, base, relativePath);
  if (change.kind) return change;

  if (!change.found) {
    const stat = await statOrNull(absolute);
    if (!stat || !stat.isFile()) return { kind: 'not-found' };
    // 正常不会走到这里：客户端只会对 changes 里列出的文件要 diff。真来了就回一份空 diff。
    return {
      kind: 'ok',
      payload: { ok: true, file: relativePath, status: 'M', untracked: false, binary: false, truncated: false, diff: '', additions: 0, deletions: 0, newText: null },
    };
  }

  if (change.untracked || base === null) {
    const text = await readTextFile(absolute, limits.maxFileBytes, { truncate: true });
    if (text.kind !== 'ok') return { kind: 'not-found' };
    return {
      kind: 'ok',
      payload: {
        ok: true,
        file: relativePath,
        status: change.status,
        untracked: true,
        binary: text.binary,
        truncated: text.truncated,
        diff: '',
        additions: 0,
        deletions: 0,
        newText: text.binary ? null : text.text,
      },
    };
  }

  const diffResult = await git(['diff', '--no-color', '--no-ext-diff', '--unified=3', base, '--', pathspec(relativePath)], root);
  if (diffResult.unavailable) return { kind: 'git-unavailable', error: messageOf(diffResult.error) };
  if (!diffResult.ok) return { kind: 'git-failed', error: messageOf(diffResult.error) };
  const limited = limitLines(diffResult.stdout, limits.maxDiffLines);
  return {
    kind: 'ok',
    payload: {
      ok: true,
      file: relativePath,
      status: change.status,
      untracked: false,
      binary: change.binary === true,
      truncated: limited.truncated,
      diff: limited.text,
      additions: change.additions,
      deletions: change.deletions,
      newText: null,
    },
  };
}

export async function gitFile(inputPath) {
  const requested = String(inputPath ?? '');
  if (!requested) return { kind: 'missing-path' };
  const absolute = path.resolve(requested);
  const stat = await statOrNull(absolute);
  const opened = await openRepo(requested);
  if (opened.kind === 'git-unavailable') return opened;
  if (opened.kind === 'missing-path') return opened;
  if (opened.kind !== 'repo') return { kind: 'ok', payload: { ok: true, isRepo: false, file: null } };

  const root = opened.root;
  const resolved = await resolveMeta(root);
  if (!resolved.ok) return unavailableMeta(resolved);
  const basePayload = { ok: true, isRepo: true, root, branch: resolved.meta.branch, base: resolved.meta.base, baseKind: resolved.meta.baseKind };
  if (stat && !stat.isFile()) return { kind: 'ok', payload: { ...basePayload, file: null } };

  const canonical = await canonicalize(absolute);
  const relative = path.relative(root, canonical);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { kind: 'ok', payload: { ...basePayload, file: null } };
  }
  if (await escapesRepoViaSymlink(root, canonical)) return { kind: 'ok', payload: { ...basePayload, file: null } };

  const relativePath = relative.split(path.sep).join('/');
  const change = await fileChange(root, resolved.meta.base, relativePath);
  if (change.kind) return change;
  if (!change.found) return { kind: 'ok', payload: { ...basePayload, file: null } };
  return {
    kind: 'ok',
    payload: {
      ...basePayload,
      file: {
        path: relativePath,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        binary: change.binary === true,
        untracked: change.untracked === true,
        changed: true,
      },
    },
  };
}
