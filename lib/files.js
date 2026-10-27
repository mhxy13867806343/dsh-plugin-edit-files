/**
 * lib/files.js —— 编辑器用的单文件读写内核 + 工程文件的创建/重命名/删除内核。
 *
 * 读：只认普通文件，先按大小闸门再读盘；二进制用「前 8 KiB 出现 \0」+「UTF-8 解码替换符过多」两道判定。
 * 写：乐观并发（expectedMtimeMs）→ 内容一致直接返回 unchanged → 同目录临时文件 + rename 原子落盘。
 * 增删改：root 与 rel 先过统一的安全校验（绝对路径、..、.git、符号链接逃逸、root 本身），
 *         再落 fs 操作；所有失败都返回 { kind } 让 router 映射状态码，不抛到路由之外。
 * 这些规则来自 docs/route-contract.md，改之前先把契约改了。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const BINARY_PROBE_BYTES = 8192;
const MAX_REPLACEMENT_RATIO = 0.1;

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** 首个 \n 之前有没有 \r 只是起点；这里逐行统计，才能区分「整份 CRLF」与「混着来」。 */
export function detectEol(text) {
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    if (index > 0 && text[index - 1] === '\r') crlf += 1;
    else lf += 1;
  }
  if (crlf > 0 && lf > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

function hasNulByte(buffer) {
  return buffer.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

/** 合法的 UTF-8 文本不该出现 U+FFFD；比例过高说明其实是二进制被当文本解码了。 */
function replacementRatio(text) {
  if (!text.includes('\uFFFD')) return 0;
  let count = 0;
  for (const char of text) if (char === '\uFFFD') count += 1;
  return count / text.length;
}

/**
 * 读取一个路径的文本内容。
 * `truncate: true` 用于 diff 的未跟踪文件预览：超过上限不报错，只读前 maxBytes 并标记 truncated。
 * 返回 { kind: 'ok', binary, text, bom, eol, size, mtimeMs, mode, truncated } | { kind: 'not-found' | 'not-regular-file' | 'too-large' }。
 */
export async function readTextFile(absPath, maxBytes, options = {}) {
  const truncate = options.truncate === true;
  const stat = await statOrNull(absPath);
  if (!stat) return { kind: 'not-found' };
  if (!stat.isFile()) return { kind: 'not-regular-file' };
  if (!truncate && stat.size > maxBytes) return { kind: 'too-large', size: stat.size, limit: maxBytes };

  let buffer;
  let truncated = false;
  if (stat.size > maxBytes) {
    // 超大文件只读上限以内，避免把内存吃满（diff 的 newText 走这条路）
    const handle = await fs.open(absPath, 'r');
    try {
      const chunk = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(chunk, 0, maxBytes, 0);
      buffer = chunk.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    truncated = true;
  } else {
    buffer = await fs.readFile(absPath);
  }

  const binary = hasNulByte(buffer);
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const body = bom ? buffer.subarray(3) : buffer;
  const text = body.toString('utf8');
  const invalidUtf8 = replacementRatio(text) > MAX_REPLACEMENT_RATIO;
  if (binary || invalidUtf8) {
    return { kind: 'ok', binary: true, text: null, bom, eol: 'lf', size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777, truncated };
  }
  return {
    kind: 'ok',
    binary: false,
    text,
    bom,
    eol: detectEol(text),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode & 0o777,
    truncated,
  };
}

/** `POST /file/read` 的业务半边：失败原因原样交给 router 映射状态码。 */
export async function readFileForEditor(absPath, limits) {
  const result = await readTextFile(absPath, limits.maxFileBytes);
  if (result.kind !== 'ok') return result;
  if (result.binary) return { kind: 'binary' };
  return {
    kind: 'ok',
    payload: {
      ok: true,
      path: absPath,
      content: result.text,
      size: result.size,
      mtimeMs: result.mtimeMs,
      eol: result.eol,
      bom: result.bom,
      mode: result.mode,
    },
  };
}

function normalizeExpectedMtime(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isTruthyFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/** `POST /file/write` 的业务半边：把契约里那几种拒绝原因都变成返回值，不抛异常。 */
export async function writeFileForEditor(options) {
  const { absPath, content, expectedMtimeMs, eol, bom, force, maxFileBytes } = options;
  if (typeof content !== 'string') return { kind: 'invalid-content' };

  // 符号链接要写到它指向的真文件上，否则 rename 会把链接本身换成普通文件。
  let target = absPath;
  let existing = null;
  const linkStat = await lstatOrNull(absPath);
  if (linkStat && linkStat.isSymbolicLink()) {
    const real = await fs.realpath(absPath).catch((error) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (real) {
      const realStat = await statOrNull(real);
      if (!realStat || !realStat.isFile()) return { kind: 'not-regular-file' };
      target = real;
      existing = realStat;
    }
  } else if (linkStat) {
    if (!linkStat.isFile()) return { kind: 'not-regular-file' };
    existing = linkStat;
  }

  const parent = path.dirname(target);
  const parentStat = await statOrNull(parent);
  if (!parentStat || !parentStat.isDirectory()) return { kind: 'no-parent' };

  const forceWrite = isTruthyFlag(force);
  const expected = normalizeExpectedMtime(expectedMtimeMs);
  if (existing && expected !== null && !forceWrite && Math.abs(existing.mtimeMs - expected) > 1) {
    return { kind: 'conflict', currentMtimeMs: existing.mtimeMs };
  }

  let text = content;
  if (isTruthyFlag(bom) && !text.startsWith('\uFEFF')) text = `\uFEFF${text}`;
  if (eol === 'crlf') text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const data = Buffer.from(text, 'utf8');
  if (data.length > maxFileBytes) return { kind: 'too-large', limit: maxFileBytes };

  if (existing && existing.size === data.length) {
    const current = await fs.readFile(target);
    if (current.equals(data)) {
      return {
        kind: 'ok',
        payload: {
          ok: true,
          path: absPath,
          mtimeMs: existing.mtimeMs,
          size: existing.size,
          bytes: data.length,
          created: false,
          unchanged: true,
        },
      };
    }
  }

  const created = existing === null;
  const mode = existing ? existing.mode & 0o777 : 0o666 & ~process.umask();
  const tempPath = path.join(parent, `.dsh-edit-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tempPath, data, { mode });
    // 上面那次 mode 会被进程 umask 打折；这里补一次 chmod，保证原文件权限位原样保留。
    await fs.chmod(tempPath, mode);
    await fs.rename(tempPath, target);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  const stat = await fs.stat(target);
  return {
    kind: 'ok',
    payload: {
      ok: true,
      path: absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      bytes: data.length,
      created,
      unchanged: false,
    },
  };
}

// ─────────────────────────────────────────── 工程文件：root / rel 校验与增删改

/** 目录根校验：必须是绝对路径、存在、且是目录；同时拿到 realpath 做越界判定。 */
export async function resolveRootDir(rootInput) {
  if (typeof rootInput !== 'string' || rootInput.length === 0) return { kind: 'missing-root' };
  if (!path.isAbsolute(rootInput)) return { kind: 'invalid-path', field: 'root' };
  const root = path.resolve(rootInput);
  const stat = await statOrNull(root);
  if (!stat) return { kind: 'not-found', field: 'root' };
  if (!stat.isDirectory()) return { kind: 'not-directory', field: 'root' };
  const realRoot = await fs.realpath(root);
  return { kind: 'ok', root, realRoot };
}

/**
 * 相对路径校验（安全规则的总入口）：
 * - 只接受相对路径；绝对路径、含 NUL → invalid-path；
 * - 任意一段是 `..` → outside-root（先拒绝，再谈规范化）；
 * - 任意一段是 `.git`（大小写不敏感，含文件/目录）→ protected-path；
 * - `.` 与空段直接丢掉；去完变空 → empty-rel（delete 映射 root-itself，其它映射 missing-rel）。
 */
export function normalizeRelPath(relInput) {
  if (typeof relInput !== 'string') return { kind: 'missing-rel' };
  if (relInput.includes('\0')) return { kind: 'invalid-path' };
  if (path.isAbsolute(relInput)) return { kind: 'invalid-path' };
  const segments = [];
  for (const segment of relInput.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { kind: 'outside-root' };
    if (segment.toLowerCase() === '.git') return { kind: 'protected-path' };
    segments.push(segment);
  }
  if (segments.length === 0) return { kind: 'empty-rel' };
  return { kind: 'ok', rel: segments.join('/'), segments };
}

function isInsideRealRoot(realRoot, realPath) {
  const relative = path.relative(realRoot, realPath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** 已存在路径的 realpath 若跑出 root，说明是符号链接逃逸；悬空链接按「操作链接本身」放行。 */
async function realPathEscapesRoot(realRoot, absolutePath) {
  let real;
  try {
    real = await fs.realpath(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
  return !isInsideRealRoot(realRoot, real);
}

/** rename 的 to / create 的目标还不存在，防的是父目录本身是逃逸符号链接。 */
async function parentRealPathEscapesRoot(realRoot, absolutePath) {
  let real;
  try {
    real = await fs.realpath(path.dirname(absolutePath));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
  return !isInsideRealRoot(realRoot, real);
}

/** 创建文件/目录。返回 { kind:'ok', payload } 或失败 kind（router 负责映射状态码）。 */
export async function createEntry(options) {
  const rootRes = await resolveRootDir(options.root);
  if (rootRes.kind !== 'ok') return rootRes;
  const relRes = normalizeRelPath(options.rel);
  if (relRes.kind === 'empty-rel') return { kind: 'missing-rel' };
  if (relRes.kind !== 'ok') return relRes;

  const kind = options.kind === 'dir' ? 'dir' : 'file';
  let content = '';
  if (kind === 'file') {
    if (options.content !== undefined && options.content !== null) {
      if (typeof options.content !== 'string') return { kind: 'invalid-path', field: 'content' };
      content = options.content;
    }
    if (Buffer.byteLength(content, 'utf8') > options.maxFileBytes) return { kind: 'too-large', limit: options.maxFileBytes };
  }

  const target = path.join(rootRes.root, ...relRes.segments);
  if (await lstatOrNull(target)) return { kind: 'already-exists' };
  const parentStat = await statOrNull(path.dirname(target));
  if (!parentStat || !parentStat.isDirectory()) return { kind: 'no-parent' };
  if (await parentRealPathEscapesRoot(rootRes.realRoot, target)) return { kind: 'outside-root' };

  try {
    if (kind === 'dir') {
      await fs.mkdir(target);
    } else {
      // flag 'wx'：并发下也不会覆盖别人刚建出来的同名文件
      await fs.writeFile(target, content, { encoding: 'utf8', flag: 'wx', mode: 0o666 & ~process.umask() });
    }
  } catch (error) {
    if (error.code === 'EEXIST') return { kind: 'already-exists' };
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { kind: 'no-parent' };
    throw error;
  }
  return { kind: 'ok', payload: { ok: true, rel: relRes.rel, kind } };
}

/** 重命名 / 移动（都在 root 内）。 */
export async function renameEntry(options) {
  const rootRes = await resolveRootDir(options.root);
  if (rootRes.kind !== 'ok') return rootRes;
  const fromRes = normalizeRelPath(options.from);
  if (fromRes.kind === 'empty-rel') return { kind: 'missing-rel' };
  if (fromRes.kind !== 'ok') return fromRes;
  const toRes = normalizeRelPath(options.to);
  if (toRes.kind === 'empty-rel') return { kind: 'missing-rel' };
  if (toRes.kind !== 'ok') return toRes;

  const fromAbs = path.join(rootRes.root, ...fromRes.segments);
  const toAbs = path.join(rootRes.root, ...toRes.segments);
  const fromStat = await lstatOrNull(fromAbs);
  if (!fromStat) return { kind: 'not-found' };
  if (await realPathEscapesRoot(rootRes.realRoot, fromAbs)) return { kind: 'outside-root' };
  if (await lstatOrNull(toAbs)) return { kind: 'target-exists' };
  const toParentStat = await statOrNull(path.dirname(toAbs));
  if (!toParentStat || !toParentStat.isDirectory()) return { kind: 'no-parent' };
  if (await parentRealPathEscapesRoot(rootRes.realRoot, toAbs)) return { kind: 'outside-root' };

  // 目录不能移进自己内部（fs.rename 会回 EINVAL，提前给出明确的 invalid-path）
  if (fromStat.isDirectory()) {
    const inside = path.relative(fromAbs, toAbs);
    if (inside !== '' && inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside)) {
      return { kind: 'invalid-path', field: 'to' };
    }
  }

  try {
    await fs.rename(fromAbs, toAbs);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') return { kind: 'target-exists' };
    if (error.code === 'ENOENT') return { kind: 'not-found' };
    if (error.code === 'EINVAL' || error.code === 'EXDEV') return { kind: 'invalid-path', field: 'to' };
    throw error;
  }
  return { kind: 'ok', payload: { ok: true, from: fromRes.rel, to: toRes.rel } };
}

/** 删除文件/符号链接/目录（目录必须显式 recursive）。 */
export async function deleteEntry(options) {
  const rootRes = await resolveRootDir(options.root);
  if (rootRes.kind !== 'ok') return rootRes;
  const relRes = normalizeRelPath(options.rel);
  if (relRes.kind === 'empty-rel') return { kind: 'root-itself' };
  if (relRes.kind !== 'ok') return relRes;

  const target = path.join(rootRes.root, ...relRes.segments);
  const stat = await lstatOrNull(target);
  if (!stat) return { kind: 'not-found' };
  if (await realPathEscapesRoot(rootRes.realRoot, target)) return { kind: 'outside-root' };

  // lstat：符号链接不算目录，删的是链接本身（不跟随到目标）
  const isDirectory = stat.isDirectory();
  if (isDirectory && options.recursive !== true) return { kind: 'is-directory-needs-recursive' };

  try {
    await fs.rm(target, { recursive: isDirectory, force: false });
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'not-found' };
    if (error.code === 'ENOTEMPTY') return { kind: 'is-directory-needs-recursive' };
    throw error;
  }
  return { kind: 'ok', payload: { ok: true, rel: relRes.rel, recursive: isDirectory } };
}
