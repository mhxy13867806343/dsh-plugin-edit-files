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
      'fm.title': '文件',
      'fm.search': '搜索文件名…',
      'fm.searchHint': '支持模糊匹配：mnts 也能找到 main.ts',
      'fm.sortName': '名称',
      'fm.sortTime': '修改时间',
      'fm.sortSize': '大小',
      'fm.sortAsc': '升序',
      'fm.sortDesc': '降序',
      'fm.onlyChanged': '只看改动',
      'fm.showIgnored': '显示忽略目录',
      'fm.refresh': '刷新',
      'fm.newFile': '新建文件',
      'fm.newDir': '新建文件夹',
      'fm.rename': '重命名',
      'fm.delete': '删除',
      'fm.loading': '正在读取文件列表…',
      'fm.empty': '这个目录是空的',
      'fm.emptySearch': '没有匹配的文件',
      'fm.noWorkspace': '没有可浏览的工作区',
      'fm.pickWorkspace': '工作区',
      'fm.truncated': '文件过多，只显示前 {n} 条',
      'fm.summary': '{files} 个文件 · {dirs} 个目录',
      'fm.changed': '{n} 个文件有改动',
      'fm.clean': '与远程一致',
      'fm.openHint': '点文件在编辑器里打开，点目录进入',
      'fm.newFileTitle': '新建文件',
      'fm.newDirTitle': '新建文件夹',
      'fm.renameTitle': '重命名',
      'fm.name': '名称',
      'fm.createAt': '创建在 {dir}',
      'fm.cancel': '取消',
      'fm.confirm': '确定',
      'fm.busy': '处理中…',
      'fm.created': '已创建 {name}',
      'fm.renamed': '已重命名',
      'fm.deleted': '已删除 {name}',
      'fm.deleteTitle': '删除「{name}」？',
      'fm.deleteHint': '删除后不可恢复；如果是目录，会连同里面的文件一起删掉。',
      'fm.recursive': '我确认递归删除这个目录',
      'fm.dir': '目录',
      'fm.link': '链接',
      'fm.rootBadge': '工作区',
      'fm.restartNeeded': '文件面板的 Host 路由需要重启一次 DSH Desktop 才能加载。',
      'fm.restartHint': '升级/首次安装 Host 代码后，运行中的进程还在用旧模块；重启后即可使用。',
      'fm.restartButton': '重启 DSH',
      'fm.restartConfirm': '现在重启 DSH Desktop？应用会重启，当前会话记录会保留。',
      'fm.restarting': '正在重启…',
      'fm.restartFailed': '重启请求失败，请手动重启 DSH',

      'err.already-exists': '目标已存在',
      'err.target-exists': '目标已存在',
      'err.no-parent': '上级目录不存在',
      'err.invalid-path': '路径不合法',
      'err.outside-root': '路径超出工作区',
      'err.protected-path': '受保护路径（.git）',
      'err.root-itself': '不能删除工作区根目录',
      'err.is-directory-needs-recursive': '目录需要勾选递归删除',
      'err.not-directory': '不是目录',
      'err.not-found': '路径不存在',
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
      'fm.title': 'Files',
      'fm.search': 'Search file names…',
      'fm.searchHint': 'Fuzzy matching: "mnts" also finds main.ts',
      'fm.sortName': 'Name',
      'fm.sortTime': 'Modified',
      'fm.sortSize': 'Size',
      'fm.sortAsc': 'Ascending',
      'fm.sortDesc': 'Descending',
      'fm.onlyChanged': 'Changed only',
      'fm.showIgnored': 'Show ignored folders',
      'fm.refresh': 'Refresh',
      'fm.newFile': 'New file',
      'fm.newDir': 'New folder',
      'fm.rename': 'Rename',
      'fm.delete': 'Delete',
      'fm.loading': 'Reading files…',
      'fm.empty': 'This folder is empty',
      'fm.emptySearch': 'No matching files',
      'fm.noWorkspace': 'No workspace to browse',
      'fm.pickWorkspace': 'Workspace',
      'fm.truncated': 'Too many files — showing the first {n}',
      'fm.summary': '{files} files · {dirs} folders',
      'fm.changed': '{n} files changed',
      'fm.clean': 'Matches the remote',
      'fm.openHint': 'Click a file to edit it, a folder to enter it',
      'fm.newFileTitle': 'New file',
      'fm.newDirTitle': 'New folder',
      'fm.renameTitle': 'Rename',
      'fm.name': 'Name',
      'fm.createAt': 'Created in {dir}',
      'fm.cancel': 'Cancel',
      'fm.confirm': 'OK',
      'fm.busy': 'Working…',
      'fm.created': 'Created {name}',
      'fm.renamed': 'Renamed',
      'fm.deleted': 'Deleted {name}',
      'fm.deleteTitle': 'Delete "{name}"?',
      'fm.deleteHint': 'This cannot be undone. A folder is deleted together with its contents.',
      'fm.recursive': 'I understand this deletes the folder recursively',
      'fm.dir': 'Folder',
      'fm.link': 'Link',
      'fm.rootBadge': 'workspace',
      'fm.restartNeeded': 'The file panel needs one DSH Desktop restart to load its Host routes.',
      'fm.restartHint': 'After installing or upgrading Host code, the running process still uses the old module; restart once and it works.',
      'fm.restartButton': 'Restart DSH',
      'fm.restartConfirm': 'Restart DSH Desktop now? The app restarts; this Session is preserved.',
      'fm.restarting': 'Restarting…',
      'fm.restartFailed': 'Restart request failed — please restart DSH manually',

      'err.already-exists': 'Target already exists',
      'err.target-exists': 'Target already exists',
      'err.no-parent': 'Parent folder does not exist',
      'err.invalid-path': 'Invalid path',
      'err.outside-root': 'Path is outside the workspace',
      'err.protected-path': 'Protected path (.git)',
      'err.root-itself': 'Cannot delete the workspace root',
      'err.is-directory-needs-recursive': 'Confirm recursive deletion for a folder',
      'err.not-directory': 'Not a folder',
      'err.not-found': 'Path not found',
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
.dsh-ef-fm-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10))}
.dsh-ef-fm-row[data-selected="1"]{background:rgba(36,123,191,.10)}
.dsh-ef-fm-actions{opacity:0;transition:opacity .12s ease}
.dsh-ef-fm-row:hover .dsh-ef-fm-actions,.dsh-ef-fm-row:focus-within .dsh-ef-fm-actions{opacity:1}
.dsh-ef-fm-input:focus{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:-1px}
.dsh-ef-fm-input::placeholder{color:var(--dsw-alias-label-tertiary,#71717a)}
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
      t: (key) => key,
      openEditor: () => {},
      openGitTab: () => {},
      notifySaved: () => {},
    };

    /** git 侧刷新信号：编辑保存 / 手动刷新时 +1，徽标与面板据此重读。 */
    const gitBump = createStore(0);
    function bumpGit() {
      gitBump.set((value) => value + 1);
    }

    /** 渲染期异常：槽位里抛错会被错误边界接住，不连累别的插件，也方便自检回报。 */
    const renderIssues = [];
    function recordIssue(label, error) {
      console.error(LOG + label + ' 渲染失败：', error);
      renderIssues.push({
        label,
        at: new Date().toISOString(),
        message: error && error.message ? error.message : String(error),
      });
      if (renderIssues.length > 20) renderIssues.shift();
    }

    /** 工作区索引：workspaceId → { path, title, sessionIds }，由无渲染桥组件持续维护。 */
    const workspaceIndex = new Map();

    /** 工作区分组菜单的 DOM 增强是否装上了，供自检回报。 */
    let workspaceMenuBridgeActive = false;

    /** 工作区菜单增强的最近事件（自检用，最多 30 条）。 */
    const menuBridgeLog = [];
    function logMenuBridge(entry) {
      menuBridgeLog.push({ at: new Date().toISOString(), ...entry });
      if (menuBridgeLog.length > 30) menuBridgeLog.shift();
    }

    /**
     * 槽位组件错误边界：一个入口渲染炸了只让那一个入口消失，别把别人的 slot 带走。
     * @param {{ label: string, children: any }} props
     */
    class SlotBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error) {
        recordIssue(this.props.label, error);
      }
      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    function guarded(label, Component) {
      return function GuardedEntry(props) {
        return h(SlotBoundary, { label }, h(Component, props));
      };
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
        case 'already-exists':
        case 'target-exists':
        case 'no-parent':
        case 'invalid-path':
        case 'outside-root':
        case 'protected-path':
        case 'root-itself':
        case 'is-directory-needs-recursive':
        case 'not-directory':
        case 'not-found':
          return translate(t, `err.${reason}`);
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

    // ───────────────────────────────────────────────────────── 工作区桥 / 会话行标记

    /**
     * 无渲染桥：把 useWorkspaces 的实时快照搬进模块级 workspaceIndex，
     * 供工作区分组菜单的 DOM 增强在 React 之外按 workspaceId 找到目录路径。
     */
    const WorkspaceBridge = (props) => {
      const useWorkspaces = props.useWorkspaces;
      const snapshot = useWorkspaces((state) => state);
      useEffect(() => {
        workspaceIndex.clear();
        const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
        for (const item of items) {
          if (item === null || typeof item !== 'object' || typeof item.workspaceId !== 'string') continue;
          workspaceIndex.set(item.workspaceId, {
            path: typeof item.path === 'string' ? item.path : null,
            title: typeof item.title === 'string' ? item.title : '',
            sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.slice() : [],
          });
        }
      }, [snapshot]);
      return null;
    };

    /**
     * 会话行 hover 按钮：该会话工作区是 git 仓库时显示 git 图标 + 改动数，
     * 点击打开「Git 改动」页。非仓库时什么都不渲染（需求：没有 git 就不展示）。
     */
    const SessionRowGitAction = (props) => {
      const t = props.t;
      const sessionId = props.sessionId;
      const useWorkspaces = props.useWorkspaces;
      const path = useWorkspaces((snapshot) => workspacePathOf(snapshot, sessionId));
      const changes = useGitChanges(path, { pollMs: 30000 });
      const data = changes.data;

      const onClick = useCallback(() => {
        if (data === null || data === undefined || data.isRepo !== true) return;
        runtime.openGitTab(sessionId, data.root || path || '');
      }, [data, sessionId, path]);

      if (data === null || data === undefined || data.isRepo !== true) return null;
      const total = data.totals ? data.totals.files : Array.isArray(data.files) ? data.files.length : 0;
      return h(
        ToolButton,
        {
          title: `${translate(t, 'action.git')}${data.branch ? ` · ${data.branch}` : ''}${total > 0 ? ` · ${translate(t, 'git.files', { n: total })}` : ` · ${translate(t, 'git.clean')}`}`,
          onClick,
          style: { width: '18px', height: '18px', minWidth: '18px', padding: 0, gap: 0, color: total > 0 ? WARN : INK_3 },
        },
        h(IconGit, { size: 13 }),
        total > 0
          ? h('span', { style: { fontSize: '10px', lineHeight: '1', fontVariantNumeric: 'tabular-nums' } }, String(total))
          : null,
      );
    };

    // ───────────────────────────────────────────────────────── 工作区分组菜单（DOM 增强）

    /**
     * DSH 这一版的「工作区分组标题 ⋯ 菜单」是 ui-workspace 里写死的两项（重命名 / 删除工作区），
     * 没有给插件留 slot。要在这张菜单里加「Git 改动」，只能在菜单打开时把一行补进它的 DOM：
     *   · 克隆一个自带样式的原生菜单行（外观与键盘走查跟原生一致）；
     *   · 行内容换成 git 图标 + 「Git 改动」(+ 改动数)；
     *   · 只在该工作区确实是 git 仓库时插入（非仓库不展示）。
     * 全程 try/catch：DSH 改版导致结构对不上时最多是这个增强失效，不影响别处。
     */
    const WORKSPACE_ROW = '[data-row-key^="workspace:"]';
    const MENU_MARK = 'data-edit-files-menu';
    const REPO_CACHE_TTL = 15000;
    const repoCache = new Map();

    const GIT_MENU_ICON =
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="4.5" cy="3.5" r="1.8"/><circle cx="4.5" cy="12.5" r="1.8"/><circle cx="11.5" cy="6.5" r="1.8"/>' +
      '<path d="M4.5 5.3v5.4"/><path d="M9.7 6.5c-2.2 0-3.4.8-3.4 2.4"/></svg>';

    /** 带缓存的仓库查询：菜单增强与会话行标记共用一次 /git/changes 的结果。 */
    async function repoStatusOf(path) {
      if (typeof path !== 'string' || path.length === 0) return null;
      const cached = repoCache.get(path);
      if (cached !== undefined && Date.now() - cached.at < REPO_CACHE_TTL) return cached.data;
      const result = await apiGet('/git/changes', { path });
      const data = result.ok === true ? result : null;
      repoCache.set(path, { at: Date.now(), data });
      if (repoCache.size > 60) {
        const oldest = repoCache.keys().next();
        if (oldest.done !== true) repoCache.delete(oldest.value);
      }
      return data;
    }

    /** 屏幕上的会话 id（有的话），用来优先在「当前会话」里打开 Git 改动页。 */
    function onScreenSessionId() {
      const ctx = runtime.ctx;
      if (ctx === null || ctx.sidebarRight === undefined) return undefined;
      try {
        const mounted = ctx.sidebarRight.mounted;
        const value =
          typeof mounted === 'function'
            ? mounted()
            : mounted !== null && mounted !== undefined && typeof mounted.getSnapshot === 'function'
              ? mounted.getSnapshot()
              : mounted;
        return typeof value === 'string' && value.length > 0 ? value : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * 装菜单增强：记录「用户刚点了哪个工作区行的 ⋯」，等菜单 portal 出现时补一行 Git 改动。
     * @returns 卸载函数
     */
    function installWorkspaceMenuBridge() {
      if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return () => {};
      let pendingToken = null;
      let pendingAt = 0;

      const onClick = (event) => {
        try {
          const target = event.target;
          const row = target instanceof Element ? target.closest(WORKSPACE_ROW) : null;
          if (row === null) {
            pendingToken = null;
            pendingAt = 0;
            return;
          }
          const raw = row.getAttribute('data-row-key') || '';
          pendingToken = raw.slice('workspace:'.length);
          pendingAt = Date.now();
          logMenuBridge({ type: 'workspace-click', token: pendingToken });
        } catch {
          /* 忽略 */
        }
      };

      const addRow = (menu, data, record) => {
        const viewport = menu.querySelector('[role="presentation"]') || menu.firstElementChild;
        if (viewport === null) return;
        const template = viewport.querySelector('button[role="menuitem"]');
        if (template === null) return;
        const wrap = template.parentElement;
        if (wrap === null || wrap === viewport) return;

        const clone = wrap.cloneNode(true);
        clone.setAttribute(MENU_MARK, '1');
        const button = clone.querySelector('button[role="menuitem"]');
        if (button === null) return;
        button.removeAttribute('aria-keyshortcuts');
        button.removeAttribute('aria-haspopup');
        button.removeAttribute('aria-expanded');
        button.removeAttribute('disabled');

        const slots = button.querySelectorAll(':scope > span');
        const iconSlot = slots.length > 0 ? slots[0] : null;
        const labelSlot = slots.length > 1 ? slots[1] : null;
        if (iconSlot !== null) iconSlot.innerHTML = GIT_MENU_ICON;
        if (labelSlot !== null) labelSlot.textContent = translate(runtime.t, 'action.git');

        const total = data.totals && typeof data.totals.files === 'number' ? data.totals.files : 0;
        if (total > 0) {
          const badge = document.createElement('span');
          badge.textContent = String(total);
          badge.style.marginLeft = 'auto';
          badge.style.fontSize = '11px';
          badge.style.color = WARN;
          badge.style.fontVariantNumeric = 'tabular-nums';
          button.appendChild(badge);
        }

        button.addEventListener(
          'click',
          (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
              const list = Array.isArray(record.sessionIds) ? record.sessionIds : [];
              const current = onScreenSessionId();
              const target = current !== undefined && list.indexOf(current) >= 0 ? current : list.length > 0 ? list[0] : undefined;
              runtime.openGitTab(target, data.root || record.path);
            } catch (error) {
              console.warn(LOG + '菜单项动作失败：', error);
            }
            try {
              menu.style.display = 'none';
            } catch {
              /* 忽略 */
            }
          },
          true,
        );

        viewport.insertBefore(clone, viewport.firstChild);
      };

      const inject = async (menu) => {
        try {
          if (!(menu instanceof Element) || !menu.isConnected) return;
          if (menu.querySelector(`[${MENU_MARK}]`) !== null) return;
          if (pendingToken === null || Date.now() - pendingAt > 1500) return;
          const record = workspaceIndex.get(pendingToken);
          if (record === undefined || typeof record.path !== 'string' || record.path.length === 0) {
            logMenuBridge({ type: 'skip', reason: 'no-workspace-record', token: pendingToken });
            return;
          }
          // 会话「⋯」菜单里已经有 slot 版「Git 改动」了，别重复
          const label = translate(runtime.t, 'action.git');
          if (typeof menu.textContent === 'string' && menu.textContent.indexOf(label) >= 0) {
            logMenuBridge({ type: 'skip', reason: 'already-has-git-row', token: pendingToken });
            return;
          }
          const data = await repoStatusOf(record.path);
          if (data === null || data.isRepo !== true) {
            logMenuBridge({ type: 'skip', reason: data === null ? 'git-query-failed' : 'not-a-repo', token: pendingToken, path: record.path });
            return;
          }
          if (!menu.isConnected) {
            logMenuBridge({ type: 'skip', reason: 'menu-closed', token: pendingToken });
            return;
          }
          if (menu.querySelector(`[${MENU_MARK}]`) !== null) return;
          addRow(menu, data, record);
          logMenuBridge({ type: 'injected', token: pendingToken, path: record.path, files: data.totals ? data.totals.files : 0 });
        } catch (error) {
          console.warn(LOG + '工作区菜单增强失败：', error);
          logMenuBridge({ type: 'error', message: error && error.message ? error.message : String(error) });
        }
      };

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            const menu = node.matches('[role="menu"]') ? node : node.querySelector('[role="menu"]');
            if (menu === null) continue;
            setTimeout(() => {
              inject(menu).catch(() => {});
            }, 0);
          }
        }
      });

      document.addEventListener('click', onClick, true);
      observer.observe(document.body, { childList: true, subtree: true });
      workspaceMenuBridgeActive = true;
      return () => {
        workspaceMenuBridgeActive = false;
        document.removeEventListener('click', onClick, true);
        observer.disconnect();
      };
    }

    // ───────────────────────────────────────────────────────── 自检 inspect provider

    /** 程序化打开编辑器浮层 → 观察 → （可选）写入保存 → 关闭。 */
    async function editorSelfTest(input) {
      const filePath = input !== null && typeof input === 'object' && typeof input.path === 'string' ? input.path : undefined;
      const writeText = input !== null && typeof input === 'object' && typeof input.writeText === 'string' ? input.writeText : undefined;
      const result = { ok: false, path: filePath, phase: null, hasPanel: false, hasTextarea: false, valueLength: 0, savePhase: null, saveError: null, readBack: null, closed: false, issues: [] };
      if (filePath === undefined) return result;
      editorActions.open(filePath);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const state = editorStore.get();
      result.phase = state.phase;
      result.hasPanel = document.querySelector('.dsh-ef-editor') !== null;
      const textarea = document.querySelector('textarea.dsh-ef-ta');
      result.hasTextarea = textarea !== null;
      result.valueLength = textarea !== null && typeof textarea.value === 'string' ? textarea.value.length : state.content.length;
      if (writeText !== undefined && state.phase === 'ready') {
        editorActions.setText(writeText);
        await editorActions.save(false);
        await new Promise((resolve) => setTimeout(resolve, 400));
        const after = editorStore.get();
        result.savePhase = after.savePhase;
        result.saveError = after.saveError;
        const readBack = await apiPost('/file/read', { path: filePath });
        result.readBack = readBack.ok === true ? readBack.content === writeText : false;
      }
      editorActions.forceClose();
      await new Promise((resolve) => setTimeout(resolve, 200));
      result.closed = editorStore.get().open !== true && document.querySelector('.dsh-ef-editor') === null;
      result.ok = result.phase === 'ready' && result.hasPanel && result.closed;
      result.issues = renderIssues.slice(-5);
      return result;
    }

    /** 程序化打开「Git 改动」页 → 观察正文 → 关闭，返回结果。 */
    async function openTabSelfTest(pathHint) {
      const ctx = runtime.ctx;
      const result = { ok: false, sessionId: null, before: [], after: [], sawBase: false, sawFiles: false, sawSummary: false, tabIds: [], issues: [] };
      if (ctx === null || ctx.sidebarRight === undefined) return result;
      let sessionId = onScreenSessionId();
      if (sessionId === undefined) {
        for (const record of workspaceIndex.values()) {
          if (Array.isArray(record.sessionIds) && record.sessionIds.length > 0) {
            sessionId = record.sessionIds[0];
            break;
          }
        }
      }
      result.sessionId = sessionId;
      const tabsOf = (id) => {
        try {
          return id === undefined ? [] : ctx.sidebarRight.tabsIn(id).map((tab) => ({ id: tab.id, kind: tab.kind, title: tab.title }));
        } catch {
          return [];
        }
      };
      result.before = tabsOf(sessionId);
      try {
        runtime.openGitTab(sessionId, pathHint || undefined);
      } catch (error) {
        result.issues.push(String(error && error.message ? error.message : error));
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      result.after = tabsOf(sessionId);
      const text = typeof document.body.innerText === 'string' ? document.body.innerText : '';
      result.sawBase = text.includes('对比') || text.includes(' vs ');
      result.sawFiles = text.includes('package.json') || text.includes('README.md') || text.includes('个文件') || text.includes(' files');
      result.sawSummary = text.includes('origin/main');
      result.issues = renderIssues.slice(-5);
      // 恢复原状：把这次打开的本插件标签页关掉
      for (const tab of result.after) {
        if (tab.kind !== TAB_KIND || result.before.some((old) => old.id === tab.id)) continue;
        try {
          ctx.sidebarRight.close(tab.id);
        } catch {
          /* 忽略 */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      result.ok = result.after.some((tab) => tab.kind === TAB_KIND);
      return result;
    }

    /** 在临时目录里跑一遍四条文件路由（自建自删）。 */
    async function filesSelfTest(input) {
      const root = input !== null && typeof input === 'object' && typeof input.root === 'string' ? input.root : '';
      const result = { root, steps: {} };
      if (root.length === 0) return result;
      const step = async (name, request) => {
        const answer = await request();
        result.steps[name] = answer.ok === true
          ? { ok: true, reason: null }
          : { ok: false, reason: answer.reason, error: answer.error };
        return answer;
      };
      await step('mkdir', () => apiPost('/files/create', { root, rel: 'dsh-selftest-dir', kind: 'dir' }));
      await step('create-file', () => apiPost('/files/create', { root, rel: 'dsh-selftest-dir/a.txt', kind: 'file', content: 'hello' }));
      await step('tree', async () => {
        const tree = await apiGet('/files/tree', { root, includeIgnored: '1' });
        if (tree.ok !== true) return tree;
        const hasFile = Array.isArray(tree.entries) && tree.entries.some((entry) => entry.rel === 'dsh-selftest-dir/a.txt');
        const hasDir = Array.isArray(tree.entries) && tree.entries.some((entry) => entry.rel === 'dsh-selftest-dir' && entry.type === 'dir');
        return hasFile && hasDir ? { ok: true } : { ok: false, reason: 'tree-missing-entry', counts: tree.counts };
      });
      await step('read-back', async () => {
        const read = await apiPost('/file/read', { path: `${root}/dsh-selftest-dir/a.txt` });
        return read.ok === true && read.content === 'hello' ? { ok: true } : { ok: false, reason: 'content-mismatch' };
      });
      await step('rename', () => apiPost('/files/rename', { root, from: 'dsh-selftest-dir/a.txt', to: 'dsh-selftest-dir/b.txt' }));
      await step('delete-recursive', () => apiPost('/files/delete', { root, rel: 'dsh-selftest-dir', recursive: true }));
      await step('delete-nonrecursive-guard', async () => {
        await apiPost('/files/create', { root, rel: 'dsh-selftest-dir2', kind: 'dir' });
        const refused = await apiPost('/files/delete', { root, rel: 'dsh-selftest-dir2' });
        const cleaned = await apiPost('/files/delete', { root, rel: 'dsh-selftest-dir2', recursive: true });
        if (refused.ok === true) return { ok: false, reason: 'directory-deleted-without-recursive' };
        return cleaned.ok === true ? { ok: true } : cleaned;
      });
      result.ok = Object.values(result.steps).every((entry) => entry.ok === true);
      return result;
    }

    /** 切到文件面板 → 观察渲染 → 可选点文件 → 切回对话。 */
    async function panelSelfTest(input) {
      const openFile = input !== null && typeof input === 'object' && input.openFile === true;
      const ctx = runtime.ctx;
      const result = { switched: false, rendered: false, rows: 0, searchInput: false, clickedFile: null, editorOpened: false, restored: false, issues: [], text: '' };
      // layout 没写进插件 inject（只在这个自检里用），用 get 拿，不阻塞正常加载。
      const layout = ctx === null ? undefined : typeof ctx.get === 'function' ? ctx.get('layout') : ctx.layout;
      if (layout === undefined || layout === null || typeof layout.selectPanel !== 'function') return result;
      try {
        layout.selectPanel(PANEL_ID);
        result.switched = true;
      } catch (error) {
        result.issues.push(String(error && error.message ? error.message : error));
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const panel = document.querySelector('[data-edit-files-panel]');
      result.rendered = panel !== null;
      if (panel !== null) {
        result.rows = panel.querySelectorAll('.dsh-ef-fm-row').length;
        result.searchInput = panel.querySelector('input.dsh-ef-fm-input') !== null;
        result.text = (panel.innerText || '').slice(0, 400);
        if (openFile) {
          const row = panel.querySelector('.dsh-ef-fm-row');
          if (row !== null) {
            result.clickedFile = row.getAttribute('title');
            row.click();
            await new Promise((resolve) => setTimeout(resolve, 900));
            result.editorOpened = document.querySelector('.dsh-ef-editor') !== null;
            editorActions.forceClose();
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      }
      try {
        layout.selectPanel('conversation');
        await new Promise((resolve) => setTimeout(resolve, 300));
        result.restored = document.querySelector('[data-edit-files-panel]') === null;
      } catch {
        /* 忽略 */
      }
      result.issues = renderIssues.slice(-5);
      return result;
    }

    /** 页面上与本插件相关的控件清单（只读，供 dom 自检）。 */
    function domSnapshot() {
      const pick = (selector) => {
        try {
          return [...document.querySelectorAll(selector)].map((element) => ({
            aria: element.getAttribute('aria-label'),
            tag: element.tagName.toLowerCase(),
          }));
        } catch {
          return [];
        }
      };
      return {
        workspaceRows: (() => {
          try {
            return [...document.querySelectorAll(WORKSPACE_ROW)].map((row) => row.getAttribute('data-row-key'));
          } catch {
            return [];
          }
        })(),
        workspaceIndex: [...workspaceIndex.entries()].map(([id, record]) => ({ id, path: record.path, sessions: record.sessionIds.length })),
        gitButtons: pick('[aria-label*="Git 改动"], [aria-label*="Git changes"]'),
        editButtons: pick('[aria-label="编辑"], [aria-label="Edit"]'),
        openMenus: (() => {
          try {
            return [...document.querySelectorAll('[role="menu"]')].map((menu) => ({
              items: [...menu.querySelectorAll('button[role="menuitem"]')].map((button) => (button.textContent || '').trim()),
              injected: menu.querySelector(`[${MENU_MARK}]`) !== null,
            }));
          } catch {
            return [];
          }
        })(),
        menuBridge: { active: workspaceMenuBridgeActive, log: menuBridgeLog.slice(-20) },
      };
    }

    /** 程序化点开「⋯」菜单 → 等待增强注入 → 关掉菜单，返回观察结果。 */
    async function menuSelfTest(pathHint) {
      const result = { requested: pathHint || null, workspaceId: null, trigger: null, opened: false, injected: false, menuText: null, log: [] };
      let workspaceId = null;
      if (typeof pathHint === 'string' && pathHint.length > 0) {
        for (const [id, record] of workspaceIndex.entries()) {
          if (record.path === pathHint) {
            workspaceId = id;
            break;
          }
        }
      }
      if (workspaceId === null) {
        for (const [id, record] of workspaceIndex.entries()) {
          if (typeof record.path === 'string') {
            workspaceId = id;
            break;
          }
        }
      }
      if (workspaceId === null) {
        result.log = menuBridgeLog.slice(-10);
        return result;
      }
      result.workspaceId = workspaceId;
      const row = document.querySelector(`[data-row-key="workspace:${workspaceId}"]`);
      if (row === null) {
        result.log = menuBridgeLog.slice(-10);
        return result;
      }
      const buttons = [...row.querySelectorAll('button')];
      const trigger = buttons.length > 0 ? buttons[0] : null;
      if (trigger === null) {
        result.log = menuBridgeLog.slice(-10);
        return result;
      }
      result.trigger = trigger.getAttribute('aria-label');
      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      const menu = document.querySelector('[role="menu"]');
      result.opened = menu !== null;
      if (menu !== null) {
        result.menuText = (menu.textContent || '').trim().slice(0, 200);
        result.injected = menu.querySelector(`[${MENU_MARK}]`) !== null;
        // 关掉菜单：Escape 交给菜单自己的关闭逻辑
        try {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
          menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        } catch {
          /* 忽略 */
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (menu.isConnected) {
          try {
            menu.style.display = 'none';
          } catch {
            /* 忽略 */
          }
        }
      }
      result.log = menuBridgeLog.slice(-12);
      return result;
    }

    /**
     * 给 cordis_inspect 提供一个只读自检入口（client 侧）：从「当前页面」的视角请求
     * /api/edit-files/*，回报 Host 路由是否可达、git 结果、渲染异常与工作区索引规模。
     * 排查「按钮没出现」时不用靠猜。
     */
    function installInspectProvider(ctx) {
      ctx.inject(['cordisInspect'], (inspectCtx) => {
        const registry = inspectCtx.cordisInspect;
        if (registry === undefined || registry === null || typeof registry.register !== 'function') return () => {};
        return ctx.effect(
          () =>
            registry.register({
              manifest: {
                id: 'EditFiles',
                description:
                  'dsh-plugin-edit-files 的只读自检：从当前页面请求 /api/edit-files/*，回报 Host 路由可达性、示例路径的 git 结果与客户端渲染错误。',
                methods: [
                  {
                    name: 'probe',
                    description: '从浏览器页面视角探测插件 Host 路由与自身状态。',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        path: { type: 'string', description: '可选的绝对路径，用于顺带查询 git 信息' },
                      },
                      additionalProperties: false,
                    },
                    outputSchema: { description: '探测结果：页面地址、health、git、渲染异常等。' },
                  },
                  {
                    name: 'dom',
                    description: '只读列出页面上本插件渲染出来的控件（会话头部/会话行/文件树/预览工具栏）与工作区菜单增强日志。',
                    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                    outputSchema: { description: 'DOM 探测结果。' },
                  },
                  {
                    name: 'menuSelfTest',
                    description: '自动化自检：程序化点开某个工作区分组的「⋯」菜单，确认 Git 改动行被补进去，然后关掉菜单。',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        path: { type: 'string', description: '可选的工作区绝对路径；省略时取第一个 git 工作区' },
                      },
                      additionalProperties: false,
                    },
                    outputSchema: { description: '自检结果：是否注入、菜单文本、日志。' },
                  },
                  {
                    name: 'editorSelfTest',
                    description: '自动化自检：打开编辑器浮层读一个文件，可选写入一段文本并保存，最后关掉浮层。',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        path: { type: 'string', description: '要打开的文件绝对路径' },
                        writeText: { type: 'string', description: '可选：写入并保存这段文本（省略则只读不写）' },
                      },
                      required: ['path'],
                      additionalProperties: false,
                    },
                    outputSchema: { description: '自检结果：浮层是否出现、保存状态、读回内容是否一致。' },
                  },
                  {
                    name: 'filesSelfTest',
                    description: '自动化自检：在一个临时目录里跑一遍 files/tree + create + rename + delete 四条 Host 路由（会清理自己创建的东西）。',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        root: { type: 'string', description: '一个已存在、可写的临时目录绝对路径' },
                      },
                      required: ['root'],
                      additionalProperties: false,
                    },
                    outputSchema: { description: '自检结果：每一步是否成功。' },
                  },
                  {
                    name: 'panelSelfTest',
                    description: '自动化自检：切到「文件」主面板，确认文件列表渲染出来；可选点一个文件验证编辑浮层，然后切回对话页。',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        openFile: { type: 'boolean', description: '是否顺带点一个文件打开编辑器' },
                      },
                      additionalProperties: false,
                    },
                    outputSchema: { description: '自检结果：面板是否渲染、行数、点文件是否打开编辑器。' },
                  },
                  {
                    name: 'openTabSelfTest',
                    description: '自动化自检：短暂打开「Git 改动」右栏标签页，确认正文渲染出基准/文件列表，然后关掉标签页恢复原状。',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        path: { type: 'string', description: '可选的工作区绝对路径' },
                      },
                      additionalProperties: false,
                    },
                    outputSchema: { description: '自检结果：标签页是否打开、正文关键文本、渲染异常。' },
                  },
                ],
              },
              async query(method, input) {
                const path = input !== null && typeof input === 'object' && typeof input.path === 'string' ? input.path : undefined;
                if (method === 'probe') {
                  const probe = {
                    pageUrl: typeof window !== 'undefined' && window.location ? window.location.href : null,
                    plugin: 'dsh-plugin-edit-files',
                    workspaceIndexSize: workspaceIndex.size,
                    workspaceMenuBridgeActive,
                    renderIssues: renderIssues.slice(-10),
                    health: null,
                    git: null,
                  };
                  probe.health = await apiGet('/health');
                  if (path !== undefined) {
                    const tree = await apiGet('/files/tree', { root: path, limit: '50' });
                    probe.files = {
                      ok: tree.ok === true,
                      counts: tree.ok === true ? tree.counts : null,
                      truncated: tree.ok === true ? tree.truncated === true : null,
                      entries: tree.ok === true && Array.isArray(tree.entries) ? tree.entries.length : 0,
                      error: tree.ok === true ? null : tree,
                    };
                    const info = await apiGet('/git/info', { path });
                    const changes = await apiGet('/git/changes', { path });
                    const file = await apiGet('/git/file', { path });
                    probe.git = {
                      info,
                      changes: {
                        ok: changes.ok === true,
                        isRepo: changes.isRepo === true,
                        base: changes.base,
                        totals: changes.totals,
                        files: Array.isArray(changes.files) ? changes.files.length : 0,
                      },
                      file: { ok: file.ok === true, isRepo: file.isRepo === true, changed: file.file !== null && file.file !== undefined },
                    };
                  }
                  return probe;
                }
                if (method === 'dom') {
                  return domSnapshot();
                }
                if (method === 'menuSelfTest') {
                  return await menuSelfTest(path);
                }
                if (method === 'openTabSelfTest') {
                  return await openTabSelfTest(path);
                }
                if (method === 'filesSelfTest') {
                  return await filesSelfTest(input);
                }
                if (method === 'panelSelfTest') {
                  return await panelSelfTest(input);
                }
                if (method === 'editorSelfTest') {
                  return await editorSelfTest(input);
                }
                throw new Error(`unknown EditFiles inspect method "${String(method)}"`);
              },
            }),
          'edit-files: inspect provider',
        );
      });
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

    // ───────────────────────────────────────────────────────── 工程文件面板（主面板）

    /** 主面板 id：同时用于 `main`（keyed）与 `sidebar.panellist`（id）两个注册。 */
    const PANEL_ID = 'edit-files-browser';
    const ROOT_STORAGE_KEY = 'dsh-edit-files.root';

    function readStoredRoot() {
      try {
        return window.localStorage.getItem(ROOT_STORAGE_KEY) || '';
      } catch {
        return '';
      }
    }

    function storeRoot(path) {
      try {
        if (typeof path === 'string' && path.length > 0) window.localStorage.setItem(ROOT_STORAGE_KEY, path);
      } catch {
        /* localStorage 不可用就算了 */
      }
    }

    /** WorkspaceSnapshot → [{workspaceId, path, title, sessionIds}]（顺序即侧栏顺序）。 */
    function workspaceListOf(snapshot) {
      const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
      const list = [];
      for (const item of items) {
        if (item === null || typeof item !== 'object' || typeof item.path !== 'string') continue;
        list.push({
          workspaceId: item.workspaceId,
          path: item.path,
          title: typeof item.title === 'string' && item.title.length > 0 ? item.title : basename(item.path),
          sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds : [],
        });
      }
      return list;
    }

    /** 会话快照里「主视图正挂着」的那个会话（也就是屏幕上的会话）。 */
    function currentSessionIdOf(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return undefined;
      const byId = snapshot.byId;
      if (byId === null || typeof byId !== 'object') return undefined;
      for (const id of Object.keys(byId)) {
        const row = byId[id];
        if (row && row.retainedBy && (row.retainedBy.mainView ?? 0) > 0) return id;
      }
      return undefined;
    }

    function trimSlashes(value) {
      return String(value || '')
        .replace(/\\/gu, '/')
        .replace(/^\/+/u, '')
        .replace(/\/+$/u, '');
    }

    function joinRel(base, name) {
      const head = trimSlashes(base);
      const tail = trimSlashes(name);
      if (head.length === 0) return tail;
      if (tail.length === 0) return head;
      return `${head}/${tail}`;
    }

    function dirOfRel(rel) {
      const normalized = trimSlashes(rel);
      const index = normalized.lastIndexOf('/');
      return index < 0 ? '' : normalized.slice(0, index);
    }

    function rootPathOf(root, rel) {
      const base = String(root || '').replace(/\/+$/u, '');
      const tail = trimSlashes(rel);
      return tail.length === 0 ? base : `${base}/${tail}`;
    }

    function formatMtime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
      const date = new Date(ms);
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function formatSizeShort(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
      if (bytes < 1024) return `${bytes}B`;
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
      return `${(bytes / 1024 / 1024).toFixed(1)}M`;
    }

    /**
     * 模糊匹配：needle 的字符按顺序出现在 haystack 里才算命中，
     * 连续命中 / 词首命中 / 基名命中加分；不命中返回 null。
     * @param {string} needle 用户输入
     * @param {string} haystack 候选（相对路径）
     * @returns {number|null}
     */
    function fuzzyScore(needle, haystack) {
      const query = String(needle || '').toLowerCase();
      const text = String(haystack || '').toLowerCase();
      if (query.length === 0) return 0;
      if (query.length > text.length) return null;
      let score = 0;
      let cursor = 0;
      let previous = -1;
      for (const char of query) {
        let found = -1;
        for (let index = cursor; index < text.length; index += 1) {
          if (text[index] === char) {
            found = index;
            break;
          }
        }
        if (found < 0) return null;
        score += 1;
        if (found === previous + 1) score += 3;
        if (found === 0 || text[found - 1] === '/' || text[found - 1] === '.' || text[found - 1] === '_' || text[found - 1] === '-') score += 2;
        previous = found;
        cursor = found + 1;
      }
      const slash = text.lastIndexOf('/');
      if (slash >= 0 && previous > slash) score += 2;
      score -= Math.min(8, Math.round(text.length / 40));
      return score;
    }

    // ── 面板图标 ──

    const IconFolder = (props) =>
      svg(props, [h('path', { key: 'a', d: 'M2 4.2h4.1l1.3 1.8H14v7.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.2z' })]);
    const IconFolderOpen = (props) =>
      svg(props, [
        h('path', { key: 'a', d: 'M2 4.2h4.1l1.3 1.8H14v1.4H5.3L3.6 13H2V4.2z' }),
        h('path', { key: 'b', d: 'M5.3 7.4h9.2L12.8 13H2.9l2.4-5.6z' }),
      ]);
    const IconLinkFile = (props) =>
      svg(props, [
        h('path', { key: 'a', d: 'M6.2 9.8a2.6 2.6 0 0 1 0-3.7l1.6-1.6' }),
        h('path', { key: 'b', d: 'M9.2 9.8l1.6-1.6a2.6 2.6 0 0 0-3.7-3.7' }),
        h('path', { key: 'c', d: 'M3 13h10' }),
      ]);
    const IconPlus = (props) => svg(props, [h('path', { key: 'a', d: 'M8 3v10M3 8h10' })]);
    const IconSearch = (props) =>
      svg(props, [
        h('circle', { key: 'a', cx: 7, cy: 7, r: 4.2 }),
        h('path', { key: 'b', d: 'M10.2 10.2L14 14' }),
      ]);
    const IconTrash = (props) =>
      svg(props, [
        h('path', { key: 'a', d: 'M3 4.5h10M6.5 4.5V3h3v1.5' }),
        h('path', { key: 'b', d: 'M4.5 4.5l.7 8.2a1 1 0 0 0 1 .8h3.6a1 1 0 0 0 1-.8l.7-8.2' }),
      ]);
    const IconSortDown = (props) => svg(props, [h('path', { key: 'a', d: 'M8 3v10M4.5 9.5L8 13l3.5-3.5' })]);
    const IconSortUp = (props) => svg(props, [h('path', { key: 'a', d: 'M8 13V3M4.5 6.5L8 3l3.5 3.5' })]);
    const IconPencil = (props) =>
      svg(props, [h('path', { key: 'a', d: 'M10.5 2.5l3 3L5 14H2v-3l8.5-8.5z' }), h('path', { key: 'b', d: 'M9 4l3 3' })]);

    /** 左栏面板图标。 */
    const FileManagerIcon = (props) => h(IconFolder, { size: props.size || 18 });

    /** 一个文件/目录行的图标。 */
    function entryIcon(entry) {
      if (entry.type === 'dir') return h(IconFolder, { size: 15 });
      if (entry.type === 'symlink') return h(IconLinkFile, { size: 15 });
      return h(IconFile, { size: 15 });
    }

    // ── 小弹窗（新建 / 重命名 / 删除确认） ──

    function FileDialog({ t, dialog, busy, onCancel, onSubmit }) {
      const [name, setName] = useState(dialog.name || '');
      const [recursive, setRecursive] = useState(false);
      const inputRef = useRef(null);
      const isDelete = dialog.kind === 'delete';
      const isRename = dialog.kind === 'rename';
      const titleKey = isDelete ? 'fm.deleteTitle' : isRename ? 'fm.renameTitle' : dialog.kind === 'create-dir' ? 'fm.newDirTitle' : 'fm.newFileTitle';
      const vars = isDelete ? { name: dialog.name } : undefined;

      useEffect(() => {
        if (inputRef.current !== null) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, []);

      const canSubmit = isDelete ? (!dialog.isDir || recursive) && busy !== true : name.trim().length > 0 && busy !== true;

      const submit = () => {
        if (!canSubmit) return;
        onSubmit(isDelete ? { recursive } : { name: name.trim() });
      };

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 2400,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,.38)',
          },
          onClick: () => {
            if (busy !== true) onCancel();
          },
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': true,
            onClick: (event) => event.stopPropagation(),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                if (busy !== true) onCancel();
              }
              if (event.key === 'Enter' && !isDelete) {
                event.preventDefault();
                submit();
              }
            },
            style: {
              width: 'min(460px, calc(100vw - 48px))',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              padding: '18px',
              borderRadius: '12px',
              border: `1px solid ${LINE_2}`,
              background: BG_OVER,
              color: INK,
              boxShadow: '0 18px 48px rgba(0,0,0,.4)',
            },
          },
          h('div', { style: { fontSize: '14px', fontWeight: 600 } }, translate(t, titleKey, vars)),
          isDelete
            ? h('div', { style: { fontSize: '12.5px', color: INK_2, lineHeight: 1.6 } }, translate(t, 'fm.deleteHint'))
            : h(
                'input',
                {
                  ref: inputRef,
                  className: 'dsh-ef-fm-input',
                  value: name,
                  placeholder: translate(t, 'fm.name'),
                  onChange: (event) => setName(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      submit();
                    }
                  },
                  style: {
                    font: 'inherit',
                    fontSize: '13px',
                    padding: '7px 10px',
                    borderRadius: '7px',
                    border: `0.5px solid ${LINE_2}`,
                    background: BG_1,
                    color: INK,
                    outline: 'none',
                  },
                },
              ),
          isDelete && dialog.isDir === true
            ? h(
                'label',
                { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: WARN, cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked: recursive, onChange: (event) => setRecursive(event.target.checked) }),
                translate(t, 'fm.recursive'),
              )
            : null,
          !isDelete && dialog.cwd !== undefined
            ? h('div', { style: { fontSize: '11.5px', color: INK_3 } }, translate(t, 'fm.createAt', { dir: dialog.cwd || '/' }))
            : null,
          dialog.error !== undefined && dialog.error !== null
            ? h('div', { style: { fontSize: '12.5px', color: ERROR } }, reasonText(t, dialog.error.reason, dialog.error))
            : null,
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ef-btn',
                disabled: busy === true,
                onClick: onCancel,
                style: { ...S.btn, height: '28px', padding: '0 14px', border: `0.5px solid ${LINE_2}` },
              },
              translate(t, 'fm.cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ef-btn',
                disabled: !canSubmit,
                onClick: submit,
                style: { ...S.btn, ...(isDelete ? S.btnDanger : S.btnPrimary), height: '28px' },
              },
              busy === true ? translate(t, 'fm.busy') : translate(t, 'fm.confirm'),
            ),
          ),
        ),
      );
    }

    // ── 文件面板页 ──

    const FileManagerPage = (props) => {
      const t = props.t;
      const useWorkspaces = props.useWorkspaces;
      const useSessions = props.useSessions;
      const usePanelInfo = props.usePanelInfo;
      const workspaces = useWorkspaces((snapshot) => snapshot);
      const sessions = useSessions((snapshot) => snapshot);
      const panelInfo = usePanelInfo((snapshot) => snapshot);
      const bump = useStoreValue(gitBump, (value) => value);

      const workspaceList = useMemo(() => workspaceListOf(workspaces), [workspaces]);
      const currentSessionId = useMemo(() => currentSessionIdOf(sessions), [sessions]);
      const currentWorkspacePath = useMemo(() => workspacePathOf(workspaces, currentSessionId), [workspaces, currentSessionId]);
      const active = Boolean(panelInfo && panelInfo.activePanelId === PANEL_ID);

      const [root, setRoot] = useState(() => readStoredRoot());
      const [tree, setTree] = useState({ loading: false, data: null, error: null });
      const [changes, setChanges] = useState(null);
      const [refreshSeq, setRefreshSeq] = useState(0);
      const [cwd, setCwd] = useState('');
      const [query, setQuery] = useState('');
      const [sortKey, setSortKey] = useState('name');
      const [sortDir, setSortDir] = useState('asc');
      const [onlyChanged, setOnlyChanged] = useState(false);
      const [includeIgnored, setIncludeIgnored] = useState(false);
      const [selection, setSelection] = useState(null);
      const [dialog, setDialog] = useState(null);
      const [dialogBusy, setDialogBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const [restartPhase, setRestartPhase] = useState('idle');

      // 工作区：优先用持久化的；否则跟当前会话走；再不行取第一个。
      useEffect(() => {
        if (root.length > 0 && workspaceList.some((item) => item.path === root)) return;
        const fallback = currentWorkspacePath || (workspaceList.length > 0 ? workspaceList[0].path : '');
        if (fallback.length > 0 && fallback !== root) setRoot(fallback);
      }, [root, currentWorkspacePath, workspaceList]);

      useEffect(() => {
        storeRoot(root);
      }, [root]);

      // 切工作区时回到根目录
      useEffect(() => {
        setCwd('');
        setQuery('');
        setSelection(null);
      }, [root]);

      // 取目录树 + git 改动（同一个 root）
      useEffect(() => {
        let live = true;
        if (typeof root !== 'string' || root.length === 0) {
          setTree({ loading: false, data: null, error: null });
          setChanges(null);
          return () => {
            live = false;
          };
        }
        setTree((prev) => ({ ...prev, loading: true }));
        Promise.all([
          apiGet('/files/tree', { root, includeIgnored: includeIgnored ? '1' : undefined }),
          apiGet('/git/changes', { path: root }),
        ]).then(([treeResult, changesResult]) => {
          if (!live) return;
          if (treeResult.ok === true) setTree({ loading: false, data: treeResult, error: null });
          else setTree({ loading: false, data: null, error: treeResult });
          setChanges(changesResult.ok === true ? changesResult : null);
        });
        return () => {
          live = false;
        };
      }, [root, includeIgnored, refreshSeq, bump]);

      // 面板在前台时每 10 秒静默刷新，文件/外部改动都能跟上
      useEffect(() => {
        if (!active || typeof root !== 'string' || root.length === 0) return undefined;
        const timer = setInterval(() => setRefreshSeq((value) => value + 1), 10000);
        return () => clearInterval(timer);
      }, [active, root]);

      // 提示两秒后自己消失
      useEffect(() => {
        if (notice === null) return undefined;
        const timer = setTimeout(() => setNotice(null), 2600);
        return () => clearTimeout(timer);
      }, [notice]);

      const entries = tree.data && Array.isArray(tree.data.entries) ? tree.data.entries : [];
      const counts = tree.data && tree.data.counts ? tree.data.counts : { files: 0, dirs: 0 };
      const truncated = tree.data ? tree.data.truncated === true : false;
      const changeMap = useMemo(() => {
        const map = new Map();
        const files = changes && Array.isArray(changes.files) ? changes.files : [];
        for (const file of files) if (typeof file.path === 'string') map.set(file.path, file);
        return map;
      }, [changes]);
      const changedTotal = changes && changes.totals && typeof changes.totals.files === 'number' ? changes.totals.files : changeMap.size;
      const queryTrim = query.trim();

      const visible = useMemo(() => {
        let list;
        if (onlyChanged) list = entries.filter((entry) => entry.type !== 'dir' && changeMap.has(entry.rel));
        else if (queryTrim.length > 0) {
          const scored = [];
          for (const entry of entries) {
            if (entry.type === 'dir') continue;
            const score = fuzzyScore(queryTrim, entry.rel);
            if (score !== null) scored.push({ entry, score });
          }
          scored.sort((left, right) => right.score - left.score || left.entry.rel.localeCompare(right.entry.rel));
          return scored.map((item) => item.entry);
        } else list = entries.filter((entry) => entry.dir === cwd);

        const direction = sortDir === 'desc' ? -1 : 1;
        const pick = (entry) => (sortKey === 'mtime' ? entry.mtimeMs || 0 : sortKey === 'size' ? entry.size || 0 : String(entry.name || '').toLowerCase());
        const sorted = [...list].sort((left, right) => {
          const a = pick(left);
          const b = pick(right);
          if (a === b) return String(left.name || '').localeCompare(String(right.name || ''));
          return a < b ? -direction : direction;
        });
        if (!queryTrim && !onlyChanged) {
          // 目录优先；稳定排序保留组内排序结果
          return sorted.sort((left, right) => (left.type === 'dir' ? 0 : 1) - (right.type === 'dir' ? 0 : 1));
        }
        return sorted;
      }, [entries, cwd, queryTrim, onlyChanged, changeMap, sortKey, sortDir]);

      const crumbs = cwd.length > 0 ? cwd.split('/') : [];

      const openDialog = (next) => setDialog({ ...next });
      const closeDialog = () => {
        setDialogBusy(false);
        setDialog(null);
      };

      const refresh = () => setRefreshSeq((value) => value + 1);

      const submitDialog = async (payload) => {
        if (dialog === null) return;
        setDialogBusy(true);
        let result;
        let createdRel = null;
        if (dialog.kind === 'create-file') {
          createdRel = joinRel(dialog.cwd, payload.name);
          result = await apiPost('/files/create', { root, rel: createdRel, kind: 'file', content: '' });
        } else if (dialog.kind === 'create-dir') {
          result = await apiPost('/files/create', { root, rel: joinRel(dialog.cwd, payload.name), kind: 'dir' });
        } else if (dialog.kind === 'rename') {
          result = await apiPost('/files/rename', { root, from: dialog.rel, to: joinRel(dirOfRel(dialog.rel), payload.name) });
        } else {
          result = await apiPost('/files/delete', { root, rel: dialog.rel, recursive: payload.recursive === true });
        }
        setDialogBusy(false);
        if (result.ok !== true) {
          setDialog((prev) => (prev === null ? prev : { ...prev, error: result }));
          return;
        }
        if (dialog.kind === 'create-file') setNotice({ kind: 'ok', text: translate(t, 'fm.created', { name: payload.name }) });
        else if (dialog.kind === 'create-dir') setNotice({ kind: 'ok', text: translate(t, 'fm.created', { name: payload.name }) });
        else if (dialog.kind === 'rename') setNotice({ kind: 'ok', text: translate(t, 'fm.renamed') });
        else setNotice({ kind: 'ok', text: translate(t, 'fm.deleted', { name: dialog.name }) });
        setDialog(null);
        refresh();
        bumpGit();
        if (dialog.kind === 'create-file' && createdRel !== null) runtime.openEditor(rootPathOf(root, createdRel));
      };

      const onRowClick = (entry) => {
        setSelection(entry.rel);
        if (entry.type === 'dir') {
          setCwd(entry.rel);
          setQuery('');
          return;
        }
        runtime.openEditor(rootPathOf(root, entry.rel));
      };

      const rowActions = (entry) =>
        h(
          'span',
          { className: 'dsh-ef-fm-actions', style: { display: 'inline-flex', gap: '2px', flex: 'none' }, onClick: (event) => event.stopPropagation() },
          h(ToolButton, {
            title: translate(t, 'fm.rename'),
            onClick: () => openDialog({ kind: 'rename', rel: entry.rel, name: entry.name, cwd: dirOfRel(entry.rel) }),
            style: { width: '22px', height: '22px', minWidth: '22px', padding: 0 },
            children: h(IconPencil, { size: 12 }),
          }),
          h(ToolButton, {
            title: translate(t, 'fm.delete'),
            onClick: () => openDialog({ kind: 'delete', rel: entry.rel, name: entry.name, isDir: entry.type === 'dir' }),
            style: { width: '22px', height: '22px', minWidth: '22px', padding: 0, color: ERROR },
            children: h(IconTrash, { size: 12 }),
          }),
        );

      const staleHost = tree.error !== null && tree.error.reason === 'bad-response' && tree.error.httpStatus === 404;

      const restartDesktop = async () => {
        if (restartPhase === 'busy') return;
        const message = translate(t, 'fm.restartConfirm');
        try {
          if (typeof window.confirm === 'function' && window.confirm(message) !== true) return;
        } catch {
          /* 没有 confirm 就直接重启 */
        }
        setRestartPhase('busy');
        try {
          const response = await fetch('/api/desktop/restart', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          if (response.status >= 400) setRestartPhase('failed');
        } catch (error) {
          console.warn(LOG + '重启 DSH 请求失败：', error);
          setRestartPhase('failed');
        }
      };

      const header = h(
        'div',
        {
          style: {
            flex: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            padding: '18px 22px 12px',
            borderBottom: `0.5px solid ${LINE_1}`,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h('span', { style: { color: BRAND, display: 'flex' } }, h(IconFolder, { size: 20 })),
          h('span', { style: { fontSize: '16px', fontWeight: 600 } }, translate(t, 'fm.title')),
          workspaceList.length > 1
            ? h(
                'select',
                {
                  value: root,
                  onChange: (event) => setRoot(event.target.value),
                  title: translate(t, 'fm.pickWorkspace'),
                  style: {
                    font: 'inherit',
                    fontSize: '12.5px',
                    padding: '4px 8px',
                    borderRadius: '6px',
                    border: `0.5px solid ${LINE_2}`,
                    background: BG_1,
                    color: INK,
                    maxWidth: '300px',
                  },
                },
                workspaceList.map((item) => h('option', { key: item.workspaceId, value: item.path }, item.title)),
                root.length > 0 && !workspaceList.some((item) => item.path === root) ? h('option', { key: 'custom', value: root }, basename(root)) : null,
              )
            : null,
          h('span', { style: { flex: '1 1 auto' } }),
          changedTotal > 0
            ? h('span', { style: { ...S.chip, color: WARN, borderColor: 'transparent', background: 'rgba(210,153,34,.14)' } }, translate(t, 'fm.changed', { n: changedTotal }))
            : h('span', { style: { ...S.chip, color: OK, borderColor: 'transparent', background: 'rgba(63,185,80,.12)' } }, `✓ ${translate(t, 'fm.clean')}`),
          h(ToolButton, { title: translate(t, 'fm.refresh'), onClick: refresh, children: h(IconRefresh, {}) }),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          // 面包屑
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '2px', minWidth: 0, flex: '1 1 320px', flexWrap: 'wrap' } },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ef-btn',
                onClick: () => {
                  setCwd('');
                  setQuery('');
                },
                style: { ...S.btn, height: '22px', padding: '0 6px', color: cwd.length === 0 ? INK : INK_2, ...S.mono },
                title: root,
              },
              basename(root) || '/',
            ),
            ...crumbs.map((segment, index) => {
              const rel = crumbs.slice(0, index + 1).join('/');
              return h(
                'span',
                { key: rel, style: { display: 'inline-flex', alignItems: 'center', gap: '2px', minWidth: 0 } },
                h('span', { style: { color: INK_3, fontSize: '11px' } }, '/'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ef-btn',
                    onClick: () => {
                      setCwd(rel);
                      setQuery('');
                    },
                    style: { ...S.btn, height: '22px', padding: '0 6px', color: index === crumbs.length - 1 ? INK : INK_2, ...S.mono },
                  },
                  segment,
                ),
              );
            }),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h(
            'span',
            {
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                flex: '1 1 260px',
                maxWidth: '420px',
                padding: '0 10px',
                height: '28px',
                borderRadius: '7px',
                border: `0.5px solid ${LINE_2}`,
                background: BG_1,
                color: INK_2,
              },
            },
            h(IconSearch, { size: 13 }),
            h('input', {
              className: 'dsh-ef-fm-input',
              value: query,
              placeholder: translate(t, 'fm.search'),
              title: translate(t, 'fm.searchHint'),
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Escape') setQuery('');
              },
              style: {
                flex: '1 1 auto',
                minWidth: 0,
                border: 0,
                outline: 'none',
                background: 'transparent',
                color: INK,
                font: 'inherit',
                fontSize: '12.5px',
                height: '26px',
              },
            }),
            query.length > 0
              ? h(ToolButton, { title: translate(t, 'action.close'), onClick: () => setQuery(''), children: h(IconClose, { size: 11 }), style: { width: '18px', height: '18px', minWidth: '18px', padding: 0 } })
              : null,
          ),
          h(
            'select',
            {
              value: sortKey,
              onChange: (event) => setSortKey(event.target.value),
              title: translate(t, 'fm.sortName'),
              style: {
                font: 'inherit',
                fontSize: '12px',
                padding: '4px 8px',
                height: '28px',
                borderRadius: '7px',
                border: `0.5px solid ${LINE_2}`,
                background: BG_1,
                color: INK_2,
              },
            },
            h('option', { value: 'name' }, translate(t, 'fm.sortName')),
            h('option', { value: 'mtime' }, translate(t, 'fm.sortTime')),
            h('option', { value: 'size' }, translate(t, 'fm.sortSize')),
          ),
          h(ToolButton, {
            title: sortDir === 'asc' ? translate(t, 'fm.sortAsc') : translate(t, 'fm.sortDesc'),
            onClick: () => setSortDir((value) => (value === 'asc' ? 'desc' : 'asc')),
            style: { width: '28px', height: '28px', minWidth: '28px', padding: 0, border: `0.5px solid ${LINE_2}` },
            children: sortDir === 'asc' ? h(IconSortUp, { size: 12 }) : h(IconSortDown, { size: 12 }),
          }),
          h(ToolButton, {
            title: translate(t, 'fm.onlyChanged'),
            active: onlyChanged,
            onClick: () => setOnlyChanged((value) => !value),
            label: translate(t, 'fm.onlyChanged'),
            style: { height: '28px', border: `0.5px solid ${LINE_2}` },
          }),
          h(ToolButton, {
            title: translate(t, 'fm.showIgnored'),
            active: includeIgnored,
            onClick: () => setIncludeIgnored((value) => !value),
            label: translate(t, 'fm.showIgnored'),
            style: { height: '28px', border: `0.5px solid ${LINE_2}` },
          }),
          h('span', { style: { flex: '1 1 auto' } }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ef-btn',
              title: translate(t, 'fm.newFile'),
              disabled: root.length === 0,
              onClick: () => openDialog({ kind: 'create-file', cwd }),
              style: { ...S.btn, height: '28px', border: `0.5px solid ${LINE_2}`, padding: '0 10px' },
            },
            h(IconPlus, { size: 12 }),
            h('span', null, translate(t, 'fm.newFile')),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ef-btn',
              title: translate(t, 'fm.newDir'),
              disabled: root.length === 0,
              onClick: () => openDialog({ kind: 'create-dir', cwd }),
              style: { ...S.btn, height: '28px', border: `0.5px solid ${LINE_2}`, padding: '0 10px' },
            },
            h(IconPlus, { size: 12 }),
            h('span', null, translate(t, 'fm.newDir')),
          ),
        ),
      );

      const body = [];
      if (root.length === 0) {
        body.push(h('div', { key: 'empty', style: { padding: '26px 24px', fontSize: '13px', color: INK_3 } }, translate(t, 'fm.noWorkspace')));
      } else if (tree.loading && tree.data === null) {
        body.push(h('div', { key: 'loading', style: { padding: '26px 24px', fontSize: '13px', color: INK_3 } }, translate(t, 'fm.loading')));
      } else if (tree.error !== null) {
        body.push(
          h(
            'div',
            { key: 'error', style: { padding: '26px 24px', display: 'flex', flexDirection: 'column', gap: '10px' } },
            staleHost
              ? h('div', { style: { fontSize: '13px', color: WARN, fontWeight: 600 } }, translate(t, 'fm.restartNeeded'))
              : h('div', { style: { fontSize: '13px', color: ERROR } }, reasonText(t, tree.error.reason, tree.error)),
            staleHost
              ? h('div', { style: { fontSize: '12px', color: INK_3, maxWidth: '720px', lineHeight: 1.7 } }, translate(t, 'fm.restartHint'))
              : null,
            h(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ef-btn',
                  onClick: refresh,
                  style: { ...S.btn, border: `0.5px solid ${LINE_2}`, height: '28px', padding: '0 12px' },
                },
                translate(t, 'action.retry'),
              ),
              staleHost
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ef-btn',
                      disabled: restartPhase === 'busy',
                      onClick: restartDesktop,
                      style: { ...S.btn, ...S.btnPrimary, height: '28px' },
                    },
                    restartPhase === 'busy' ? translate(t, 'fm.restarting') : translate(t, 'fm.restartButton'),
                  )
                : null,
              staleHost && restartPhase === 'failed'
                ? h('span', { style: { fontSize: '12px', color: ERROR } }, translate(t, 'fm.restartFailed'))
                : null,
            ),
          ),
        );
      } else if (visible.length === 0) {
        body.push(
          h('div', { key: 'empty-list', style: { padding: '26px 24px', fontSize: '13px', color: INK_3 } },
            queryTrim.length > 0 || onlyChanged ? translate(t, 'fm.emptySearch') : translate(t, 'fm.empty')),
        );
      } else {
        body.push(
          h(
            'div',
            { key: 'list', className: 'dsh-ef-scroll', style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' } },
            visible.map((entry) => {
              const change = changeMap.get(entry.rel);
              const status = change ? (change.untracked === true ? 'A' : change.status) : null;
              return h(
                'div',
                {
                  key: entry.rel,
                  className: 'dsh-ef-fm-row',
                  'data-selected': selection === entry.rel ? '1' : undefined,
                  role: 'button',
                  tabIndex: 0,
                  title: rootPathOf(root, entry.rel),
                  onClick: () => onRowClick(entry),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onRowClick(entry);
                    }
                  },
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    height: '28px',
                    padding: '0 14px 0 22px',
                    fontSize: '12.5px',
                    color: INK,
                    cursor: 'pointer',
                    borderBottom: `0.5px solid ${LINE_1}`,
                    minWidth: 0,
                  },
                },
                h('span', { style: { flex: 'none', display: 'flex', color: entry.type === 'dir' ? BRAND : INK_3 } }, entryIcon(entry)),
                h(
                  'span',
                  {
                    style: {
                      flex: '0 1 auto',
                      minWidth: 0,
                      maxWidth: '46%',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      fontWeight: entry.type === 'dir' ? 600 : 400,
                    },
                  },
                  entry.name,
                ),
                queryTrim.length > 0 || onlyChanged
                  ? h('span', { style: { flex: '1 1 auto', minWidth: 0, ...S.mono, color: INK_3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.dir)
                  : h('span', { style: { flex: '1 1 auto' } }),
                status !== null
                  ? h(
                      'span',
                      {
                        style: {
                          flex: 'none',
                          minWidth: '14px',
                          textAlign: 'center',
                          fontFamily: MONO,
                          fontSize: '10.5px',
                          fontWeight: 700,
                          color: statusColor(status),
                        },
                        title: translate(t, `status.${status}`),
                      },
                      status,
                    )
                  : null,
                h('span', { style: { flex: 'none', width: '56px', textAlign: 'right', ...S.mono, color: INK_3 } }, entry.type === 'dir' ? '' : formatSizeShort(entry.size)),
                h('span', { style: { flex: 'none', width: '108px', textAlign: 'right', ...S.mono, color: INK_3 } }, formatMtime(entry.mtimeMs)),
                rowActions(entry),
              );
            }),
          ),
          h(
            'div',
            {
              key: 'footer',
              style: {
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '7px 22px',
                borderTop: `0.5px solid ${LINE_1}`,
                fontSize: '11.5px',
                color: INK_3,
                minWidth: 0,
              },
            },
            h('span', null, translate(t, 'fm.summary', { files: counts.files || 0, dirs: counts.dirs || 0 })),
            truncated ? h('span', { style: { color: WARN } }, translate(t, 'fm.truncated', { n: tree.data.limit || '—' })) : null,
            notice !== null ? h('span', { style: { color: notice.kind === 'ok' ? OK : ERROR } }, notice.text) : null,
            h('span', { style: { flex: '1 1 auto' } }),
            h('span', null, translate(t, 'fm.openHint')),
          ),
        );
      }

      return h(
        'div',
        { 'data-edit-files-panel': '1', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: INK, background: 'var(--dsw-alias-bg-base, #17181c)' } },
        header,
        body.length > 0 ? body[0] : null,
        body.length > 1 ? body[1] : null,
        dialog !== null
          ? h(FileDialog, {
              t,
              dialog,
              busy: dialogBusy,
              onCancel: closeDialog,
              onSubmit: submitDialog,
            })
          : null,
      );
    };

    // ───────────────────────────────────────────────────────── apply

    const plugin = {
      inject: ['slots', 'locale', 'uiWorkspace', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        runtime.ctx = ctx;
        const t = ctx.locale.bind(NS);
        runtime.t = t;

        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'edit-files: dictionaries');
        ctx.effect(() => ensureStyles(), 'edit-files: styles');

        // ① 编辑器浮层 + 工作区快照桥（两个都是常驻的 shell.overlay 条目）
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'edit-files-editor', order: 60, locale: NS },
            guarded('editor', EditorOverlay),
          ));
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'edit-files-workspace-bridge', order: 59 },
            guarded('workspace-bridge', WorkspaceBridge),
          ));

        // ② 文档预览工具栏：编辑 + Git 状态
        ctx.slots.inject('sidebar.right.tab.document.actions', () =>
          ctx.slots.register(
            { name: 'sidebar.right.tab.document.actions', id: 'edit-files-document', order: 20, locale: NS },
            guarded('document-actions', DocumentActions),
          ));

        // ③ 文件树工具栏：Git 改动
        ctx.slots.inject('sidebar.right.tab.files.actions', () =>
          ctx.slots.register(
            { name: 'sidebar.right.tab.files.actions', id: 'edit-files-files', order: 10, locale: NS },
            guarded('files-actions', FilesGitAction),
          ));

        // ④ 会话头部徽标
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'edit-files-git-badge', order: -8, locale: NS },
            guarded('header-badge', SessionGitBadge),
          ));

        // ⑤ 会话「...」菜单
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'edit-files-git-menu', order: 210, locale: NS },
            guarded('session-menu', GitMenuItem),
          ));

        // ⑥ 会话行 hover 按钮（工作区分组里每一行都能看到 git 标记）
        ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
          ctx.slots.register(
            { name: 'sidebar.workspaces.session.row.action', id: 'edit-files-git-row', order: 150, locale: NS },
            guarded('session-row', SessionRowGitAction),
          ));

        // ⑦ 右栏页类型 + 正文
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
            guarded('git-tab', GitChangesTab),
          ));

        // ⑧ 工作区分组「⋯」菜单的 Git 行（DSH 没有对应 slot，走 DOM 增强）
        ctx.effect(() => installWorkspaceMenuBridge(), 'edit-files: workspace menu bridge');

        // ⑨ cordis_inspect 只读自检入口
        installInspectProvider(ctx);

        // ⑩ 工程文件面板：左栏图标 + 主面板页
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS },
            guarded('file-manager', FileManagerPage),
          ));
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 30, locale: NS, label: () => translate(t, 'fm.title') },
            guarded('file-manager-icon', FileManagerIcon),
          ));
      },
    };

    // 自检脚本（test/client-selftest.mjs）用：只有页面显式打开测试开关时才挂，正常运行时不存在。
    if (typeof window !== 'undefined' && window.__DSH_EDIT_FILES_TEST__ === true) {
      plugin.__test = {
        constants: { NS, API, TAB_ID, TAB_KIND, PANEL_ID },
        dictionaries: { zh: ZH, en: EN },
        translate,
        parseUnifiedDiff,
        workspacePathOf,
        workspaceListOf,
        currentSessionIdOf,
        basename,
        dirnameOf,
        shortPath,
        formatBytes,
        formatMtime,
        formatSizeShort,
        joinRel,
        dirOfRel,
        rootPathOf,
        fuzzyScore,
        reasonText,
      };
    }

    return plugin;
  },
});
