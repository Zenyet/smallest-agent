// Keep the editable SVG as the source for every native icon size.
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const sharp = require(require.resolve('sharp', { paths: [require.resolve('@huggingface/transformers')] }))
const svg = await readFile(join(root, 'build/icon.svg'))
const mark = svg.toString().match(/<g id="mark">([\s\S]*?)<\/g>/)?.[1]
if (!mark) throw Error('build/icon.svg must contain the canonical mark group')
for (const [name, ink, blue] of [['logo', '#17191e', '#2586e6'], ['logo-inverse', '#f4f6fa', '#59adff']]) {
  const shape = mark.replaceAll('#f4f6fa', ink).replaceAll('#59adff', blue)
  await writeFile(join(root, `build/${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="48 40 160 176" fill="none">${shape}</svg>\n`)
}
const png = (size) => sharp(svg).resize(size, size).png().toBuffer()
await mkdir(join(root, 'build'), { recursive: true })
await writeFile(join(root, 'build/icon.png'), await png(1024))

// PNG-backed ICO entries are supported by Windows Vista and newer.
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = await Promise.all(sizes.map(png))
const header = Buffer.alloc(6 + 16 * sizes.length)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
images.forEach((image, i) => {
  const entry = 6 + i * 16
  header[entry] = header[entry + 1] = sizes[i] === 256 ? 0 : sizes[i]
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(image.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += image.length
})
await writeFile(join(root, 'build/icon.ico'), Buffer.concat([header, ...images]))
if (process.platform === 'darwin') {
  const temp = await mkdtemp(join(tmpdir(), 'smallest-icons-'))
  try {
    const iconset = join(temp, 'icon.iconset')
    await mkdir(iconset)
    for (const size of [16, 32, 128, 256, 512]) {
      await writeFile(join(iconset, `icon_${size}x${size}.png`), await png(size))
      await writeFile(join(iconset, `icon_${size}x${size}@2x.png`), await png(size * 2))
    }
    const result = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'build/icon.icns')], { stdio: 'inherit' })
    if (result.status !== 0) throw Error('iconutil failed')
  } finally { await rm(temp, { recursive: true, force: true }) }
}
console.log('Generated build/icon.png, icon.ico' + (process.platform === 'darwin' ? ', icon.icns' : ''))
