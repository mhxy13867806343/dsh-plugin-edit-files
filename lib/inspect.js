/**
 * lib/inspect.js —— 把诊断账本暴露成一个只读的 cordis_inspect 提供者（Host 平台）。
 *
 * 用法（agent 侧）：
 *   cordis_inspect_query({ platform: 'host', provider: 'EditFiles', method: 'status' })
 *
 * 依赖的 `cordisInspect` 是 Host 的普通服务；用 ctx.inject 可选等待，
 * 没装这个服务时插件照常工作，只是没有自检入口。
 */

export function installInspectProvider(ctx, diagnostics) {
  ctx.inject(['cordisInspect'], (inspectCtx) => {
    const registry = inspectCtx.cordisInspect;
    if (registry === undefined || registry === null || typeof registry.register !== 'function') return () => {};
    return ctx.effect(
      () =>
        registry.register({
          manifest: {
            id: 'EditFiles',
            description:
              'dsh-plugin-edit-files 的只读自检：返回 Host 路由注册结果与浏览器真实调用计数，用于确认右侧预览的编辑/Git 入口是否真的打到了 Host。',
            methods: [
              {
                name: 'status',
                description: 'Return plugin boot state, registered routes, and per-route browser call counters.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                outputSchema: { description: 'Boot state, registered routes, and request counters.' },
              },
            ],
          },
          async query(method) {
            if (method !== 'status') throw new Error(`unknown EditFiles inspect method "${String(method)}"`);
            return diagnostics.snapshot();
          },
        }),
      'edit-files: inspect provider',
    );
  });
}
