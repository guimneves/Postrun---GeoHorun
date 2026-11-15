/**
 * Exportação de figuras para publicação (F5 do artigo — exigências da JAAP):
 * SVG vetorial, ou PNG a 300 dpi com 1063 px (uma coluna) ou 2244 px (página
 * inteira) de largura. Sempre com fundo branco e as cores do tema CLARO, os
 * estilos resolvidos (o arquivo não depende do CSS do Horun) e fonte
 * Arial/Helvetica.
 */

export type FigureFormat = 'svg' | 'png-col' | 'png-page'

export const JAAP_WIDTH_PX: Record<Exclude<FigureFormat, 'svg'>, number> = { 'png-col': 1063, 'png-page': 2244 }
const DPI = 300

// propriedades de apresentação copiadas do estilo calculado para o SVG exportado
const PROPS = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'opacity', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline',
] as const

/** Roda `fn` com o tema claro aplicado (para as variáveis de cor resolverem
 * para as do tema claro) e devolve o tema anterior. */
function withLightTheme<T>(fn: () => T): T {
  const root = document.documentElement
  const prev = root.getAttribute('data-theme')
  root.setAttribute('data-theme', 'light')
  try {
    return fn()
  } finally {
    if (prev === null) root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', prev)
  }
}

function standaloneSvg(svg: SVGSVGElement): { text: string; width: number; height: number } {
  return withLightTheme(() => {
    const clone = svg.cloneNode(true) as SVGSVGElement
    const src = [svg, ...Array.from(svg.querySelectorAll<SVGElement>('*'))]
    const dst = [clone, ...Array.from(clone.querySelectorAll<SVGElement>('*'))]
    src.forEach((el, i) => {
      const cs = getComputedStyle(el)
      const out = dst[i]
      for (const p of PROPS) {
        const v = cs.getPropertyValue(p)
        if (v && v !== 'normal' && !(p === 'stroke-dasharray' && v === 'none')) out.setAttribute(p, v)
      }
      out.removeAttribute('class')
      out.removeAttribute('style')
    })
    const vb = svg.viewBox.baseVal
    const width = vb && vb.width ? vb.width : svg.clientWidth
    const height = vb && vb.height ? vb.height : svg.clientHeight
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(width))
    clone.setAttribute('height', String(height))
    clone.setAttribute('font-family', 'Arial, Helvetica, sans-serif')
    // fundo branco (revistas não aceitam fundo transparente/escuro)
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    bg.setAttribute('x', String(vb?.x ?? 0))
    bg.setAttribute('y', String(vb?.y ?? 0))
    bg.setAttribute('width', String(width))
    bg.setAttribute('height', String(height))
    bg.setAttribute('fill', '#ffffff')
    clone.insertBefore(bg, clone.firstChild)
    // dicas de tela (<title>) não vão para o arquivo
    clone.querySelectorAll('title').forEach((t) => t.remove())
    return { text: new XMLSerializer().serializeToString(clone), width, height }
  })
}

// --- PNG com 300 dpi gravados (chunk pHYs) ---------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Insere o chunk pHYs (pixels por metro) logo depois do IHDR. */
export function withDpi(png: Uint8Array, dpi = DPI): Uint8Array<ArrayBuffer> {
  const ppm = Math.round(dpi / 0.0254)
  const chunk = new Uint8Array(21)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, 9)
  chunk.set([0x70, 0x48, 0x59, 0x73], 4) // "pHYs"
  view.setUint32(8, ppm)
  view.setUint32(12, ppm)
  chunk[16] = 1 // metro
  view.setUint32(17, crc32(chunk.subarray(4, 17)))
  const ihdrEnd = 8 + 25
  const out = new Uint8Array(new ArrayBuffer(png.length + chunk.length))
  out.set(png.subarray(0, ihdrEnd), 0)
  out.set(chunk, ihdrEnd)
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length)
  return out
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function safeName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '') || 'figura'
}

export async function exportFigure(svg: SVGSVGElement, name: string, format: FigureFormat): Promise<void> {
  const { text, width, height } = standaloneSvg(svg)
  const base = safeName(name)
  if (format === 'svg') {
    download(new Blob([text], { type: 'image/svg+xml' }), `${base}.svg`)
    return
  }
  const targetW = JAAP_WIDTH_PX[format]
  const scale = targetW / width
  const img = new Image()
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('não deu para desenhar a figura'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('sem canvas')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('falha ao gerar o PNG'))), 'image/png'),
    )
    const png = withDpi(new Uint8Array(await blob.arrayBuffer()))
    download(new Blob([png], { type: 'image/png' }), `${base}_${targetW}px_300dpi.png`)
  } finally {
    URL.revokeObjectURL(url)
  }
}
