# dsh-plugin-edit-files

<p align="center"><img src="icon.svg" width="72" height="72" alt="dsh-plugin-edit-files 图标"></p>

给 DSH（DeepSeek Harness）Web GUI 加两个能力的插件：**在右侧文件预览里直接编辑保存**，以及**在侧栏标签页里看清本地工作区与上游远程到底差在哪**。

这个插件只做这两件事，不碰你的项目配置，也不是 IDE 的替代品。

## 能力

### 一、右侧预览直接编辑

- 右侧 Sidebar 的文档预览目前只能看；启用插件后，预览工具栏多出「编辑」入口，在同一个窗口里直接改文件，不用切回编辑器。
- **⌘S / Ctrl+S 保存**，Esc 关闭；有未保存修改时先弹确认，不会手滑丢掉内容。
- 保存前核对文件是否被外部改过：带着上次读到的 `mtime` 提交，磁盘上的文件已经变了就报冲突，由你选「仍然覆盖保存」还是「载入磁盘版本」，不会静默覆盖别人的修改。
- 写盘保留原文件的换行符（LF / CRLF）与 BOM；用「同目录临时文件 + rename」原子替换，尽量不出现写了一半的文件。
- 二进制文件、超过大小上限的文件、非普通文件会被明确拒绝并提示，不会把乱码塞进编辑器。

### 二、Git 改动（只列真正不同的文件）

- **只在 git 仓库里出现**：从当前目录向上找仓库根；不是仓库时，客户端**不渲染任何 git 入口**。
- 四个入口打开同一个「Git 改动」右栏标签页：
  - 会话「⋯」菜单里的「Git 改动」（行尾直接显示改动文件数）；
  - 会话头部（Session header）的 git 徽标（有改动时显示数字）；
  - 右侧文件树工具栏的 git 按钮（显示当前目录改动数）；
  - 右侧文档预览工具栏的 git 标识——只在当前文件确实与远程不同时亮起，并显示 M/A/D 状态字母。
- 说明：DSH 这一版的「工作区分组标题」右键菜单（重命名 / 删除工作区）是 ui-workspace 里写死的，**没有给插件留槽位**，所以 git 入口放在上面这些会话级 / 文件级的位置；它们同样只在 git 仓库里出现。
- 对比基准是**上游远程分支**（例如 `origin/main`），不是简单的 `git status`：本地已提交但还没推送的改动、未提交的暂存/工作区修改、未跟踪的新文件，全都统一拿来和上游比。改回与远程一致的文件会自动从列表消失——这正是需求。
- 列表只显示真正不一样的文件，带状态字母（A/M/D/R/C/T/U）和增删行数；点某个文件看 unified diff，未跟踪的新文件直接显示全文。
- 顶部顺带显示分支、相对上游的领先 / 落后提交数；没有上游时依次退回 `origin/HEAD`、`HEAD`（此时会写明「对比 HEAD」）；空仓库把所有文件当未跟踪列出。
- 列表为空时显示「与远程一致，没有本地改动」。

## 安装

前置条件：DSH Desktop 或 `dsh web`（带 Web GUI 的 profile）；Node.js ≥ 22.13.0（`package.json` 的 `engines` 要求）；要用 Git 改动功能的话，本机要有 `git`。插件没有 npm 依赖，**不需要 `npm install`**。

### 方式一：从本机目录安装（推荐）

在 DSH 里让 agent 用插件管理器安装，`target` 填本仓库的绝对路径：

```text
plugin_manager({ action: "install_bundle", target: "/绝对路径/dsh-plugin-edit-files" })
```

安装会把包装进当前 profile 并登记 bundle，插件列表里出现 `dsh-plugin-edit-files`；如果显示为关闭，打开开关即可。

**装完请刷新一次 DSH Web 页面**（⌘R / Ctrl+R，重新加载标签页）：Host 路由随插件启用就生效，但 `client.js` 是页面加载时注入的客户端代码，不刷新看不到预览工具栏的「编辑」按钮和 Git 入口。如果是**覆盖安装**已存在的同名插件，还需要重启 DSH 才会加载新的客户端模块。

### 方式二：从插件市场安装

如果本插件被收录进某个插件市场索引（DSH Desktop 的「设置 → 插件市场」里可选 `dsh-market` 或 `dsh-community-market`），在「插件 → 发现」里搜索 `dsh-plugin-edit-files` 即可安装。本仓库不附带市场索引；没被收录时请用方式一。

## 用法

### 在预览里编辑文件

1. 在右侧 Sidebar 打开一个文本文件的预览（从工作区或会话里的文件引用点开都行）。
2. 点预览工具栏上的「编辑」按钮（铅笔图标）：会在预览上方打开编辑浮层，改完按 **⌘S**（Windows / Linux 用 **Ctrl+S**）保存。
3. 保存成功显示「已保存」；「还原」回到打开时的内容，「自动换行」切换折行。保存后 Git 徽标与「Git 改动」列表会立即刷新。
4. 如果文件在你编辑期间被外部程序改动，保存时不会被静默覆盖：浮层底部提示「磁盘上的文件已被改动」，可选「仍然覆盖保存」或「载入磁盘版本」（丢弃本地草稿）。
5. 打开二进制文件或超过上限的文件、以及文件已不存在时，会给出明确提示，不进入编辑。

### 查看 Git 改动

