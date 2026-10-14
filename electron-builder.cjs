// Keep one allowlist per target. Mixing root FileSets with a platform's
// negative-only `files` matcher can make electron-builder include the source tree.
function filesFor(platform) {
  const sharpPlatform = platform === 'linux' ? 'linux?(musl)' : platform
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
    // pnpm also installs Windows binaries for cross-building on macOS. Keep
    // only the target's sharp/libvips packages in each application.
    `!node_modules/@img/!(colour|sharp-${sharpPlatform}-\${arch}|sharp-libvips-${sharpPlatform}-\${arch}){,/**}`,
    { from: 'skills', to: 'out/main/skills', filter: ['*.md'] },
  ]
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.smallest-agent.app',
  productName: 'Smallest Agent',
  directories: { output: 'dist-electron', buildResources: 'build' },
  // NSIS 3.12 includes a native Apple Silicon compiler for cross-building.
  // The legacy default ships an x86_64-only macOS compiler.
  toolsets: { nsis: '1.2.1' },
  asarUnpack: [
    '**/node_modules/onnxruntime-node/**',
    '**/node_modules/sharp/**',
    '**/node_modules/@img/**',
  ],
  compression: 'maximum',
  electronLanguages: ['en-US', 'zh-CN', 'zh-TW'],
  mac: {
    icon: 'build/icon.icns',
    files: filesFor('darwin'),
    electronLanguages: ['en', 'zh_CN', 'zh_TW'],
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    identity: '-',
  },
  // Smaller download than UDZO/ULFO, at the cost of slower image creation.
  dmg: { format: 'UDBZ' },
  win: {
    icon: 'build/icon.ico',
    files: filesFor('win32'),
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
  },
  nsis: {
    artifactName: 'Smallest-Agent-${version}-win-${arch}-Setup.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    installerLanguages: ['en_US', 'zh_CN', 'zh_TW'],
  },
  portable: {
    artifactName: 'Smallest-Agent-${version}-win-${arch}-Portable.${ext}',
  },
  linux: {
    icon: 'build/icon.png',
    files: filesFor('linux'),
    extraResources: [{ from: 'build/icon.png', to: 'icon.png' }],
    target: ['AppImage'],
  },
  artifactName: 'Smallest-Agent-${version}-${os}-${arch}.${ext}',
}
