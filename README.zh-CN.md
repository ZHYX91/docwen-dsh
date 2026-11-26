# DeepSeek Harness 的 DocWen 插件

[English](README.md)

在 Harness Web 中将历史回复导出为 Word，把文档的指定章节放入对话草稿，或用本机 DocWen 处理文件。插件通过 Machine v2 调用 DocWen，并把经过校验的 Artifact Bundle v3 结果保存在发起任务的会话中。

## 安装

使用 DeepSeek Harness Web `0.2.3-alpha.2` 和本地 DocWen Machine v2 CLI，开发基线为 `0.23.2`。Harness 宿主与 DocWen 进程须使用同一套本机文件系统。将 CLI 加入宿主的 PATH，或在启动 Harness 前把 `DOCWEN_DSH_EXECUTABLE` 设为可执行文件的绝对路径。通过源码安装的 CLI 通常叫 `docwen`。

在插件源码目录，使用宿主支持的 Node 版本（`^24.22.3 || >=26.13.1`）执行：

```sh
npm ci
npm run check
npm test
npm pack
dsh plugin --profile web add ./zhyx91-docwen-dsh-0.1.0.tgz
dsh web
```

压缩包包含宿主端、浏览器端和随包依赖的许可说明。有仓库读取权限时，也可以用 `dsh plugin --profile web add git+https://github.com/ZHYX91/docwen-dsh.git#COMMIT_SHA` 安装固定提交。先审查对应源码，再将 DSH 提示的这一项构建许可加入该 profile 的 `pnpm-workspace.yaml`。

## 在文档和对话之间往返

* 在已完成的助手回复下选择“导出 Word”。先预览可见 Markdown，选用本机 Word 模板，按需启用成稿校对。要合编多条回复，可逐条加入选择，在会话的 DocWen 面板中排序。只取已经完成的可见正文，排除推理、工具调用和未完成的回答。回复明确引用的会话图片和工作区位图会嵌入文档，缺图会提示并停止导出。
* 在面板中从本机、工作区、会话附件或已有结果选择 DOCX，执行 Word 转 Markdown。下载整个 ZIP 可以保留 Markdown 的相对图片路径。也可以预览一个章节，选择“加入草稿”，确认后自行发送。导入和保存文档本身不会将内容发送给模型。
* 重开会话后，可以再次从面板下载单个文件或整组结果，也可移除已保存的结果。已完成任务的结果可在原模型轮次结束后继续打开。

若 Core 提供这些选项，工作台导入 Word 时会预选单独保存图片文件和标准 Markdown 图片链接，两项均可在导入前调整。

## 文件处理

先选择文件，面板再按本机 DocWen 公布的能力展示匹配操作。模板、编号方案、优化方式和参数均来自本机 Core。

| 类型 | 可用功能举例 |
|---|---|
| 转换与提取 | Word、表格转 Markdown，Markdown 转 Word 或表格，Markdown 表格或工作表转 CSV，HTML／ENEX 导入，版式文档或 TIFF 内容提取 |
| 校对与编号 | Markdown 校对报告、标题编号；Core 公布 `validate.docx` 时，也可生成保留已有批注的 Word 校对副本 |
| 渲染、OCR 与优化 | PDF 转页图、支持格式的 OCR、Core 实际提供的公文等专项转换 |
| 合并与拆分 | 按序合并 PDF、合并表格、多图合成 TIFF，以及 PDF 逐页或按指定页拆分 |

对单输入操作，多选文件会排成批次。一项失败时保留已完成的结果，可以从当前面板仅重试失败项。合并操作只派发一个任务，输入顺序以列表为准。混合 PDF、OFD 和 XPS 时，优先采用 Core 公布的直接合并路线；若需分步，必须为每种非 PDF 输入找到可用的转 PDF 能力，并具备最终合并能力。基线 Core 尚未公开 OFD／XPS 转 PDF。任一前置步骤失败或取消都会停止，临时 PDF 不会进入用户结果。

## 无模型命令和模型工具

`/docwen` 是直接执行的 Harness 命令，无需发起模型对话。例如：

```text
/docwen help
/docwen capabilities
/docwen capabilities validate.markdown
/docwen results
/docwen export MESSAGE_ID
/docwen process validate.docx
/docwen run {"action":"process","capabilityId":"merge.pdf.documents","sources":[{"kind":"workspace","path":"first.pdf"},{"kind":"workspace","path":"second.pdf"}],"options":{}}
```

用 `/docwen process` 时，在同一条命令中附上输入文件。模型使用独立的 `docwen` 工具，可查询操作、处理指定的文件，并按 ID 复用已保存的产物。在开放的模型轮次里，成功调用可通过 Harness 原生交付主文件。所有入口的完整结果都能在会话面板中取得。

## 限额与结果保留

每个会话同时运行一个文档任务，整个宿主最多四个，每项限时五分钟。一次最多选择 64 个文件，单文件上限 32 MiB、输入合计 96 MiB。源文件预览上限 2 MiB。排序、取消和失败项重试作用于当前批次；重启浏览器后，本机文件需重新选择。关闭活动会话或卸载插件会取消进行中的任务。成品一直保存在 `DSH_HOME`（默认 `~/.dsh`）下的 `docwen-dsh` 目录，直到用户移除。无法确认子进程退出时会保留其私有暂存目录。

工作区文件通过 Harness 文件服务读取，并核对解析后的工作区归属。会话附件通过宿主提供的引用读取。插件在保存和交付时核对文件身份、大小和 SHA-256。多文件结果保留 Bundle 的逻辑路径，下载 ZIP 后可以继续使用相对图片链接。

## 验证安装包

执行 `npm ci` 后，把 `DSH_BIN` 设为已安装的 `@deepseek-ai/dsh/lib/bin.js`，把 `DOCWEN_DSH_EXECUTABLE` 设为 Core CLI 的绝对路径，运行 `node scripts/host-smoke.mjs`。脚本会打包插件，在临时 Web profile 中安装，验证两种图片来源、成稿与反向下载、会话分支与隔离、取消、无模型命令和原生工具交付。测试夹具向宿主提交历史轮次，验收无需在线模型账号。

浏览器验收需在测试环境安装 Playwright 及匹配的 Chromium，再执行 `node scripts/browser-smoke.mjs`。CI 工作流中列有宿主、Core、浏览器和运行环境的具体版本及准备步骤。
