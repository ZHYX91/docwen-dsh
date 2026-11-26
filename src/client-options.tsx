import { useId } from 'react'
import type { Catalog, Options, Schema, Text } from './client-model.js'

const labels: Record<string, [string, string]> = {
  template_name: ['Template', '模板'], proofread: ['Proofread the generated Word document', '校对生成的 Word 文档'],
  enable_symbol_pairing: ['Check paired symbols', '检查符号配对'], enable_symbol_correction: ['Check symbol usage', '检查符号用法'],
  enable_typos_rule: ['Check common typos', '检查错别字'], enable_sensitive_word: ['Check sensitive words', '检查敏感词'],
  numbering_scheme: ['Numbering scheme', '编号方案'], add_numbering: ['Add heading numbering', '添加标题编号'],
  remove_numbering: ['Remove heading numbering', '清理标题编号'], pages: ['Page numbers', '页码'],
  recognize_text: ['Recognize text (OCR)', '识别文字（OCR）'], recognize_tables: ['Recognize tables', '识别表格'],
  preserve_resources: ['Keep images and resources', '保留图片和资源'], locale: ['Document language', '文档语言'],
  ocr_language: ['OCR language', 'OCR 语言'], render_dpi: ['Render resolution (DPI)', '渲染分辨率（DPI）'],
  merge_mode: ['Merge mode', '合并方式'], offset_range: ['Offset range', '偏移范围'], heading_merge_mode: ['Heading merge', '标题合并方式'],
  image_mode: ['Image output', '图片输出方式'], image_link_style: ['Image links', '图片链接格式'], markdown_extensions: ['Markdown extensions', 'Markdown 扩展'],
  table_merge_strategy: ['Table merge strategy', '表格合并策略'], skip_code_blocks: ['Skip code blocks', '跳过代码块'],
  skip_quote_blocks: ['Skip quotes', '跳过引用块'], ocr_placement: ['OCR text placement', 'OCR 文字位置'],
  structural_tables: ['Structural tables', '结构化表格'], captions_references: ['Captions and references', '题注和引用'],
  extended_headings: ['Extended headings', '扩展标题'], typed_endnotes: ['Typed endnotes', '分类尾注'],
  input: ['Input', '输入'], output: ['Output', '输出'], wiki_links: ['Wiki link mappings (JSON)', 'Wiki 链接映射（JSON）'],
  keep_alpha: ['Keep transparency', '保留透明度'], mode: ['Mode', '模式'], heading_numbering_render_mode: ['Heading numbering format', '标题编号格式'],
  export_numbering_markers: ['Export numbering markers', '导出编号标记'], to_md_enable_ocr: ['Recognize text (OCR)', '识别文字（OCR）'],
  to_md_keep_images: ['Keep images', '保留图片'],
}
function fieldName(key: string, t: Text) { return labels[key] ? t(...labels[key]) : key.replaceAll('_', ' ') }
function optionLabel(value: string | number, t: Text): string {
  const names: Record<string, [string, string]> = {
    row: ['Rows','按行'], col: ['Columns','按列'], cell: ['Cells','按单元格'],
    punct_required: ['After punctuation','标点后合并'], never: ['Never','从不'], always: ['Always','始终'],
    text: ['Plain text','纯文本'], word_native: ['Word numbering','Word 原生编号'],
    file: ['Separate file','独立文件'], embed: ['Embed','嵌入'], omit: ['Omit','忽略'],
    image_md: ['Image Markdown','图片 Markdown'], main_md: ['Main Markdown','主 Markdown'],
    fill: ['Fill','填充'], empty: ['Leave blank','留空'], marker: ['Add marker','添加标记'],
    wiki_embed: ['Wiki embed','Wiki 嵌入'], wiki_link: ['Wiki link','Wiki 链接'],
    markdown_link: ['Markdown link','Markdown 链接'], markdown_embed: ['Markdown embed','Markdown 嵌入'],
    smart: ['Automatic','自动'], auto: ['Auto','自动'], chinese: ['Simplified Chinese','简体中文'],
    chinese_cht: ['Traditional Chinese','繁体中文'], english: ['English','英语'], japanese: ['Japanese','日语'],
    korean: ['Korean','韩语'], latin: ['Latin','拉丁文字'], cyrillic: ['Cyrillic','西里尔文字'],
  }
  const key = String(value)
  if (names[key]) return t(...names[key])
  if (/^[a-z]{2}_[A-Z]{2}$/.test(key)) {
    try { return new Intl.DisplayNames([t('en','zh')], { type: 'language' }).of(key.replace('_','-')) ?? key } catch { return key }
  }
  return key
}
function update(options: Options, key: string, value: unknown): Options {
  const next = { ...options }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

interface Props {
  schema: Schema; options: Options; setOptions(next: Options): void; catalog: Catalog; t: Text
}
export function OptionFields({ schema, options, setOptions, catalog, t }: Props) {
  const fields = Object.entries(schema.properties ?? {}).filter(([key]) => key !== 'markdown_resource_bindings')
  return <>{fields.map(([key, spec]) => <Field key={key} name={key} spec={spec} required={schema.required?.includes(key)}
    value={options[key]} setValue={value => setOptions(update(options, key, value))} catalog={catalog} t={t} />)}</>
}
function Field({ name, spec, value, setValue, catalog, required, t }: {
  name: string; spec: Schema; value: unknown; setValue(next: unknown): void; catalog: Catalog; required?: boolean; t: Text
}) {
  const id = useId()
  const label = fieldName(name, t)
  const automatic = t('DocWen default', '使用 DocWen 默认设置')
  if (spec.type === 'object') {
    return <fieldset><legend><label><input type="checkbox" checked={value !== undefined}
      onChange={e => setValue(e.target.checked ? {} : undefined)} /> {label}</label></legend>
      {value !== undefined && <OptionFields schema={spec} options={value as Options} setOptions={setValue} catalog={catalog} t={t} />}
    </fieldset>
  }
  let control
  const resources = spec['x-docwen-resource-kind'] === 'templates'
    ? catalog.templates.filter(r => r.target === spec['x-docwen-resource-target'])
    : spec['x-docwen-resource-kind'] === 'numbering-schemes' ? catalog.numberingSchemes : undefined
  if (resources || spec.enum || spec.type === 'boolean') {
    const choices = resources?.map(r => ({ value: r.id, label: r.name })) ?? spec.enum?.map(v => ({ value: v, label: optionLabel(v,t) }))
      ?? [{ value: true, label: t('On', '开启') }, { value: false, label: t('Off', '关闭') }]
    control = <select id={id} required={required} value={value === undefined ? '' : String(value)}
      onChange={e => setValue(choices.find(choice => String(choice.value) === e.target.value)?.value)}>
      <option value="">{automatic}{spec.default !== undefined ? ' (' + String(spec.default) + ')' : ''}</option>
      {choices.map(c => <option key={String(c.value)} value={String(c.value)}>{c.label}</option>)}
    </select>
  } else if (spec.type === 'array' && spec.items?.type === 'integer') {
    control = <input id={id} type="text" required={required} placeholder={t('e.g. 1, 3, 4', '例如 1, 3, 4')}
      defaultValue={Array.isArray(value) ? value.join(', ') : ''} onChange={e => {
        const raw = e.currentTarget.value.trim()
        const parts = raw.split(/[,，\s]+/)
        const numbers = parts.map(Number)
        const valid = !raw || (parts.every(part => /^\d+$/.test(part)) &&
          numbers.every(n => Number.isSafeInteger(n) && n >= (spec.items?.minimum ?? 0)) && new Set(numbers).size === numbers.length)
        e.currentTarget.setCustomValidity(valid ? '' : t('Enter unique whole page numbers.', '请输入不重复的整数页码。'))
        setValue(raw && valid ? numbers : undefined)
      }} />
  } else if (spec.type === 'array') {
    control = <textarea id={id} required={required} defaultValue={value === undefined ? '' : JSON.stringify(value)}
      onChange={e => {
        const raw = e.currentTarget.value.trim()
        try {
          const list: unknown = raw ? JSON.parse(raw) : undefined
          if (list !== undefined && !Array.isArray(list)) throw new Error()
          e.currentTarget.setCustomValidity('')
          setValue(list)
        } catch { e.currentTarget.setCustomValidity(t('Enter a JSON array.', '请输入有效的 JSON 数组。')) }
      }}/>
  } else if (spec.type === 'number' || spec.type === 'integer') {
    control = <input id={id} type="number" min={spec.minimum} max={spec.maximum} step={spec.type === 'integer' ? 1 : 'any'}
      required={required} value={typeof value === 'number' ? value : ''} placeholder={String(spec.default ?? '')}
      onChange={e => setValue(Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : undefined)} />
  } else {
    control = <input id={id} required={required} type="text" value={String(value ?? '')} placeholder={String(spec.default ?? '')}
      onChange={e => setValue(e.target.value || undefined)} />
  }
  return <div><label htmlFor={id}>{label} </label>{control}</div>
}
