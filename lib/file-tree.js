/**
 * lib/file-tree.js —— 工程文件树（只读）。
 *
 * 为什么单开一个模块：tree 是唯一一条「一次读很多目录」的路由，遍历策略（不跟随符号链接、
 * 忽略目录、条目上限、忽略名单回传）与单文件读写是两回事，混在 files.js 里会越来越难读。
 *
 * 实现要点：
 * - 用显式栈迭代而不是递归，深目录不会爆栈；
 * - 符号链接只当条目返回，绝不展开（避免目录环）；
 * - 目录名排序后再遍历，截断结果稳定可复现；
 * - 条目平铺返回，每条带 `dir`（相对 root 的父目录）——前端按 cwd 过滤就能逐层浏览。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveRootDir } from './files.js';

const GIT_ENTRY = '.git';

function compareNames(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * @param {object} options
 * @param {string} options.root 绝对目录
 * @param {boolean} [options.includeIgnored] 是否展开 treeIgnores 里的目录（.git 永远跳过）
 * @param {number|null} [options.limit] 请求方要求的上限（只能比 maxTreeEntries 更小）
 * @param {number} options.maxTreeEntries 配置上限
 * @param {string[]} options.treeIgnores 默认忽略的目录名
 * @returns {Promise<{kind:'ok',payload:object}|{kind:string}>}
 */
export async function listFileTree(options) {
  const { root: rootInput, includeIgnored = false, limit = null, maxTreeEntries, treeIgnores = [] } = options;
  const rootRes = await resolveRootDir(rootInput);
  if (rootRes.kind !== 'ok') return rootRes;
  const root = rootRes.root;

  const ignoreNames = new Set(treeIgnores);
  const requestedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
  // 请求 limit 只能把上限调小，不能绕过配置里的 maxTreeEntries
  const effectiveLimit = Math.max(1, Math.min(requestedLimit ?? maxTreeEntries, maxTreeEntries));

  const entries = [];
  const skippedNames = new Set();
  let truncated = false;

  const stack = [{ absolute: root, dirParts: [] }];
  while (stack.length > 0 && !truncated) {
    const dir = stack.pop();
    let dirents;
    try {
      dirents = await fs.readdir(dir.absolute, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      // 根目录读不了是硬错误（让 guard 出 500）；深层目录读不了就跳过，别让整棵树失败
      if (dir.dirParts.length === 0) throw error;
      continue;
    }
    dirents.sort((left, right) => compareNames(left.name, right.name));

    for (const dirent of dirents) {
      const name = dirent.name;
      const isGitEntry = name.toLowerCase() === GIT_ENTRY;
      const isIgnoredDir = dirent.isDirectory() && ignoreNames.has(name);
      if (isGitEntry || (isIgnoredDir && includeIgnored !== true)) {
        skippedNames.add(name);
        continue;
      }
      if (entries.length >= effectiveLimit) {
        truncated = true;
        break;
      }

      const relativeParts = [...dir.dirParts, name];
      const absolute = path.join(dir.absolute, name);
      let type = 'file';
      if (dirent.isDirectory()) type = 'dir';
      else if (dirent.isSymbolicLink()) type = 'symlink';

      let size = 0;
      let mtimeMs = 0;
      try {
        const stat = await fs.lstat(absolute);
        mtimeMs = stat.mtimeMs;
        // 目录与符号链接按契约固定回 0，前端不拿它做大小排序
        if (type === 'file') size = stat.size;
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; // 遍历期间被删掉了
        throw error;
      }

      entries.push({ rel: relativeParts.join('/'), name, dir: dir.dirParts.join('/'), type, size, mtimeMs });
      // 只有真目录继续展开；symlink 即使是目录链接也不跟随
      if (type === 'dir') stack.push({ absolute, dirParts: relativeParts });
    }
  }

  entries.sort((left, right) => compareNames(left.rel, right.rel));
  let files = 0;
  let dirs = 0;
  for (const entry of entries) {
    if (entry.type === 'dir') dirs += 1;
    else files += 1;
  }

  // ignored：实际被跳过的忽略目录名。按 treeIgnores 的配置顺序回传（更贴近配置直觉），
  // 不在配置列表里的名字（例如自定义忽略列表没写 .git）追加到末尾。
  const ignored = [];
  for (const name of treeIgnores) {
    if (skippedNames.has(name) && !ignored.includes(name)) ignored.push(name);
  }
  for (const name of skippedNames) {
    if (!ignored.includes(name)) ignored.push(name);
  }

  return {
    kind: 'ok',
    payload: {
      ok: true,
      root,
      entries,
      counts: { files, dirs },
      truncated,
      ignored,
      // 前端截断提示要显示「只显示前 N 条」；契约主形状之外的辅助字段
      limit: effectiveLimit,
    },
  };
}
