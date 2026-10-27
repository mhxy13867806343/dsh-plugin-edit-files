/**
 * dsh-plugin-edit-files —— Client 半边。
 *
 * 两件事：
 *   ① 右侧文档预览工具栏加「编辑」：浮层文本编辑器，⌘S 保存，带 mtime 乐观并发与冲突处理；
 *   ② 「Git 改动」右栏标签页：本地工作区 vs 远程基准（上游分支），只列真正不同的文件，
 *      点文件看 unified diff，支持从头文件数徽标 / 会话「...」菜单 / 文件树工具栏进入。
 *
 * 自我约束（和本机其它纯 JS 插件一致）：
 *   · 只 require('react')，不 import 任何 @deepseek-ai/* 客户端包；
 *   · 只用 --dsw-alias-* 主题令牌 + 兜底色，深浅色都不白屏；
 *   · 任何一块渲染都可能读不到数据 —— 全部走「软失败」，只显示一行错，不抛到 slot 外。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-edit-files',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

    // ───────────────────────────────────────────────────────── 常量

    /** 本插件的 locale 命名空间，同时也是 Host 侧插件名。 */
    const NS = 'dsh-plugin-edit-files';
    /** Host 路由前缀（见 docs/route-contract.md）。 */
    const API = '/api/edit-files';
    /** 「Git 改动」页在 tab 系统里的实现 id（正文与标题都注册在它下面）。 */
    const TAB_ID = 'dsh-plugin-edit-files/git';
    /** tab kind：页类型，按 kind 打开。 */
    const TAB_KIND = 'edit-files-git';
    const LOG = '[edit-files] ';

    // ───────────────────────────────────────────────────────── 文案

    const ZH = {
      'action.edit': '编辑',
      'action.editTitle': '在本窗口直接编辑这个文件',
      'action.git': 'Git 改动',
      'action.gitTitle': '查看本地与远程的差异',
      'action.save': '保存',
      'action.revert': '还原',
      'action.reload': '重新读取',
      'action.close': '关闭',
      'action.wrap': '自动换行',
      'action.refresh': '刷新',
      'action.overwrite': '仍然覆盖保存',
      'action.discard': '放弃修改',
      'action.keepEditing': '继续编辑',
      'action.loadDisk': '载入磁盘版本',
      'action.editThisFile': '编辑这个文件',
      'action.retry': '重试',

      'editor.title': '编辑文件',
      'editor.loading': '正在读取文件…',
      'editor.unsaved': '未保存',
      'editor.saving': '保存中…',
      'editor.saved': '已保存',
      'editor.dirtyPrompt': '有未保存的修改，确定关闭吗？',
      'editor.switchPrompt': '当前文件还有未保存的修改，切换会丢弃它们。',
      'editor.reloadPrompt': '重新从磁盘读取会丢弃当前修改，继续吗？',
      'editor.conflict': '磁盘上的文件已被改动，直接保存会覆盖那次修改。',
      'editor.chars': '{n} 字符',
      'editor.lines': '{n} 行',
      'editor.binary': '这是二进制文件，文本编辑器打不开。',
      'editor.tooLarge': '文件超过编辑上限（{limit}）。',
      'editor.notFound': '文件不存在。',
      'editor.notRegular': '这不是普通文件。',
      'editor.conflictReloaded': '已载入磁盘上的最新版本。',
      'editor.savedAt': '已保存',

      'git.tabTitle': 'Git 改动',
      'git.loading': '正在读取 git 状态…',
      'git.error': '读取 git 状态失败',
      'git.noGit': '这台机器上找不到 git 命令',
      'git.notRepo': '当前目录不是 git 仓库',
      'git.notRepoHint': '在有 .git 的目录里才会出现这个入口。',
      'git.clean': '与远程一致，没有本地改动',
      'git.cleanHint': '改回与远程一样的文件会自动从列表里消失。',
      'git.files': '{n} 个文件',
      'git.base': '对比 {base}',
      'git.baseHead': '对比 HEAD（这个仓库没有上游远程分支）',
      'git.ahead': '领先 {n}',
      'git.behind': '落后 {n}',
      'git.binary': '二进制文件，不展示文本差异',
      'git.truncated': '内容过长，已截断',
      'git.untracked': '新文件（未跟踪）',
      'git.deleted': '文件已删除，不能编辑',
      'git.selectFile': '点左边一个文件看差异',
      'git.editing': '正在编辑',
      'git.noTarget': '这个会话还没有工作区路径',
      'git.refreshHint': '每 6 秒自动刷新',
      'git.pickRepo': '没有找到 git 仓库',
      'git.status': '状态',
      'git.remote': '远程',
      'git.noRemote': '没有配置远程',
      'git.reloadBadge': '重新读取',

      'status.M': '修改',
      'status.A': '新增',
      'status.D': '删除',
      'status.R': '重命名',
      'status.C': '复制',
      'status.T': '类型变更',
      'status.U': '冲突',
      'status.?': '新文件',
    };

    const EN = {
      'action.edit': 'Edit',
      'action.editTitle': 'Edit this file in place',
      'action.git': 'Git changes',
      'action.gitTitle': 'Compare local changes with the remote',
      'action.save': 'Save',
      'action.revert': 'Revert',
      'action.reload': 'Reload',
      'action.close': 'Close',
      'action.wrap': 'Word wrap',
      'action.refresh': 'Refresh',
      'action.overwrite': 'Overwrite anyway',
      'action.discard': 'Discard',
      'action.keepEditing': 'Keep editing',
      'action.loadDisk': 'Load disk version',
      'action.editThisFile': 'Edit this file',
      'action.retry': 'Retry',

      'editor.title': 'Edit file',
      'editor.loading': 'Reading file…',
      'editor.unsaved': 'Unsaved',
      'editor.saving': 'Saving…',
      'editor.saved': 'Saved',
      'editor.dirtyPrompt': 'You have unsaved changes. Close anyway?',
      'editor.switchPrompt': 'The current file has unsaved changes; switching discards them.',
      'editor.reloadPrompt': 'Reloading from disk discards your changes. Continue?',
      'editor.conflict': 'The file changed on disk; saving now would overwrite that change.',
      'editor.chars': '{n} chars',
      'editor.lines': '{n} lines',
      'editor.binary': 'This is a binary file; the text editor cannot open it.',
      'editor.tooLarge': 'The file exceeds the editing limit ({limit}).',
      'editor.notFound': 'File not found.',
      'editor.notRegular': 'This is not a regular file.',
      'editor.conflictReloaded': 'Loaded the latest version from disk.',
      'editor.savedAt': 'Saved',

      'git.tabTitle': 'Git changes',
      'git.loading': 'Reading git status…',
      'git.error': 'Could not read git status',
      'git.noGit': 'The git executable is not available on this machine',
      'git.notRepo': 'This directory is not a git repository',
      'git.notRepoHint': 'The entry appears only inside a directory that has .git.',
      'git.clean': 'Matches the remote — no local changes',
      'git.cleanHint': 'A file edited back to match the remote disappears from this list.',
      'git.files': '{n} files',
      'git.base': 'vs {base}',
      'git.baseHead': 'vs HEAD (no upstream remote branch)',
      'git.ahead': '{n} ahead',
      'git.behind': '{n} behind',
      'git.binary': 'Binary file — no text diff',
      'git.truncated': 'Content truncated',
      'git.untracked': 'New file (untracked)',
      'git.deleted': 'File deleted — cannot edit',
      'git.selectFile': 'Pick a file on the left to see its diff',
      'git.editing': 'Editing',
      'git.noTarget': 'This Session has no workspace path yet',
      'git.refreshHint': 'Refreshes every 6 seconds',
      'git.pickRepo': 'No git repository found',
      'git.status': 'Status',
      'git.remote': 'Remote',
      'git.noRemote': 'No remote configured',
      'git.reloadBadge': 'Reload',

      'status.M': 'modified',
      'status.A': 'added',
      'status.D': 'deleted',
      'status.R': 'renamed',
      'status.C': 'copied',
      'status.T': 'type changed',
      'status.U': 'conflicted',
      'status.?': 'new file',
    };

    /** 极简翻译：先查字典，再回 key；{name} 占位符替换。 */
    function translate(t, key, vars) {
      let text;
      try {
        text = typeof t === 'function' ? t(key) : key;
      } catch {
        text = key;
      }
      if (typeof text !== 'string' || text.length === 0) text = key;
      if (vars === undefined) return text;
      return text.replace(/\{(\w+)\}/gu, (whole, name) => (name in vars ? String(vars[name]) : whole));
    }

    // ───────────────────────────────────────────────────────── 主题样式

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
    const INK = 'var(--dsw-alias-label-primary, #e6e6e6)';
    const INK_2 = 'var(--dsw-alias-label-secondary, #a1a1aa)';
    const INK_3 = 'var(--dsw-alias-label-tertiary, #71717a)';
    const LINE_1 = 'var(--dsw-alias-border-l1, rgba(127,127,127,.18))';
    const LINE_2 = 'var(--dsw-alias-border-l2, rgba(127,127,127,.30))';
    const BG_1 = 'var(--dsw-alias-bg-layer-1, #1c1d21)';
    const BG_2 = 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.10))';
    const BG_OVER = 'var(--dsw-alias-bg-overlay, #24252a)';
    const BRAND = 'var(--dsw-alias-brand-primary, #247bbf)';
    const OK = 'var(--dsw-alias-state-success-primary, #3fb950)';
    const WARN = 'var(--dsw-alias-state-warn-primary, #d29922)';
    const ERROR = 'var(--dsw-alias-state-error-primary, #f85149)';

    const S = {
      btn: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '1',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        height: '24px',
        minWidth: '24px',
        padding: '0 6px',
        border: 0,
        borderRadius: '6px',
        background: 'transparent',
        color: INK_2,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      btnPrimary: {
        background: 'var(--dsw-alias-button-primary-fill, #247bbf)',
        color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
        padding: '0 12px',
        fontWeight: 600,
      },
      btnDanger: {
        background: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(248,81,73,.14))',
        color: ERROR,
        padding: '0 12px',
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '18px',
        padding: '0 6px',
        borderRadius: '999px',
        border: `0.5px solid ${LINE_2}`,
        fontSize: '11px',
        lineHeight: '16px',
        color: INK_2,
        whiteSpace: 'nowrap',
      },
      mono: { fontFamily: MONO, fontSize: '11.5px' },
    };

    /** 全局一套 CSS（hover / diff 配色 / 编辑器排版）只注入一次，卸载时移除。 */
    function ensureStyles() {
      const id = 'dsh-plugin-edit-files/styles';
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector(`style[data-plugin=${JSON.stringify(id)}]`) !== null) return () => {};
      const style = document.createElement('style');
      style.dataset.plugin = id;
      style.textContent = `
.dsh-ef-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsh-ef-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:1px}
.dsh-ef-btn:disabled{opacity:.4;cursor:default}
.dsh-ef-btn[data-active="1"]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsh-ef-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.dsh-ef-menu-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}
.dsh-ef-menu-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:-2px}
.dsh-ef-diff{font-family:${MONO};font-size:12px;line-height:18px;white-space:pre;overflow:auto;tab-size:2}
.dsh-ef-line{display:flex;min-width:max-content;align-items:stretch}
.dsh-ef-no{flex:none;width:40px;padding-right:8px;text-align:right;color:var(--dsw-alias-label-tertiary,#71717a);user-select:none;font-size:11px}
.dsh-ef-code{flex:1 1 auto;padding-right:12px;white-space:pre}
.dsh-ef-line[data-kind="add"]{background:rgba(63,185,80,.16)}
.dsh-ef-line[data-kind="del"]{background:rgba(248,81,73,.16)}
.dsh-ef-line[data-kind="hunk"]{background:rgba(36,123,191,.12);color:var(--dsw-alias-brand-primary,#247bbf)}
.dsh-ef-line[data-kind="meta"]{color:var(--dsw-alias-label-tertiary,#71717a)}
.dsh-ef-line[data-kind="note"]{color:var(--dsw-alias-label-tertiary,#71717a);font-style:italic}
.dsh-ef-ta{tab-size:2}
.dsh-ef-ta::selection{background:rgba(36,123,191,.35)}
.dsh-ef-scroll::-webkit-scrollbar{width:10px;height:10px}
.dsh-ef-scroll::-webkit-scrollbar-thumb{background:rgba(127,127,127,.28);border-radius:6px;border:2px solid transparent;background-clip:content-box}
.dsh-ef-scroll::-webkit-scrollbar-track{background:transparent}
@media (max-width: 860px){.dsh-ef-editor{left:12px !important;width:auto !important}}
`;
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    // ───────────────────────────────────────────────────────── 极小极简 store

    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        get: () => state,
        set(patch) {
          const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
          if (next === state) return;
          state = next;
          for (const listener of listeners) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    function useStoreValue(store, selector) {
      const read = useCallback(() => {
        const state = store.get();
        return selector === undefined ? state : selector(state);
      }, [store, selector]);
      return useSyncExternalStore(store.subscribe, read, read);
    }

    // ───────────────────────────────────────────────────────── Host API

    async function request(method, suffix, params) {
      const url = new URL(API + suffix, window.location.href);
      let init;
      if (method === 'GET') {
        for (const [name, value] of Object.entries(params || {})) {
          if (value === undefined || value === null) continue;
          url.searchParams.set(name, String(value));
        }
        init = { method, cache: 'no-store', headers: { accept: 'application/json' } };
      } else {
        init = {
          method,
          cache: 'no-store',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(params || {}),
        };
      }
      try {
        const response = await fetch(url, init);
        let data;
        try {
          data = await response.json();
        } catch {
          data = undefined;
        }
        if (data !== null && typeof data === 'object') {
          if (data.ok !== true && data.httpStatus === undefined) data.httpStatus = response.status;
          return data;
        }
        return { ok: false, reason: 'bad-response', httpStatus: response.status };
      } catch (error) {
        return {
          ok: false,
          reason: 'network',
          error: error && error.message ? error.message : String(error),
        };
      }
    }

    const apiGet = (suffix, params) => request('GET', suffix, params);
    const apiPost = (suffix, params) => request('POST', suffix, params);

    // ───────────────────────────────────────────────────────── 共享状态

    /** 全局运行时：apply 里把 ctx / 打开动作挂进来，组件只读。 */
    const runtime = {
      ctx: null,
      openEditor: () => {},
      openGitTab: () => {},
      notifySaved: () => {},
    };

    /** git 侧刷新信号：编辑保存 / 手动刷新时 +1，徽标与面板据此重读。 */
    const gitBump = createStore(0);
    function bumpGit() {
      gitBump.set((value) => value + 1);
    }

    // ───────────────────────────────────────────────────────── 小工具

    function basename(path) {
      if (typeof path !== 'string' || path.length === 0) return '';
      const parts = path.replace(/\\/gu, '/').split('/');
      return parts[parts.length - 1] || path;
    }

    function dirnameOf(path) {
      if (typeof path !== 'string') return '';
      const index = path.replace(/\\/gu, '/').lastIndexOf('/');
      return index <= 0 ? '' : path.slice(0, index);
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function shortPath(path, max = 64) {
      if (typeof path !== 'string') return '';
      if (path.length <= max) return path;
      return '…' + path.slice(path.length - max + 1);
    }

    /** 从 WorkspaceSnapshot 找某个 Session 所属工作区的绝对路径。 */
    function workspacePathOf(snapshot, sessionId) {
      if (snapshot === null || typeof snapshot !== 'object' || sessionId === undefined) return null;
      const items = Array.isArray(snapshot.items) ? snapshot.items : [];
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue;
        const ids = Array.isArray(item.sessionIds) ? item.sessionIds : [];
        if (ids.indexOf(sessionId) >= 0) return typeof item.path === 'string' ? item.path : null;
      }
      return null;
    }

    /** 把 Host 的 reason 翻成人话。 */
    function reasonText(t, reason, extra) {
      switch (reason) {
        case 'binary':
          return translate(t, 'editor.binary');
        case 'too-large':
          return translate(t, 'editor.tooLarge', { limit: formatBytes(extra && extra.limit) || '2 MB' });
        case 'not-found':
          return translate(t, 'editor.notFound');
        case 'not-regular-file':
          return translate(t, 'editor.notRegular');
        case 'git-unavailable':
          return translate(t, 'git.noGit');
        case 'conflict':
          return translate(t, 'editor.conflict');
        case 'network':
          return translate(t, 'git.error') + ' · network';
        default:
          return translate(t, 'git.error') + (reason ? ` · ${reason}` : '');
      }
    }

    // ───────────────────────────────────────────────────────── 图标

    function svg(props, children) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: props.size || 14,
          height: props.size || 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { flex: 'none', display: 'block' },
        },
        children,
      );
    }

    const IconEdit = (props) =>
      svg(props, [h('path', { key: 'p', d: 'M10.5 2.5l3 3L5 14H2v-3l8.5-8.5z' }), h('path', { key: 'q', d: 'M9 4l3 3' })]);
    const IconGit = (props) =>
      svg(props, [
        h('circle', { key: 'a', cx: 4.5, cy: 3.5, r: 1.8 }),
        h('circle', { key: 'b', cx: 4.5, cy: 12.5, r: 1.8 }),
        h('circle', { key: 'c', cx: 11.5, cy: 6.5, r: 1.8 }),
        h('path', { key: 'l1', d: 'M4.5 5.3v5.4' }),
        h('path', { key: 'l2', d: 'M9.7 6.5c-2.2 0-3.4.8-3.4 2.4' }),
      ]);
    const IconRefresh = (props) =>
      svg(props, [
        h('path', { key: 'a', d: 'M13 8a5 5 0 1 1-1.6-3.7' }),
        h('path', { key: 'b', d: 'M13 2.5V5h-2.5' }),
      ]);
    const IconClose = (props) => svg(props, [h('path', { key: 'a', d: 'M4 4l8 8M12 4l-8 8' })]);
    const IconSave = (props) =>
      svg(props, [h('path', { key: 'a', d: 'M3 8.5l3 3 7-7' })]);
    const IconWrap = (props) =>
      svg(props, [
        h('path', { key: 'a', d: 'M2 4h12M2 8h9a2.5 2.5 0 0 1 0 5H8' }),
        h('path', { key: 'b', d: 'M9.5 11l-2 2 2 2' }),
      ]);
    const IconFile = (props) =>
      svg(props, [
        h('path', { key: 'a', d: 'M3.5 2h5l4 4v8h-9V2z' }),
        h('path', { key: 'b', d: 'M8.5 2v4h4' }),
      ]);

    // ───────────────────────────────────────────────────────── 通用按钮

    function ToolButton({ title, onClick, disabled, active, children, style, label }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-ef-btn',
          title,
          'aria-label': title,
          disabled: disabled === true,
          'data-active': active === true ? '1' : undefined,
          onClick: onClick,
          style: { ...S.btn, ...(label === undefined ? {} : { padding: '0 8px' }), ...(style || {}) },
        },
        children,
        label === undefined ? null : h('span', null, label),
      );
    }

    // ───────────────────────────────────────────────────────── 编辑器 store

    const EMPTY_EDITOR = {
      open: false,
      phase: 'idle', // idle | loading | ready | error
      path: '',
      content: '',
      original: '',
      mtimeMs: 0,
      eol: 'lf',
      bom: false,
      size: 0,
      wrap: false,
      focusSeq: 0,
      savePhase: 'idle', // idle | saving | saved | error | conflict
      saveError: null,
      conflict: null,
      error: null,
      pending: null, // { kind: 'close' | 'switch' | 'reload', path? }
    };

    const editorStore = createStore({ ...EMPTY_EDITOR });

    const editorActions = {
      async open(path) {
        if (typeof path !== 'string' || path.length === 0) return;
        const current = editorStore.get();
        if (current.open && current.phase === 'ready' && current.path !== path && current.content !== current.original) {
          editorStore.set({ pending: { kind: 'switch', path } });
          return;
        }
        await editorActions.load(path);
      },

      async load(path) {
        editorStore.set({ ...EMPTY_EDITOR, open: true, phase: 'loading', path });
        const result = await apiPost('/file/read', { path });
        if (editorStore.get().path !== path) return; // 已被另一个 open 顶掉
        if (result.ok !== true) {
          editorStore.set({ phase: 'error', error: result });
          return;
        }
        editorStore.set({
          open: true,
          phase: 'ready',
          path,
          content: result.content,
          original: result.content,
          mtimeMs: result.mtimeMs,
          eol: result.eol === 'crlf' ? 'crlf' : 'lf',
          bom: result.bom === true,
          size: result.size,
          focusSeq: editorStore.get().focusSeq + 1,
          savePhase: 'idle',
          saveError: null,
          conflict: null,
          error: null,
          pending: null,
        });
      },

      setText(text) {
        const current = editorStore.get();
        if (current.phase !== 'ready') return;
        editorStore.set({ content: text, savePhase: current.savePhase === 'saved' ? 'idle' : current.savePhase });
      },

      toggleWrap() {
        editorStore.set((current) => ({ ...current, wrap: !current.wrap }));
      },

      revert() {
        const current = editorStore.get();
        if (current.phase !== 'ready') return;
        editorStore.set({ content: current.original, savePhase: 'idle', saveError: null, conflict: null });
      },

      async save(force) {
        const current = editorStore.get();
        if (current.phase !== 'ready' || current.savePhase === 'saving') return;
        editorStore.set({ savePhase: 'saving', saveError: null });
        const result = await apiPost('/file/write', {
          path: current.path,
          content: current.content,
          expectedMtimeMs: current.mtimeMs,
          eol: current.eol,
          bom: current.bom,
          force: force === true,
        });
        const latest = editorStore.get();
        if (result.ok !== true) {
          if (result.reason === 'conflict') {
            editorStore.set({
              savePhase: 'conflict',
              conflict: { currentMtimeMs: result.currentMtimeMs },
              saveError: result,
            });
            return;
          }
          editorStore.set({ savePhase: 'error', saveError: result });
          return;
        }
        editorStore.set({
          original: latest.content,
          mtimeMs: result.mtimeMs,
          size: result.size,
          savePhase: 'saved',
          saveError: null,
          conflict: null,
        });
        runtime.notifySaved(latest.path);
      },

      requestClose() {
        const current = editorStore.get();
        if (current.open !== true) return;
        if (current.phase === 'ready' && current.content !== current.original) {
          editorStore.set({ pending: { kind: 'close' } });
          return;
        }
        editorActions.forceClose();
      },

      forceClose() {
        editorStore.set({ ...EMPTY_EDITOR });
      },

      requestReload() {
        const current = editorStore.get();
        if (current.open !== true) return;
        if (current.phase === 'ready' && current.content !== current.original) {
          editorStore.set({ pending: { kind: 'reload' } });
          return;
        }
        editorActions.load(current.path);
      },

      confirmPending() {
        const current = editorStore.get();
        const pending = current.pending;
        if (pending === null) return;
        if (pending.kind === 'close') {
          editorActions.forceClose();
          return;
        }
        if (pending.kind === 'switch') {
          editorActions.load(pending.path);
          return;
        }
        if (pending.kind === 'reload') {
          editorActions.load(current.path);
        }
      },

      dismissPending() {
        editorStore.set({ pending: null });
      },

      /** 冲突时载入磁盘版本，清掉本地草稿。 */
      async loadDisk() {
        const current = editorStore.get();
        if (current.phase !== 'ready') return;
        await editorActions.load(current.path);
        editorStore.set({ savePhase: 'idle', saveError: null, conflict: null });
      },
    };

    runtime.openEditor = (path) => {
      editorActions.open(path);
    };

    // ───────────────────────────────────────────────────────── 数据 hooks

    function useGitFileStatus(absolutePath) {
      const [state, setState] = useState({ loading: Boolean(absolutePath), data: null, error: null });
      const bump = useStoreValue(gitBump, (value) => value);
      useEffect(() => {
        if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
          setState({ loading: false, data: null, error: null });
          return undefined;
        }
        let live = true;
        apiGet('/git/file', { path: absolutePath }).then((result) => {
          if (!live) return;
          if (result.ok === true) setState({ loading: false, data: result, error: null });
          else setState({ loading: false, data: null, error: result });
        });
        return () => {
          live = false;
        };
      }, [absolutePath, bump]);
      return state;
    }

    /**
     * 读一个路径的 git 改动概览。pollMs 给了就轮询（面板开着时用）。
     * @param {string|null} path 目录或文件绝对路径
     * @param {{ pollMs?: number, enabled?: boolean }} options
     */
    function useGitChanges(path, options) {
      const pollMs = options && options.pollMs;
      const enabled = !(options && options.enabled === false);
      const [state, setState] = useState({ loading: Boolean(path), data: null, error: null, revision: 0 });
      const bump = useStoreValue(gitBump, (value) => value);

      useEffect(() => {
        if (!enabled || typeof path !== 'string' || path.length === 0) {
          setState((prev) => ({ ...prev, loading: false, data: null, error: null }));
          return undefined;
        }
        let live = true;
        setState((prev) => ({ ...prev, loading: true }));
        apiGet('/git/changes', { path }).then((result) => {
          if (!live) return;
          if (result.ok === true) setState((prev) => ({ loading: false, data: result, error: null, revision: prev.revision + 1 }));
          else setState((prev) => ({ loading: false, data: null, error: result, revision: prev.revision }));
        });
        return () => {
          live = false;
        };
      }, [path, bump, enabled]);

      useEffect(() => {
        if (!pollMs || !enabled || typeof path !== 'string' || path.length === 0) return undefined;
        const timer = setInterval(() => {
          apiGet('/git/changes', { path }).then((result) => {
            if (result.ok === true) setState((prev) => ({ loading: false, data: result, error: null, revision: prev.revision + 1 }));
          });
        }, pollMs);
        return () => clearInterval(timer);
      }, [path, pollMs, enabled]);

      return state;
    }

    // ───────────────────────────────────────────────────────── 编辑器浮层

    const EditorOverlay = (props) => {
      const t = props.t;
      const state = useStoreValue(editorStore, (value) => value);
      const textareaRef = useRef(null);
      const gutterRef = useRef(null);
      const savedTimerRef = useRef(0);

      // 打开时把焦点放到编辑器
      useEffect(() => {
        if (state.open && state.phase === 'ready') {
          const node = textareaRef.current;
          if (node !== null) {
            node.focus();
            const length = node.value.length;
            try {
              node.setSelectionRange(length, length);
            } catch {
              /* 忽略 */
            }
          }
        }
      }, [state.open, state.phase, state.focusSeq]);

      // ⌘S / Esc
      useEffect(() => {
        if (!state.open) return undefined;
        const onKeyDown = (event) => {
          if ((event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'S')) {
            event.preventDefault();
            event.stopPropagation();
            editorActions.save(false);
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            if (editorStore.get().pending !== null) editorActions.dismissPending();
            else editorActions.requestClose();
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [state.open]);

      // 保存成功提示两秒后淡掉
      useEffect(() => {
        if (state.savePhase !== 'saved') return undefined;
        const timer = setTimeout(() => {
          const current = editorStore.get();
          if (current.savePhase === 'saved') editorStore.set({ savePhase: 'idle' });
        }, 2200);
        return () => clearTimeout(timer);
      }, [state.savePhase]);

      const onChange = useCallback((event) => {
        editorActions.setText(event.target.value);
      }, []);

      const onScroll = useCallback((event) => {
        const gutter = gutterRef.current;
        if (gutter !== null) gutter.style.transform = `translateY(${-event.currentTarget.scrollTop}px)`;
      }, []);

      const onKeyDownTextarea = useCallback((event) => {
        if (event.key !== 'Tab') return;
        event.preventDefault();
        const node = event.currentTarget;
        const start = node.selectionStart;
        const end = node.selectionEnd;
        const value = node.value;
        node.setRangeText('  ', start, end, 'end');
        editorActions.setText(node.value);
        // setRangeText 已经改了 DOM，这里在下一帧把受控值对齐
        requestAnimationFrame(() => {
          node.selectionStart = start + 2;
          node.selectionEnd = start + 2;
        });
        void value;
      }, []);

      if (!state.open) return null;

      const dirty = state.phase === 'ready' && state.content !== state.original;
      const title = basename(state.path) || translate(t, 'editor.title');
      const lines = state.phase === 'ready' ? state.content.split('\n').length : 0;
      const chars = state.phase === 'ready' ? state.content.length : 0;
      const gutterWidth = Math.max(34, String(lines).length * 8 + 16);

      const rows = [];
      if (state.phase === 'ready' && lines <= 5000) {
        for (let index = 1; index <= lines; index += 1) {
          rows.push(index);
        }
      }

      const statusParts = [];
      if (state.phase === 'ready') {
        statusParts.push(translate(t, 'editor.lines', { n: lines }));
        statusParts.push(translate(t, 'editor.chars', { n: chars }));
        statusParts.push(`UTF-8 · ${state.eol === 'crlf' ? 'CRLF' : 'LF'}${state.bom ? ' · BOM' : ''}`);
      }

      return h(
        'div',
        {
          className: 'dsh-ef-editor',
          role: 'dialog',
          'aria-label': title,
          'aria-modal': false,
          style: {
            position: 'fixed',
            top: '56px',
            right: '12px',
            bottom: '12px',
            width: 'min(920px, 62vw)',
            // shell.overlay 这一层整体是 pointer-events:none，条目要自己 opt-in 才能点。
            pointerEvents: 'auto',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '12px',
            border: `1px solid ${LINE_2}`,
            background: BG_OVER,
            boxShadow: '0 18px 48px rgba(0,0,0,.34)',
            overflow: 'hidden',
            color: INK,
            fontFamily: 'inherit',
          },
        },
        // 头部
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '9px 10px 9px 12px',
              borderBottom: `0.5px solid ${LINE_1}`,
              background: BG_1,
              flex: 'none',
            },
          },
          h('span', { style: { color: BRAND, display: 'flex' } }, h(IconFile, { size: 15 })),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' } },
            h('div', {
              style: { fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
              title: state.path,
            }, title),
            h('div', { style: { ...S.mono, color: INK_3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: state.path }, shortPath(dirnameOf(state.path) || state.path, 96)),
          ),
          dirty
            ? h('span', { style: { ...S.chip, color: WARN, borderColor: 'transparent', background: 'rgba(210,153,34,.14)' } }, translate(t, 'editor.unsaved'))
            : null,
          h(ToolButton, {
            key: 'wrap',
            title: translate(t, 'action.wrap'),
            active: state.wrap,
            onClick: () => editorActions.toggleWrap(),
            children: h(IconWrap, {}),
          }),
          h(ToolButton, {
            key: 'revert',
            title: translate(t, 'action.revert'),
            disabled: !dirty,
            onClick: () => editorActions.revert(),
            children: h(IconRefresh, {}),
          }),
          h(ToolButton, {
            key: 'reload',
            title: translate(t, 'action.reload'),
            onClick: () => editorActions.requestReload(),
            children: h(IconFile, {}),
          }),
          h(
            'button',
            {
              key: 'save',
              type: 'button',
              className: 'dsh-ef-btn',
              title: `${translate(t, 'action.save')} (⌘S)`,
              disabled: state.phase !== 'ready' || state.savePhase === 'saving',
              onClick: () => editorActions.save(false),
              style: { ...S.btn, ...S.btnPrimary, opacity: dirty ? 1 : 0.6 },
            },
            h(IconSave, {}),
            h('span', null, state.savePhase === 'saving' ? translate(t, 'editor.saving') : translate(t, 'action.save')),
          ),
          h(ToolButton, { key: 'close', title: translate(t, 'action.close'), onClick: () => editorActions.requestClose(), children: h(IconClose, {}) }),
        ),
        // 主体
        h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', background: BG_2 } },
          state.phase === 'loading'
            ? h('div', { style: { padding: '22px', fontSize: '13px', color: INK_3 } }, translate(t, 'editor.loading'))
            : null,
          state.phase === 'error'
            ? h(
                'div',
                { style: { padding: '22px', display: 'flex', flexDirection: 'column', gap: '10px' } },
                h('div', { style: { fontSize: '13px', color: ERROR } }, reasonText(t, state.error && state.error.reason, state.error)),
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px' } },
                  h('button', {
                    type: 'button',
                    className: 'dsh-ef-btn',
                    style: { ...S.btn, border: `0.5px solid ${LINE_2}`, padding: '0 12px', height: '26px' },
                    onClick: () => editorActions.load(state.path),
                  }, translate(t, 'action.retry')),
                  h('button', {
                    type: 'button',
                    className: 'dsh-ef-btn',
                    style: { ...S.btn, border: `0.5px solid ${LINE_2}`, padding: '0 12px', height: '26px' },
                    onClick: () => editorActions.forceClose(),
                  }, translate(t, 'action.close')),
                ),
              )
            : null,
          state.phase === 'ready'
            ? h(
                'div',
                { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', overflow: 'hidden' } },
                lines <= 5000
                  ? h(
                      'div',
                      {
                        style: {
                          flex: 'none',
                          width: `${gutterWidth}px`,
                          overflow: 'hidden',
                          padding: '10px 0',
                          background: BG_2,
                          borderRight: `0.5px solid ${LINE_1}`,
                        },
                      },
                      h(
                        'div',
                        {
                          ref: gutterRef,
                          style: {
                            fontFamily: MONO,
                            fontSize: '12px',
                            lineHeight: '20px',
                            color: INK_3,
                            textAlign: 'right',
                            paddingRight: '8px',
                            willChange: 'transform',
                          },
                        },
                        rows.map((line) => h('div', { key: line }, String(line))),
                      ),
                    )
                  : null,
                h('textarea', {
                  ref: textareaRef,
                  className: 'dsh-ef-ta dsh-ef-scroll',
                  spellCheck: false,
                  value: state.content,
                  onChange,
                  onScroll,
                  onKeyDown: onKeyDownTextarea,
                  wrap: state.wrap ? 'soft' : 'off',
                  style: {
                    flex: '1 1 auto',
                    minWidth: 0,
                    border: 0,
                    outline: 'none',
                    resize: 'none',
                    margin: 0,
                    padding: '10px 12px',
                    background: 'transparent',
                    color: INK,
                    fontFamily: MONO,
                    fontSize: '12.5px',
                    lineHeight: '20px',
                    overflow: 'auto',
                    tabSize: 2,
                  },
                }),
              )
            : null,
        ),
        // 冲突条
        state.savePhase === 'conflict'
          ? h(
              'div',
              {
                style: {
                  flex: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  flexWrap: 'wrap',
                  padding: '8px 12px',
                  background: 'rgba(210,153,34,.14)',
                  borderTop: `0.5px solid ${LINE_1}`,
                  fontSize: '12.5px',
                  color: INK,
                },
              },
              h('span', { style: { flex: '1 1 220px' } }, translate(t, 'editor.conflict')),
              h('button', {
                type: 'button',
                className: 'dsh-ef-btn',
                style: { ...S.btn, ...S.btnDanger, height: '26px' },
                onClick: () => editorActions.save(true),
              }, translate(t, 'action.overwrite')),
              h('button', {
                type: 'button',
                className: 'dsh-ef-btn',
                style: { ...S.btn, border: `0.5px solid ${LINE_2}`, height: '26px', padding: '0 12px' },
                onClick: () => editorActions.loadDisk(),
              }, translate(t, 'action.loadDisk')),
            )
          : null,
        // 未保存确认条
        state.pending !== null
          ? h(
              'div',
              {
                style: {
                  flex: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  flexWrap: 'wrap',
                  padding: '8px 12px',
                  background: 'rgba(248,81,73,.12)',
                  borderTop: `0.5px solid ${LINE_1}`,
                  fontSize: '12.5px',
                },
              },
              h(
                'span',
                { style: { flex: '1 1 220px' } },
                translate(t, state.pending.kind === 'switch' ? 'editor.switchPrompt' : state.pending.kind === 'reload' ? 'editor.reloadPrompt' : 'editor.dirtyPrompt'),
              ),
              h('button', {
                type: 'button',
                className: 'dsh-ef-btn',
                style: { ...S.btn, ...S.btnDanger, height: '26px' },
                onClick: () => editorActions.confirmPending(),
              }, translate(t, 'action.discard')),
              h('button', {
                type: 'button',
                className: 'dsh-ef-btn',
                style: { ...S.btn, border: `0.5px solid ${LINE_2}`, height: '26px', padding: '0 12px' },
                onClick: () => editorActions.dismissPending(),
              }, translate(t, 'action.keepEditing')),
            )
          : null,
        // 底部状态
        h(
          'div',
          {
            style: {
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '6px 12px',
              borderTop: `0.5px solid ${LINE_1}`,
              background: BG_1,
              fontSize: '11.5px',
              color: INK_3,
              minHeight: '28px',
            },
          },
          h('span', null, statusParts.join(' · ')),
          state.savePhase === 'saved'
            ? h('span', { style: { color: OK } }, `✓ ${translate(t, 'editor.savedAt')}`)
            : null,
          state.savePhase === 'error'
            ? h('span', { style: { color: ERROR } }, reasonText(t, state.saveError && state.saveError.reason, state.saveError))
            : null,
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { title: state.path, style: { ...S.mono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '52%' } }, state.path),
        ),
      );
    };

    // ───────────────────────────────────────────────────────── 入口：文档预览工具栏

    const DocumentActions = (props) => {
      const t = props.t;
      const absolutePath = typeof props.absolutePath === 'string' ? props.absolutePath : null;
      const sessionId = props.sessionId;
      const status = useGitFileStatus(absolutePath);

      const openGit = useCallback(() => {
        const data = status.data;
        const target = data && data.isRepo ? data.root : absolutePath;
        runtime.openGitTab(sessionId, target || '');
      }, [status.data, absolutePath, sessionId]);

      if (absolutePath === null) return null;

      const repo = status.data && status.data.isRepo === true;
      const changed = repo && status.data.file !== null && status.data.file !== undefined;
      const letter = changed ? status.data.file.status : null;

      return h(
        'div',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '2px' } },
        h(
          ToolButton,
          {
            key: 'edit',
            title: translate(t, 'action.editTitle'),
            onClick: () => runtime.openEditor(absolutePath),
          },
          h(IconEdit, {}),
        ),
        repo
          ? h(
              ToolButton,
              {
                key: 'git',
                title: `${translate(t, 'action.gitTitle')}${status.data.branch ? ` · ${status.data.branch}` : ''}`,
                onClick: openGit,
                style: changed ? { color: WARN } : undefined,
                label: changed ? letter : undefined,
              },
              h(IconGit, {}),
            )
          : null,
      );
    };

    // ───────────────────────────────────────────────────────── 入口：文件树工具栏

    const FilesGitAction = (props) => {
      const t = props.t;
      const absolutePath = typeof props.absolutePath === 'string' ? props.absolutePath : null;
      const sessionId = props.sessionId;
      const changes = useGitChanges(absolutePath, {});
      const data = changes.data;

      const onClick = useCallback(() => {
        if (!data || data.isRepo !== true) return;
        runtime.openGitTab(sessionId, data.root || absolutePath || '');
      }, [data, sessionId, absolutePath]);

      if (absolutePath === null || !data || data.isRepo !== true) return null;
      const total = data.totals ? data.totals.files : (data.files ? data.files.length : 0);
      return h(
        ToolButton,
        { title: `${translate(t, 'action.git')} · ${data.branch || ''}`, onClick },
        h(IconGit, {}),
        h('span', { style: { fontSize: '11px', fontVariantNumeric: 'tabular-nums' } }, String(total)),
      );
    };

    // ───────────────────────────────────────────────────────── 入口：会话头部徽标

    const SessionGitBadge = (props) => {
      const t = props.t;
      const sessionId = props.sessionId;
      const useWorkspaces = props.useWorkspaces;
      const path = useWorkspaces((snapshot) => workspacePathOf(snapshot, sessionId));
      const changes = useGitChanges(path, { pollMs: 30000 });
      const data = changes.data;

      const onClick = useCallback(() => {
        if (!data || data.isRepo !== true) return;
        runtime.openGitTab(sessionId, data.root || path || '');
      }, [data, sessionId, path]);

      if (!data || data.isRepo !== true) return null;
      const total = data.totals ? data.totals.files : (data.files ? data.files.length : 0);
      return h(
        ToolButton,
        {
          title: `${translate(t, 'action.git')}${data.branch ? ` · ${data.branch}` : ''}${total > 0 ? ` · ${translate(t, 'git.files', { n: total })}` : ` · ${translate(t, 'git.clean')}`}`,
          onClick,
          style: total > 0 ? { color: WARN, gap: '2px' } : undefined,
          label: total > 0 ? String(total) : undefined,
        },
        h(IconGit, {}),
      );
    };

    // ───────────────────────────────────────────────────────── 入口：会话「...」菜单

    const GitMenuItem = (props) => {
      const t = props.t;
      const sessionId = props.sessionId;
      const useWorkspaces = props.useWorkspaces;
      const path = useWorkspaces((snapshot) => workspacePathOf(snapshot, sessionId));
      const changes = useGitChanges(path, {});
      // 菜单的开关状态由 owner 通过 slot hook 注入；缺省时给一对空操作，保证 hook 调用顺序稳定。
      const useMenuOpenState = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState : () => [false, () => {}];
      const [, setMenuOpen] = useMenuOpenState();
      const data = changes.data;

      const onSelect = useCallback(() => {
        setMenuOpen(false);
        if (!data || data.isRepo !== true) return;
        runtime.openGitTab(sessionId, data.root || path || '');
      }, [setMenuOpen, data, sessionId, path]);

      if (!data || data.isRepo !== true) return null;
      const total = data.totals ? data.totals.files : (data.files ? data.files.length : 0);
      return h(
        'button',
        { type: 'button', role: 'menuitem', className: 'dsh-ef-menu-item', onClick: onSelect },
        h('span', { style: { display: 'flex', color: INK_2 } }, h(IconGit, { size: 14 })),
        h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, translate(t, 'action.git')),
        h(
          'span',
          { style: { ...S.mono, color: total > 0 ? WARN : INK_3, fontVariantNumeric: 'tabular-nums' } },
          total > 0 ? String(total) : '✓',
        ),
      );
    };

    // ───────────────────────────────────────────────────────── diff 工具

    function parseUnifiedDiff(text) {
      const rows = [];
      if (typeof text !== 'string' || text.length === 0) return rows;
      const rawLines = text.split('\n');
      if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
      let oldNo = 0;
      let newNo = 0;
      for (const raw of rawLines) {
        if (
          raw.startsWith('diff --git') ||
          raw.startsWith('index ') ||
          raw.startsWith('old mode') ||
          raw.startsWith('new mode') ||
          raw.startsWith('deleted file mode') ||
          raw.startsWith('new file mode') ||
          raw.startsWith('similarity index') ||
          raw.startsWith('rename from') ||
          raw.startsWith('rename to') ||
          raw.startsWith('--- ') ||
          raw.startsWith('+++ ')
        ) {
          rows.push({ kind: 'meta', oldNo: null, newNo: null, text: raw });
          continue;
        }
        if (raw.startsWith('@@')) {
          const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u.exec(raw);
          if (match !== null) {
            oldNo = Number(match[1]);
            newNo = Number(match[2]);
          }
          rows.push({ kind: 'hunk', oldNo: null, newNo: null, text: raw });
          continue;
        }
        if (raw.startsWith('\\')) {
          rows.push({ kind: 'note', oldNo: null, newNo: null, text: raw });
          continue;
        }
        const marker = raw.length > 0 ? raw[0] : ' ';
        if (marker === '+') {
          rows.push({ kind: 'add', oldNo: null, newNo: newNo, text: raw.slice(1) });
          newNo += 1;
        } else if (marker === '-') {
          rows.push({ kind: 'del', oldNo: oldNo, newNo: null, text: raw.slice(1) });
          oldNo += 1;
        } else if (marker === ' ') {
          rows.push({ kind: 'ctx', oldNo: oldNo, newNo: newNo, text: raw.slice(1) });
          oldNo += 1;
          newNo += 1;
        } else {
          // 不是标准 diff 行（比如直接塞全文）：原样当说明行，不要吃掉首字符。
          rows.push({ kind: 'meta', oldNo: null, newNo: null, text: raw });
        }
      }
      return rows;
    }

    function statusColor(status) {
      switch (status) {
        case 'A':
          return OK;
        case 'D':
          return ERROR;
        case 'R':
        case 'C':
          return BRAND;
        case 'U':
          return ERROR;
        default:
          return WARN;
      }
    }

    function DiffBody({ t, diff, newText, binary, untracked, truncated }) {
      const rows = useMemo(() => {
        if (binary === true) return [];
        if (typeof newText === 'string' && newText.length > 0) {
          const lines = newText.split('\n');
          if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
          return lines.map((text, index) => ({ kind: 'add', oldNo: null, newNo: index + 1, text }));
        }
        return parseUnifiedDiff(diff);
      }, [diff, newText, binary]);

      if (binary === true) {
        return h('div', { style: { padding: '18px 14px', fontSize: '12.5px', color: INK_3 } }, translate(t, 'git.binary'));
      }
      if (rows.length === 0) {
        return h('div', { style: { padding: '18px 14px', fontSize: '12.5px', color: INK_3 } }, translate(t, 'git.selectFile'));
      }
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dsh-ef-diff dsh-ef-scroll', style: { height: '100%' } },
          rows.map((row, index) =>
            h(
              'div',
              { key: index, className: 'dsh-ef-line', 'data-kind': row.kind },
              h('span', { className: 'dsh-ef-no' }, row.oldNo === null ? '' : String(row.oldNo)),
              h('span', { className: 'dsh-ef-no' }, row.newNo === null ? '' : String(row.newNo)),
              h('span', { className: 'dsh-ef-code' }, row.text.length === 0 ? ' ' : row.text),
            ),
          ),
        ),
        truncated === true
          ? h('div', { style: { padding: '6px 12px', fontSize: '11.5px', color: WARN, borderTop: `0.5px solid ${LINE_1}` } }, translate(t, 'git.truncated'))
          : null,
        untracked === true
          ? h('div', { style: { padding: '6px 12px', fontSize: '11.5px', color: INK_3, borderTop: `0.5px solid ${LINE_1}` } }, translate(t, 'git.untracked'))
          : null,
      );
    }

    // ───────────────────────────────────────────────────────── Git 改动页

    const GitChangesTab = (props) => {
      const t = props.t;
      const sessionId = props.sessionId;
      const useWorkspaces = props.useWorkspaces;
      const useTabInfo = props.useTabInfo;
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : { tab: null };
      const tab = tabInfo && tabInfo.tab ? tabInfo.tab : null;
      const navigationPath = tab && tab.navigation && tab.navigation.params && typeof tab.navigation.params.path === 'string'
        ? tab.navigation.params.path
        : null;
      const workspacePath = useWorkspaces((snapshot) => workspacePathOf(snapshot, sessionId));
      const target = navigationPath || workspacePath;
      const visible = tab === null || tab.visible !== false;

      const [refreshSeq, setRefreshSeq] = useState(0);
      const [selected, setSelected] = useState(null);
      const [detail, setDetail] = useState({ loading: false, file: null, data: null, error: null });

      const bump = useStoreValue(gitBump, (value) => value);
      const [changes, setChanges] = useState({ loading: Boolean(target), data: null, error: null });

      const loadChanges = useCallback(async (silent) => {
        if (typeof target !== 'string' || target.length === 0) {
          setChanges({ loading: false, data: null, error: null });
          return;
        }
        if (silent !== true) setChanges((prev) => ({ ...prev, loading: true }));
        const result = await apiGet('/git/changes', { path: target });
        if (result.ok === true) setChanges({ loading: false, data: result, error: null });
        else setChanges({ loading: false, data: null, error: result });
      }, [target]);

      // 首次 / target 变化 / 外部 bump / 手动刷新
      useEffect(() => {
        loadChanges(false);
      }, [loadChanges, bump, refreshSeq]);

      // 面板可见时每 6 秒静默刷新
      useEffect(() => {
        if (!visible || typeof target !== 'string' || target.length === 0) return undefined;
        const timer = setInterval(() => {
          loadChanges(true);
        }, 6000);
        return () => clearInterval(timer);
      }, [loadChanges, visible, target]);

      const data = changes.data;
      const files = data && Array.isArray(data.files) ? data.files : [];

      // 选择项跟随列表：没选或选中的文件消失了，就选第一个
      useEffect(() => {
        if (files.length === 0) {
          if (selected !== null) setSelected(null);
          return;
        }
        const exists = files.some((file) => file.path === selected);
        if (!exists) setSelected(files[0].path);
      }, [files, selected]);

      // 读选中文件的 diff
      useEffect(() => {
        if (selected === null || typeof target !== 'string') {
          setDetail({ loading: false, file: null, data: null, error: null });
          return undefined;
        }
        let live = true;
        setDetail((prev) => ({ ...prev, loading: true, file: selected }));
        apiGet('/git/diff', { path: target, file: selected }).then((result) => {
          if (!live) return;
          if (result.ok === true) setDetail({ loading: false, file: selected, data: result, error: null });
          else setDetail({ loading: false, file: selected, data: null, error: result });
        });
        return () => {
          live = false;
        };
      }, [selected, target, refreshSeq, bump]);

      const headerHint = useMemo(() => {
        if (data === null || data === void 0) return null;
        if (data.baseKind === 'head') return translate(t, 'git.baseHead');
        if (typeof data.base === 'string' && data.base.length > 0) return translate(t, 'git.base', { base: data.base });
        return null;
      }, [data, t]);

      // 顶部固定头部
      const header = h(
        'div',
        {
          style: {
            flex: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '9px 10px',
            borderBottom: `0.5px solid ${LINE_1}`,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
          h('span', { style: { color: data && data.isRepo ? BRAND : INK_3, display: 'flex' } }, h(IconGit, { size: 15 })),
          h('span', {
            style: { fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: '1 1 auto' },
            title: data && data.root ? data.root : '',
          }, data && data.branch ? data.branch : translate(t, 'git.tabTitle')),
          data && data.ahead !== null && data.ahead !== undefined && data.ahead > 0
            ? h('span', { style: { ...S.chip, color: OK, borderColor: 'transparent', background: 'rgba(63,185,80,.14)' } }, `↑${data.ahead}`)
            : null,
          data && data.behind !== null && data.behind !== undefined && data.behind > 0
            ? h('span', { style: { ...S.chip, color: ERROR, borderColor: 'transparent', background: 'rgba(248,81,73,.14)' } }, `↓${data.behind}`)
            : null,
          h(ToolButton, {
            key: 'refresh',
            title: `${translate(t, 'action.refresh')} · ${translate(t, 'git.refreshHint')}`,
            onClick: () => {
              setRefreshSeq((value) => value + 1);
              bumpGit();
            },
            children: h(IconRefresh, {}),
          }),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '11.5px', color: INK_3 } },
          data && data.isRepo
            ? h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
                headerHint === null ? null : h('span', { style: S.chip }, headerHint),
                h('span', { style: { fontVariantNumeric: 'tabular-nums' } },
                  data.totals
                    ? `${translate(t, 'git.files', { n: data.totals.files })} · +${data.totals.additions} −${data.totals.deletions}`
                    : ''),
              )
            : null,
          data && data.remoteUrl ? h('span', { style: { ...S.mono, color: INK_3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }, title: data.remoteUrl }, data.remoteUrl) : null,
        ),
        data && data.root
          ? h('div', { style: { ...S.mono, color: INK_3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: data.root }, shortPath(data.root, 88))
          : null,
      );

      let body = null;
      if (target === null || target === undefined || target.length === 0) {
        body = h('div', { style: { padding: '18px 14px', fontSize: '12.5px', color: INK_3 } }, translate(t, 'git.noTarget'));
      } else if (changes.loading && data === null) {
        body = h('div', { style: { padding: '18px 14px', fontSize: '12.5px', color: INK_3 } }, translate(t, 'git.loading'));
      } else if (changes.error !== null) {
        body = h(
          'div',
          { style: { padding: '18px 14px', display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', { style: { fontSize: '12.5px', color: ERROR } }, reasonText(t, changes.error.reason, changes.error)),
          h('button', {
            type: 'button',
            className: 'dsh-ef-btn',
            style: { ...S.btn, border: `0.5px solid ${LINE_2}`, height: '26px', padding: '0 12px', alignSelf: 'flex-start' },
            onClick: () => setRefreshSeq((value) => value + 1),
          }, translate(t, 'action.retry')),
        );
      } else if (data !== null && data.isRepo !== true) {
        body = h(
          'div',
          { style: { padding: '18px 14px', display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('div', { style: { fontSize: '13px', color: INK_2 } }, translate(t, 'git.notRepo')),
          h('div', { style: { fontSize: '11.5px', color: INK_3 } }, translate(t, 'git.notRepoHint')),
        );
      } else if (files.length === 0) {
        body = h(
          'div',
          { style: { padding: '18px 14px', display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('div', { style: { fontSize: '13px', color: OK } }, `✓ ${translate(t, 'git.clean')}`),
          h('div', { style: { fontSize: '11.5px', color: INK_3 } }, translate(t, 'git.cleanHint')),
        );
      } else {
        const selectedFile = files.find((file) => file.path === selected) || null;
        const absoluteOfSelected = selectedFile !== null && data !== null && data.root
          ? `${String(data.root).replace(/\/$/u, '')}/${selectedFile.path}`
          : null;
        body = h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
          // 文件列表
          h(
            'div',
            {
              className: 'dsh-ef-scroll',
              style: {
                flex: '0 0 auto',
                maxHeight: files.length > 6 ? '34%' : 'none',
                overflowY: 'auto',
                borderBottom: `0.5px solid ${LINE_1}`,
              },
            },
            files.map((file) =>
              h(
                'button',
                {
                  key: file.path,
                  type: 'button',
                  onClick: () => setSelected(file.path),
                  title: file.untracked === true ? translate(t, 'git.untracked') : file.path,
                  style: {
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '5px 10px',
                    border: 0,
                    background: file.path === selected ? BG_2 : 'transparent',
                    color: INK,
                    font: 'inherit',
                    fontSize: '12px',
                    textAlign: 'left',
                    cursor: 'pointer',
                  },
                },
                h(
                  'span',
                  {
                    style: {
                      flex: 'none',
                      width: '16px',
                      textAlign: 'center',
                      fontFamily: MONO,
                      fontSize: '11px',
                      fontWeight: 700,
                      color: statusColor(file.status),
                    },
                  },
                  file.status,
                ),
                h('span', {
                  style: { flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
                }, basename(file.path), h('span', { style: { color: INK_3, marginLeft: '6px', fontSize: '11px' } }, dirnameOf(file.path) || '')),
                file.binary === true
                  ? h('span', { style: { ...S.mono, color: INK_3, flex: 'none' } }, 'bin')
                  : h(
                      'span',
                      { style: { ...S.mono, flex: 'none', fontVariantNumeric: 'tabular-nums' } },
                      file.additions > 0 ? h('span', { style: { color: OK } }, `+${file.additions}`) : null,
                      file.deletions > 0 ? h('span', { style: { color: ERROR, marginLeft: '4px' } }, `−${file.deletions}`) : null,
                    ),
              ),
            ),
          ),
          // diff 区
          h(
            'div',
            { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
            selectedFile === null
              ? h('div', { style: { padding: '18px 14px', fontSize: '12.5px', color: INK_3 } }, translate(t, 'git.selectFile'))
              : h(
                  'div',
                  {
                    style: {
                      flex: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 10px',
                      borderBottom: `0.5px solid ${LINE_1}`,
                      minWidth: 0,
                    },
                  },
                  h('span', {
                    style: { flex: '1 1 auto', minWidth: 0, fontFamily: MONO, fontSize: '11.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
                    title: selectedFile.path,
                  }, selectedFile.path),
                  h(
                    'span',
                    { style: S.chip },
                    selectedFile.untracked === true ? translate(t, 'status.?') : translate(t, `status.${selectedFile.status}`),
                  ),
                  selectedFile.status === 'D' || selectedFile.binary === true
                    ? null
                    : h(ToolButton, {
                        title: translate(t, 'action.editThisFile'),
                        onClick: () => {
                          if (absoluteOfSelected !== null) runtime.openEditor(absoluteOfSelected);
                        },
                        children: h(IconEdit, {}),
                      }),
                ),
            h(
              'div',
              { style: { flex: '1 1 auto', minHeight: 0, position: 'relative' } },
              detail.loading
                ? h('div', { style: { padding: '14px', fontSize: '12px', color: INK_3 } }, translate(t, 'git.loading'))
                : detail.error !== null
                  ? h('div', { style: { padding: '14px', fontSize: '12px', color: ERROR } }, reasonText(t, detail.error.reason, detail.error))
                  : detail.data !== null
                    ? h(DiffBody, {
                        t,
                        diff: detail.data.diff,
                        newText: detail.data.newText,
                        binary: detail.data.binary,
                        untracked: detail.data.untracked,
                        truncated: detail.data.truncated,
                      })
                    : null,
            ),
          ),
        );
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: INK, fontSize: '12.5px' } },
        header,
        body,
      );
    };

    // ───────────────────────────────────────────────────────── 打开「Git 改动」页

    function openGitTabOn(ctx, sessionId, path) {
      const params = typeof path === 'string' && path.length > 0 ? { params: { path } } : {};
      const hasGitTab = () => {
        if (typeof sessionId !== 'string') return true;
        if (typeof ctx.sidebarRight.tabsIn !== 'function') return true;
        try {
          return ctx.sidebarRight.tabsIn(sessionId).some((tab) => tab.kind === TAB_KIND);
        } catch {
          return false;
        }
      };
      const open = () => {
        try {
          if (typeof sessionId === 'string' && typeof ctx.sidebarRight.openTabIn === 'function') {
            ctx.sidebarRight.openTabIn(sessionId, TAB_KIND, params);
          } else {
            ctx.sidebarRight.openTab(TAB_KIND, params);
          }
        } catch (error) {
          console.warn(LOG + '打开 Git 改动页失败：' + (error && error.message ? error.message : error));
        }
      };

      // 目标 Session 不是屏幕上那个时，右栏还没有它的 dock store：先切过去，再重试到 tab 落地。
      if (typeof sessionId === 'string' && ctx.uiWorkspace) {
        try {
          ctx.uiWorkspace.openSession(sessionId);
        } catch (error) {
          console.warn(LOG + '打开会话失败：' + (error && error.message ? error.message : error));
        }
      }
      open();
      if (typeof sessionId !== 'string' || hasGitTab()) return;

      let attempt = 0;
      const timer = setInterval(() => {
        attempt += 1;
        open();
        if (hasGitTab() || attempt >= 12) clearInterval(timer);
      }, 100);
    }

    runtime.openGitTab = (sessionId, path) => {
      const ctx = runtime.ctx;
      if (ctx === null) return;
      openGitTabOn(ctx, sessionId, path);
    };

    runtime.notifySaved = () => {
      bumpGit();
    };

    // ───────────────────────────────────────────────────────── apply

    const plugin = {
      inject: ['slots', 'locale', 'uiWorkspace', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        runtime.ctx = ctx;
        const t = ctx.locale.bind(NS);

        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'edit-files: dictionaries');
        ctx.effect(() => ensureStyles(), 'edit-files: styles');

        // ① 编辑器浮层
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'edit-files-editor', order: 60, locale: NS },
            EditorOverlay,
          ));

        // ② 文档预览工具栏：编辑 + Git 状态
        ctx.slots.inject('sidebar.right.tab.document.actions', () =>
          ctx.slots.register(
            { name: 'sidebar.right.tab.document.actions', id: 'edit-files-document', order: 20, locale: NS },
            DocumentActions,
          ));

        // ③ 文件树工具栏：Git 改动
        ctx.slots.inject('sidebar.right.tab.files.actions', () =>
          ctx.slots.register(
            { name: 'sidebar.right.tab.files.actions', id: 'edit-files-files', order: 10, locale: NS },
            FilesGitAction,
          ));

        // ④ 会话头部徽标
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'edit-files-git-badge', order: -8, locale: NS },
            SessionGitBadge,
          ));

        // ⑤ 会话「...」菜单
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'edit-files-git-menu', order: 210, locale: NS },
            GitMenuItem,
          ));

        // ⑥ 右栏页类型 + 正文
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: 'builtin',
              title: () => translate(t, 'git.tabTitle'),
            }),
          'edit-files: git tab type',
        );
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS },
            GitChangesTab,
          ));
      },
    };

    // 自检脚本（test/client-selftest.mjs）用：只有页面显式打开测试开关时才挂，正常运行时不存在。
    if (typeof window !== 'undefined' && window.__DSH_EDIT_FILES_TEST__ === true) {
      plugin.__test = {
        constants: { NS, API, TAB_ID, TAB_KIND },
        dictionaries: { zh: ZH, en: EN },
        translate,
        parseUnifiedDiff,
        workspacePathOf,
        basename,
        dirnameOf,
        shortPath,
        formatBytes,
        reasonText,
      };
    }

    return plugin;
  },
});
