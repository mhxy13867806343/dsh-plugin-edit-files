/**
 * lib/router.js —— 11 条 HTTP 路由的组装（7 条 git/单文件 + 4 条工程文件浏览/增删改）。
 *
 * 这里只做三件事：参数解析、把内核返回翻译成 HTTP 状态码、把任何异常收成 500 JSON。
 * 业务规则全在 lib/git.js、lib/files.js、lib/file-tree.js，路由层不重复判断。
 *
 * 三条写路由（files/create、files/rename、files/delete）只认 JSON body、不读 query：
 * 写操作不能被一个 URL 触发；body 缺失/不是 JSON 对象一律 400 missing-json。
 *
 * 每条路由单独注册（历史教训：两条路径塞进一个 handler，最终只有第一条能被服务）。
 */

import path from 'node:path';

import { API_PREFIX, PLUGIN_NAME, PLUGIN_VERSION, normalizeConfig } from './config.js';
import { gitChanges, gitDiff, gitFile, gitInfo } from './git.js';
import { createEntry, deleteEntry, readFileForEditor, renameEntry, writeFileForEditor } from './files.js';
import { listFileTree } from './file-tree.js';

const ROUTE_PATHS = Object.freeze([
  `${API_PREFIX}/health`,
  `${API_PREFIX}/git/info`,
  `${API_PREFIX}/git/changes`,
  `${API_PREFIX}/git/diff`,
  `${API_PREFIX}/git/file`,
  `${API_PREFIX}/file/read`,
  `${API_PREFIX}/file/write`,
  `${API_PREFIX}/files/tree`,
  `${API_PREFIX}/files/create`,
  `${API_PREFIX}/files/rename`,
  `${API_PREFIX}/files/delete`,
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function fail(status, reason, extra = {}) {
  return json({ ok: false, reason, ...extra }, status);
}

/** 参数：GET 从 query 取、POST 从 JSON body 取；同名字段两种都接受（命令行 curl 更省事）。 */
async function paramsOf(request) {
  const params = {};
  try {
    for (const [key, value] of new URL(request.url).searchParams) params[key] = value;
  } catch {
    /* URL 畸形：只当没有 query，后面的缺参检查会给出 400 */
  }
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      if (body && typeof body === 'object' && !Array.isArray(body)) Object.assign(params, body);
    } catch {
      /* 没有 body 或 body 不是合法 JSON：仅用 query */
    }
  }
  return params;
}

function guard(handler) {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      return json({ ok: false, reason: 'error', error: message }, 500);
    }
  };
}

function resultOfPath(params) {
  return typeof params.path === 'string' ? params.path.trim() : '';
}

function gitFailure(result) {
  switch (result.kind) {
    case 'missing-path':
      return fail(400, 'missing-path');
    case 'missing-file':
      return fail(400, 'missing-file');
    case 'outside-repo':
      return fail(400, 'outside-repo');
    case 'not-found':
      return fail(404, 'not-found');
    case 'not-repo':
      return fail(400, 'not-a-repo');
    case 'git-unavailable':
      return fail(503, 'git-unavailable', { error: result.error ?? null });
    case 'git-failed':
      return fail(500, 'git-failed', { error: result.error ?? null });
    default:
      return fail(500, 'error');
  }
}

/** 工程文件四条路由的 reason → HTTP 状态码映射。 */
const FILE_FAILURE_STATUS = Object.freeze({
  'missing-root': 400,
  'missing-rel': 400,
  'missing-json': 400,
  'invalid-path': 400,
  'outside-root': 400,
  'not-found': 404,
  'not-directory': 400,
  'no-parent': 400,
  'already-exists': 409,
  'target-exists': 409,
  'is-directory-needs-recursive': 409,
  'root-itself': 400,
  'protected-path': 403,
  'too-large': 413,
});

function fileFailure(result) {
  const status = FILE_FAILURE_STATUS[result.kind] ?? 500;
  const extra = {};
  if (result.limit !== undefined) extra.limit = result.limit;
  return fail(status, result.kind ?? 'error', extra);
}