1. 在 git 仓库的工作目录里开会话。目录不是仓库时，菜单项和徽标都不会出现。
2. 从会话「⋯」菜单选「Git 改动」，或点会话头部的 git 徽标，右侧会打开「Git 改动」标签页。
3. 顶部显示分支、领先 / 落后提交数和对比基准（如「对比 origin/main」）；下面是只含真正不同文件的列表：状态字母 + 文件名 + 增删行数，二进制文件标 `bin`。
4. 点一个文件看 unified diff；面板开着时每 6 秒自动刷新，也可以手动刷新。
5. 把文件改回与远程一致，它会自动从列表里消失；全部一致时显示「与远程一致，没有本地改动」。如果会话还没有工作区路径，页面会提示「这个会话还没有工作区路径」。

## Host 路由（`/api/edit-files/*`）

所有响应都是 JSON（`cache-control: no-store`）；失败统一返回 `{ ok: false, reason, error? }` + 合适的 HTTP 状态码，不会把异常抛到路由之外。GET 从 query 取参数，POST 从 JSON body 取参数。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/edit-files/health` | 自检：插件名、版本、已注册路由清单与当前限额 |
| GET | `/api/edit-files/git/info` | 判断路径是否在 git 仓库里，回仓库根、分支、上游、ahead/behind（`?path=`） |
| GET | `/api/edit-files/git/changes` | 本地工作区 vs 远程基准，只列真正不同的文件与增删行数（`?path=`） |
| GET | `/api/edit-files/git/diff` | 单个文件的 unified diff；未跟踪文件回 `newText` 全文（`?path=&file=`） |
| GET | `/api/edit-files/git/file` | 单个文件是否与远程不同，供预览工具栏 / 会话徽标判断（`?path=`） |
| POST | `/api/edit-files/file/read` | 读 UTF-8 文本：内容、大小、mtime、换行符、BOM、权限位 |
| POST | `/api/edit-files/file/write` | 写文件：乐观并发检查、原子写、保留 EOL / BOM / 权限位 |

参数、状态码、基准选择规则与返回字段以契约文档为准：[`docs/route-contract.md`](docs/route-contract.md)。

## 配置

三个可调项都在 bundle patch 的 `config` 里，全部可选：

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxFileBytes` | `2097152`（2 MiB） | 单个文件读取 / 保存上限（字节），超过就拒绝读写 |
| `maxDiffLines` | `4000` | 单个文件 diff 最多回传行数，超出截断并标 `truncated` |
| `maxChangedFiles` | `3000` | 一次改动列表最多回传条数，超出截断并标 `truncated` |

改的是 profile 里这个 bundle 的 patch 配置（或安装前改仓库里的 `cordis.patch.yml`）。`cordis.patch.example.yml` 只是把可调项抄出来给人看的参考，改它不会生效。

## 已知限制

- **只支持 UTF-8 文本**：二进制文件（前 8 KiB 出现 `\0`）直接拒绝，没有十六进制编辑。
- **单文件默认 ≤ 2 MiB**：超过上限不读也不写；可以调大 `maxFileBytes`，但别指望用它看大日志。
- **不是 IDE**：没有语法高亮、补全、LSP、多光标；改大文件请用真正的编辑器。
- **不自动合并冲突**：保存时发现外部改动只会提示，由你选覆盖或载入磁盘版本。
- **依赖本机 `git`**：`git` 不可用时 Host 返回 `git-unavailable`，Git 入口不可用，面板提示「这台机器上找不到 git 命令」。
- **大仓库会截断**：文件数超过 `maxChangedFiles`、diff 超过 `maxDiffLines` 时只回前 N 条 / 行，并在响应里标 `truncated`。
- **基准是远程**：没有上游时退回 `origin/HEAD` 或 `HEAD`；此时只能看到相对该基准的差异，建议先 `git push -u` 设好上游。
- **二进制文件只在列表可见**（标 `binary: true`），diff 不展开。

## 开发与自检

仓库结构：

```text
index.js                Host 入口（export name / inject / apply）
lib/                    Host 实现（config / git / files / router）
client.js               Web GUI 客户端（预览编辑浮层 + Git 改动标签页）
cordis.patch.yml        bundle patch（插入插件行与默认配置）
cordis.patch.example.yml 可调配置的参考副本（不生效）
docs/route-contract.md  Host 与 Client 的接口契约
locale/                 zh.json / en.json（插件管理器里显示的标题与描述）
icon.svg                插件图标
test/                   host-selftest.mjs / client-selftest.mjs
```

自检（不需要额外依赖，但需要本机 `git`）：

```bash
node --check index.js
node --check client.js
node test/host-selftest.mjs
node test/client-selftest.mjs
```

`host-selftest.mjs` 在 `os.tmpdir()` 下建临时的 bare 远程 + clone 仓库，把契约语义跑一遍：干净仓库不列文件、改回一致自动消失、未跟踪 / 删除 / 重命名、diff、读写往返、冲突、CRLF / BOM 保留、二进制与超限拒绝等，结束后清理临时目录。`client-selftest.mjs` 离线加载 `client.js`，检查 slot 注册、locale 字典完整性和几个纯函数。仓库没有构建步骤，`client.js` 直接由 DSH 页面加载。

## 许可证

[MIT](LICENSE)。图标 `icon.svg` 为本仓库原创，随仓库以 MIT 许可发布。
