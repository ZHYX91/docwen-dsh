export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const MARKDOWN = 'text/markdown'
export const IMAGE_TYPES: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}
export const IMAGE_MEDIA = new Set(Object.values(IMAGE_TYPES))

const mediaTypes: Record<string, string> = {
  ...IMAGE_TYPES,
  '.docx': DOCX,
  '.md': MARKDOWN,
  '.markdown': MARKDOWN,
  '.pdf': 'application/pdf',
  '.ofd': 'application/vnd.ofd',
  '.xps': 'application/vnd.ms-xpsdocument',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.doc': 'application/msword',
  '.rtf': 'application/rtf',
  '.wps': 'application/vnd.ms-works',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.enex': 'application/x-evernote',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.txt': 'text/plain',
}

export function fileMedia(name: string, declared = ''): string {
  const basename = name.split(/[\/\\]/u).at(-1) ?? ''
  const dot = basename.lastIndexOf('.')
  return (dot >= 0 ? mediaTypes[basename.slice(dot).toLowerCase()] : undefined) ?? declared
}
