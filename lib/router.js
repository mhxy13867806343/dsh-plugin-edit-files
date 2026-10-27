/**
 * lib/router.js —— 7 条 HTTP 路由的组装。
 *
 * 这里只做三件事：参数解析（query 与 JSON body 同名字段都收）、
 * 把 git / 文件内核的返回翻译成 HTTP 状态码、把任何异常收成 500 JSON。
 * 业务规则全在 lib/git.js 与 lib/files.js，路由层不重复判断。
 *
 * 每条路由单独注册（历史教训：两条路径塞进一个 handler，最终只有第一条能被服务）。
 */

import path from 'node:path';

import { API_PREFIX, PLUGIN_NAME, PLUGIN_VERSION, normalizeConfig } from './config.js';
import { gitChanges, gitDiff, gitFile, gitInfo } from './git.js';
import { readFileForEditor, writeFileForEditor } from './files.js';

const ROUTE_PATHS = Object.freeze([
  `${API_PREFIX}/health`,
  `${API_PREFIX}/git/info`,
  `${API_PREFIX}/git/changes`,
  `${API_PREFIX}/git/diff`,
  `${API_PREFIX}/git/file`,
  `${API_PREFIX}/file/read`,
  `${API_PREFIX}/file/write`,
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

export function createRuntime(config = {}) {
  const limits = normalizeConfig(config);
  const log = (message) => {
    try {
      console.info(`[edit-files] ${message}`);
    } catch {
      /* 没有控制台也不影响功能 */
    }
  };
  return { limits, log };
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
  ];
}
