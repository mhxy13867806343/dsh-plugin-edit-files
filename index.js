/**
 * dsh-plugin-edit-files —— Host 半边入口。
 *
 * 这个文件只做四件事：声明 name / inject、在 apply() 里把 11 条路由注册进
 * `ctx.connection.fetch`（并记一份调用计数）、挂一个只读 cordis_inspect 自检入口、
 * 把内部工厂 re-export 给自检与外部脚本。业务逻辑都在 lib/ 下，index.js 保持薄装配层。
 *
 * ⚠ inject 必须是数组：`inject: ['connection']`。写成 `{ required: [...] }`
 * 会让插件停在 pending（本机 cordis 的 inject 是数组形式）。
 */

import { createRouter, createRuntime } from './lib/router.js';
import { createDiagnostics } from './lib/diagnostics.js';
import { installInspectProvider } from './lib/inspect.js';

export const name = 'edit-files';
export const inject = ['connection'];

/**
 * @param ctx cordis 上下文（需要 connection 服务）
 * @param config 本机 cordis.patch.yml 里那一行的 config（三个上限都可选）
 */
export function apply(ctx, config = {}) {
  const runtime = createRuntime(config);
  const diagnostics = createDiagnostics(runtime.limits);

  for (const route of createRouter(runtime)) {
    // 包一层记录器：只记路由、方法、状态码、耗时，不碰请求体。
    const fetch = async (request) => {
      const started = Date.now();
      let response;
      try {
        response = await route.fetch(request);
        return response;
      } finally {
        diagnostics.record(route.path, request, response === undefined ? 0 : response.status, Date.now() - started);
      }
    };
    try {
      ctx.connection.fetch.register({
        path: route.path,
        methods: route.methods,
        requestBody: 'buffered',
        fetch,
      });
      diagnostics.noteRegistered(route.path);
      runtime.log(`路由已注册：${route.methods.join('/')} ${route.path}`);
    } catch (error) {
      // 单条路由注册失败不应该带走整插件；日志与自检里都能看出是哪条。
      const message = error && error.message ? error.message : String(error);
      diagnostics.noteFailed(route.path, error);
      runtime.log(`路由注册失败：${route.path} —— ${message}`);
    }
  }

  installInspectProvider(ctx, diagnostics);
}

export { createRouter, createRuntime };
export { createDiagnostics } from './lib/diagnostics.js';
