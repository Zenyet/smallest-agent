// Keep one allowlist per target. Mixing root FileSets with a platform's
// negative-only `files` matcher can make electron-builder include the source tree.
function filesFor(platform) {
  return [
    'out/**/*',
    'package.json',
    '!**/*.map',
    '!**/.cache{,/**}',
    '!**/.env{,.*}',
    // Embedding runs in Node on CPU. Transformers 4.2.0's Node entry already
    // bundles its JS helpers; the separate browser/WASM distribution is unused.
    '!node_modules/onnxruntime-web{,/**}',
    '!node_modules/@huggingface/transformers/{src,types}{,/**}',
    '!node_modules/@huggingface/transformers/dist/!(transformers.node.mjs|transformers.node.cjs)',
    '!node_modules/onnxruntime-node/{src,script}{,/**}',
    `!node_modules/onnxruntime-node/bin/napi-v*/!(${platform})/**`,
    '!node_modules/onnxruntime-node/bin/napi-v*/*/!(${arch})/**',
    { from: 'skills', to: 'out/main/skills', filter: ['*.md'] },
  ]
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.smallest-agent.app',
  productName: 'Smallest Agent',
  directories: { output: 'dist-electron', buildResources: 'build' },
  asarUnpack: [
    '**/node_modules/onnxruntime-node/**',
    '**/node_modules/sharp/**',
    '**/node_modules/@img/**',
  ],
  compression: 'maximum',
  electronLanguages: ['en-US', 'zh-CN', 'zh-TW'],
  mac: {
    files: filesFor('darwin'),
    electronLanguages: ['en', 'zh_CN', 'zh_TW'],
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    identity: '-',
  },
  // Smaller download than UDZO/ULFO, at the cost of slower image creation.
  dmg: { format: 'UDBZ' },
  win: { files: filesFor('win32'), target: ['nsis', 'portable'] },
  linux: { files: filesFor('linux'), target: ['AppImage'] },
  artifactName: 'Smallest-Agent-${version}-${os}-${arch}.${ext}',
}
