/**
 * lib/diagnostics.js —— 只读自检账本。
 *
 * 为什么需要它：这个插件的客户端按钮是「fetch 不到就静默不显示」的软失败风格，
 * 所以「按钮没出现」时只看界面分不清是 Host 路由没注册、还是客户端根本没渲染。
 * 这里把「启动时注册了哪些路由 / 注册失败原因」和「浏览器实际打进来的请求计数」
 * 记在内存里，再通过 cordis_inspect 的 EditFiles 提供者读出来 —— 一眼定位。
 *
 * 只保存最近 50 条请求与累计计数，不写磁盘、不含请求体。
 */

const MAX_RECENT_HITS = 50;

/**
 * @param {Record<string, number>} limits 当前生效的三个上限，随快照回传方便排障
 */
export function createDiagnostics(limits) {
  const startedAt = new Date().toISOString();
  const registered = [];
  const failed = [];
  const recentHits = [];
  const byRoute = new Map();
  let totalHits = 0;

  return {
    /** 路由注册成功。 */
    noteRegistered(routePath) {
      registered.push(routePath);
    },

    /** 路由注册抛错（插件会继续注册其它路由，这里留下原因）。 */
    noteFailed(routePath, error) {
      failed.push({ route: routePath, error: error && error.message ? error.message : String(error) });
    },

    /** 记录一次真实的 HTTP 调用（浏览器或 curl 都算）。 */
    record(routePath, request, status, elapsedMs) {
      totalHits += 1;
      byRoute.set(routePath, (byRoute.get(routePath) || 0) + 1);
      recentHits.push({
        at: new Date().toISOString(),
        route: routePath,
        method: request && typeof request.method === 'string' ? request.method : 'GET',
        status,
        ms: elapsedMs,
      });
      if (recentHits.length > MAX_RECENT_HITS) recentHits.shift();
    },

    /** 供 cordis_inspect 读取的一份快照。 */
    snapshot() {
      return {
        plugin: 'dsh-plugin-edit-files',
        startedAt,
        limits: { ...limits },
        registeredRoutes: registered.slice(),
        registrationFailures: failed.slice(),
        totalHits,
        hitsByRoute: Object.fromEntries(byRoute),
        recentHits: recentHits.slice().reverse(),
      };
    },
  };
}
