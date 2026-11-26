# DocWen for DeepSeek Harness

[简体中文](README.zh-CN.md)

Export completed conversation replies, bring selected document sections into a draft, and run a local DocWen installation from Harness Web. The plugin uses Machine v2 and saves verified Artifact Bundle v3 results in the conversation that requested them.

## Install

The DSH plugin installer calls `pnpm`. Keep it on the same PATH as the host. The DSH source tree for this release pins `pnpm@11.28.5`.

Use DeepSeek Harness Web `0.2.3-alpha.2` and a local DocWen Machine v2 CLI (development baseline `0.23.2`). The Harness host and DocWen process must share a local filesystem. Install the CLI on the host's PATH or set `DOCWEN_DSH_EXECUTABLE` to its absolute executable path before starting Harness. A source-installed CLI commonly uses the executable name `docwen`.

From the plugin source checkout, with a supported Node version (`^24.22.3 || >=26.13.1`):

```sh
npm ci
npm run check
npm test
npm pack
dsh plugin --profile web add ./zhyx91-docwen-dsh-0.1.0.tgz
dsh web
```

The tarball includes the built host, browser client and bundled dependency notices. With Git access, you can also install an exact commit using `dsh plugin --profile web add git+https://github.com/ZHYX91/docwen-dsh.git#COMMIT_SHA`. Review the commit and allow only the install-time build key printed by DSH in that profile's `pnpm-workspace.yaml`.

## Conversation workflows

* Open **Export Word** under a completed assistant reply. Preview the original visible Markdown, select a Word template and choose the proofreading rules. To export several replies in one Word document, select the replies and order them in the **DocWen** session panel. Reasoning, incomplete responses and tool calls are excluded. Referenced session images and workspace raster files are embedded. A missing image stops the export.
* In the panel, select a DOCX from your computer, workspace, attachments or a previous result and convert it to Markdown. Download the whole result as a ZIP to retain relative image links. Open a section, review it and choose **Add section to draft**. You control when to send that draft.
* Reopen the session panel to access earlier results, download an individual file or the complete group, or remove a saved result. A completed output stays readable when the originating model turn ends. Uploading and processing a document does not send its content to a model.

The workbench initially selects separate image files and standard Markdown image links for Word imports when Core offers those options. You can change either setting before importing.

## File workbench

Choose files first. The panel offers compatible operations reported by the installed Core. Options, templates, numbering schemes and optimizations come from the same installation. Depending on its capabilities, the workbench supports:

| Workflow | Examples |
|---|---|
| Convert and extract | Word or spreadsheets to Markdown, Markdown to Word or spreadsheets, Markdown tables or workbook sheets to CSV, HTML/ENEX import, fixed-layout document and TIFF extraction |
| Review or transform | Markdown proofreading report, heading numbering, or a copy of an existing DOCX with Word comments when the server advertises `validate.docx` |
| Render, OCR and optimize | PDF page images, OCR on supported inputs, and document-to-Markdown optimization routes advertised by Core |
| Merge and split | Ordered PDF merge, spreadsheet merge, images to TIFF, PDF page splits and specified page partitions |

For a single-input operation, selecting several files creates a batch. Successes remain available if another row fails. Retry failed rows from the same panel. Multi-input operations receive files in the displayed order as one task. Mixed PDF/OFD/XPS merging uses a compatible native merge if available; otherwise it requires an advertised PDF conversion for every non-PDF input and a PDF merge. The baseline Core does not advertise the OFD/XPS-to-PDF steps. Private intermediate PDFs are never delivered. A failed or cancelled prerequisite stops the task.

## Commands and model tools

`/docwen` runs directly as a Harness command, including outside a model turn. Examples:

```text
/docwen help
/docwen capabilities
/docwen capabilities validate.markdown
/docwen results
/docwen export MESSAGE_ID
/docwen process validate.docx
/docwen run {"action":"process","capabilityId":"merge.pdf.documents","sources":[{"kind":"workspace","path":"first.pdf"},{"kind":"workspace","path":"second.pdf"}],"options":{}}
```

Attach the input files to `/docwen process`. The separate `docwen` model tool can discover capabilities, run a selected operation, and refer to saved results by ID. A successful tool call in an open turn can present the primary file through Harness. The session panel retains the complete result group for all entry points.

## Limits and lifecycle

One active document task per session, up to four across the host. Each task has a five-minute deadline. Inputs are limited to 64 files, 32 MiB per file and 96 MiB in total. Source previews are capped at 2 MiB. Reordering, cancellation and per-item retries apply to the current batch; after a browser restart, local uploads must be selected again. Closing a live session or unloading the plugin cancels its active work. Completed results remain under `docwen-dsh` in `DSH_HOME` (default `~/.dsh`) until removed. A private staging directory is retained if subprocess exit cannot be confirmed.

Session workspace files use the Harness file service. The plugin verifies their resolved workspace identity before use. Session attachments are resolved from trusted Harness references. File identities, sizes and SHA-256 hashes are checked when saving results and again before delivery. The published file list and the ZIP preserve the Bundle's logical paths.

## Verifying an installed package

After `npm ci`, set `DSH_BIN` to the installed `@deepseek-ai/dsh/lib/bin.js` and `DOCWEN_DSH_EXECUTABLE` to the absolute path of the Core CLI. Run `node scripts/host-smoke.mjs`. It packs the plugin, installs it into a temporary Web profile, and checks a completed reply, two distinct image sources, Word and Markdown downloads, a fork, session isolation, cancellation, the slash command and native tool delivery. The fixture supplies the historical turn. An online model account is unnecessary.

For the browser test, install Playwright and its matching Chromium in the test environment and run `node scripts/browser-smoke.mjs`. The CI workflow records the exact host, Core, browser and runner setup.
