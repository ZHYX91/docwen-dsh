# DocWen for DeepSeek Harness

[English](README.md)

在 DeepSeek Harness（DSH）Web 会话里，用已安装的 DocWen CLI 把回复导出为 Word，或将 Word 转换成 Markdown 后选一节加入对话草稿。转换使用本机的 DocWen 模板和校对设置。

## 安装

当前验证版本为 DSH Web `0.2.3-alpha.2`、DocWen CLI `0.23.2`。请使用该 DSH 版本要求的 Node.js。在运行 DSH 的机器上安装 DocWen CLI，把它加入 `PATH`，或在启动 DSH 前将 `DOCWEN_DSH_EXECUTABLE` 设为 CLI 的绝对路径。

在安装包所在目录执行：

```sh
dsh plugin --profile web add ./zhyx91-docwen-dsh-0.1.0.tgz
dsh --profile web
```

如果手上是源码，先运行 `npm ci`、`npm run check`、`npm test` 和 `npm pack` 生成安装包。安装包内附随包依赖的许可声明。

### 从 Git 安装

有仓库读取权限时，可直接从 Git 安装。将 `COMMIT_SHA` 替换为要安装的完整提交 SHA：

```sh
dsh plugin --profile web add git+https://github.com/ZHYX91/docwen-dsh.git#COMMIT_SHA
```

这种方式会在本机执行构建。审查该提交的源码后，只把 DSH 提示的那一项加入该配置的 `pnpm-workspace.yaml` 中的 `allowBuilds`，再重试。使用预构建的 `.tgz` 无需允许安装时构建。

## 在会话中使用

- 在已生成完毕的回复下点 **Export Word**。导出会嵌入该回复引用的会话附件或工作区图片。如果缺图，界面会提示并停止导出。
- 在会话侧栏的 **DocWen** 区域点 **Import Word**。可以下载包含 Markdown 和图片的 ZIP，也可以预览后点 **Add section to draft** 把选中的一节加入草稿，再从输入框发送。
- 同一侧栏可以下载之前的转换结果。结果保存在 DSH 主目录下的 `docwen-dsh` 目录。

当前版本覆盖本地 DSH Web 会话的上述两个流程。导入接受最大 32 MiB 的 DOCX。转换使用 DocWen Machine Protocol v2，输出使用 Artifact Bundle v3。
