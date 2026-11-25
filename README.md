# DocWen for DeepSeek Harness

DocWen DSH integrates an installed DocWen CLI with DeepSeek Harness. It uses
DocWen Machine Protocol v2 and Artifact Bundle v3 to convert documents with
local templates, proofreading rules, and resources.

## Install a development build

The supported development baseline is DeepSeek Harness Web
`0.2.3-alpha.2` with DocWen CLI `0.23.2`. Use the Node version required by
that Harness release. Install the DocWen CLI on the same machine as the
Harness host. Make it available on the host's PATH or set
`DOCWEN_DSH_EXECUTABLE` to the executable's absolute path before starting
Harness.

```sh
npm ci
npm run check
npm test
npm pack
dsh plugin --profile web add ./zhyx91-docwen-dsh-0.1.0.tgz
dsh --profile web
```

## Use DocWen in a conversation

- Choose **Export Word** beneath a completed reply. DocWen uses the default
  Word template and proofreading settings. Referenced raster images from
  the conversation's attachments or the session workspace are embedded in
  the Word file. An unavailable image stops the export with a message.
- Open the **DocWen** section of the session panel and choose **Import Word**
  to convert a local DOCX. Download the Markdown and its images together as
  a ZIP, or review one section and use **Add section to draft**. Send the
  draft from the composer when ready.
- Download previous results from the same session panel. Results are
  stored under `docwen-dsh` in the Harness home directory.

This development build covers local Harness Web sessions and the two
document workflows above. Markdown image references use the session
workspace or stored conversation images. The import accepts DOCX files up
to 32 MiB. Conversions run through DocWen Machine Protocol v2 and publish
the verified Artifact Bundle v3 result.