function isTruthyParam(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/** 请求 limit：只认正整数，其它一律当没给（配置上限兜底）。 */
function positiveLimitParam(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return null;
  return Math.floor(number);
}

/** 写路由专用：必须有合法 JSON object body，否则 null（→ 400 missing-json）。 */
async function postJsonBody(request) {
  try {
    const body = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    /* 没 body / 不是合法 JSON */
  }
  return null;
}

export function createRuntime(config = {}) {
  const normalized = normalizeConfig(config);
  // limits 保持原来的三键形状（health 与诊断账本都按它走）；文件树配置单独挂一层
  const { maxTreeEntries, treeIgnores, ...limits } = normalized;
  const tree = { maxTreeEntries, treeIgnores };
  const log = (message) => {
    try {
      console.info(`[edit-files] ${message}`);
    } catch {
      /* 没有控制台也不影响功能 */
    }
  };
  return { limits, tree, log };
}

export function createRouter(runtime) {
  const limits = runtime.limits;

  return [
    {
      path: ROUTE_PATHS[0],
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guard(async () =>
        json({
          ok: true,
          name: PLUGIN_NAME,
          version: PLUGIN_VERSION,
          routes: [...ROUTE_PATHS],
          limits: { ...limits },
        }),
      ),
    },
    {
      path: ROUTE_PATHS[1],
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const params = await paramsOf(request);
        const input = resultOfPath(params);
        if (!input) return fail(400, 'missing-path');
        const result = await gitInfo(input);
        if (result.kind === 'ok') return json(result.payload);
        if (result.kind === 'not-repo') return json({ ok: true, isRepo: false, path: input });
        return gitFailure(result);
      }),
    },
    {
      path: ROUTE_PATHS[2],
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const params = await paramsOf(request);
        const input = resultOfPath(params);
        if (!input) return fail(400, 'missing-path');
        const result = await gitChanges(input, limits);
        if (result.kind === 'ok') return json(result.payload);
        if (result.kind === 'not-repo') return json({ ok: true, isRepo: false });
        return gitFailure(result);
      }),
    },
    {
      path: ROUTE_PATHS[3],
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const params = await paramsOf(request);
        const input = resultOfPath(params);
        if (!input) return fail(400, 'missing-path');
        const file = typeof params.file === 'string' ? params.file : '';
        if (!file) return fail(400, 'missing-file');
        const result = await gitDiff(input, file, limits);
        if (result.kind === 'ok') return json(result.payload);
        return gitFailure(result);
      }),
    },
    {
      path: ROUTE_PATHS[4],
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const params = await paramsOf(request);
        const input = resultOfPath(params);
        if (!input) return fail(400, 'missing-path');
        const result = await gitFile(input);
        if (result.kind === 'ok') return json(result.payload);
        return gitFailure(result);
      }),
    },
    {
      path: ROUTE_PATHS[5],
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const params = await paramsOf(request);
        const input = resultOfPath(params);
        if (!input) return fail(400, 'missing-path');
        const result = await readFileForEditor(path.resolve(input), limits);
        switch (result.kind) {
          case 'ok':
            return json(result.payload);
          case 'not-found':
            return fail(404, 'not-found');
          case 'not-regular-file':
            return fail(400, 'not-regular-file');
          case 'too-large':
            return fail(413, 'too-large', { size: result.size, limit: result.limit });
          case 'binary':
            return fail(415, 'binary');
          default:
            return fail(500, 'error');
        }
      }),
    },
    {
      path: ROUTE_PATHS[6],
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const params = await paramsOf(request);
        const input = resultOfPath(params);
        if (!input) return fail(400, 'missing-path');
        if (typeof params.content !== 'string') return fail(400, 'missing-content');
        const result = await writeFileForEditor({
          absPath: path.resolve(input),
          content: params.content,
          expectedMtimeMs: params.expectedMtimeMs,
          eol: params.eol,
          bom: params.bom,
          force: params.force,
          maxFileBytes: limits.maxFileBytes,
        });
        switch (result.kind) {
          case 'ok':
            return json(result.payload);
          case 'conflict':
            return fail(409, 'conflict', { currentMtimeMs: result.currentMtimeMs });
          case 'too-large':
            return fail(413, 'too-large', { limit: result.limit });
          case 'no-parent':
            return fail(400, 'no-parent');
          case 'not-regular-file':
            return fail(400, 'not-regular-file');
          case 'invalid-content':
            return fail(400, 'missing-content');
          default:
            return fail(500, 'error');
        }
      }),
    },
    {
      // 工程文件树（只读）：GET + query，递归平铺返回。
      path: ROUTE_PATHS[7],
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const params = await paramsOf(request);
        const root = typeof params.root === 'string' ? params.root : '';
        if (root.length === 0) return fail(400, 'missing-root');
        const result = await listFileTree({
          root,
          includeIgnored: isTruthyParam(params.includeIgnored),
          limit: positiveLimitParam(params.limit),
          maxTreeEntries: runtime.tree.maxTreeEntries,
          treeIgnores: runtime.tree.treeIgnores,
        });
        if (result.kind === 'ok') return json(result.payload);
        return fileFailure(result);
      }),
    },
    {
      // 新建文件/目录：body 必须 JSON，rel 相对 root。
      path: ROUTE_PATHS[8],
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const body = await postJsonBody(request);
        if (body === null) return fail(400, 'missing-json');
        const result = await createEntry({
          root: body.root,
          rel: body.rel,
          kind: body.kind,
          content: body.content,
          maxFileBytes: limits.maxFileBytes,
        });
        if (result.kind === 'ok') return json(result.payload);
        return fileFailure(result);
      }),
    },
    {
      // 重命名 / 移动：body 必须 JSON，from/to 都必须留在 root 内。
      path: ROUTE_PATHS[9],
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const body = await postJsonBody(request);
        if (body === null) return fail(400, 'missing-json');
        const result = await renameEntry({ root: body.root, from: body.from, to: body.to });
        if (result.kind === 'ok') return json(result.payload);
        return fileFailure(result);
      }),
    },
    {
      // 删除：body 必须 JSON；目录必须 recursive:true。
      path: ROUTE_PATHS[10],
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const body = await postJsonBody(request);
        if (body === null) return fail(400, 'missing-json');
        const result = await deleteEntry({ root: body.root, rel: body.rel, recursive: body.recursive === true });
        if (result.kind === 'ok') return json(result.payload);
        return fileFailure(result);
      }),
    },
  ];
}
