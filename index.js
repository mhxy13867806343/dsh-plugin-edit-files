/**
 * dsh-plugin-edit-files —— Host 半边入口。
 *
 * 这个文件只做三件事：声明 name / inject、在 apply() 里把 7 条路由注册进
 * `ctx.connection.fetch`、把内部工厂 re-export 给自检与外部脚本。
 * 业务逻辑都在 lib/ 下，index.js 保持薄装配层 —— 自检脚本不依赖 cordis 也能跑。
 *
 * ⚠ inject 必须是数组：`inject: ['connection']`。写成 `{ required: [...] }`
 * 会让插件停在 pending（本机 cordis 的 inject 是数组形式）。
 */

import { createRouter, createRuntime } from './lib/router.js';

export const name = 'edit-files';
export const inject = ['connection'];

/**
 * @param ctx cordis 上下文（需要 connection 服务）
 * @param config 本机 cordis.patch.yml 里那一行的 config（三个上限都可选）
 */
export function apply(ctx, config = {}) {
  const runtime = createRuntime(config);
  for (const route of createRouter(runtime)) {
    try {
      ctx.connection.fetch.register({
        path: route.path,
        methods: route.methods,
        requestBody: 'buffered',
        fetch: route.fetch,
      });
      runtime.log(`路由已注册：${route.methods.join('/')} ${route.path}`);
    } catch (error) {
      // 单条路由注册失败不应该带走整插件；日志里能看出是哪条。
      const message = error && error.message ? error.message : String(error);
      runtime.log(`路由注册失败：${route.path} —— ${message}`);
    }
  }
}

export { createRouter, createRuntime };
