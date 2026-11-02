# 把 Electron 安装包从 194.41 MiB 压到 110.59 MiB

Smallest Agent 最初的 macOS DMG 有 194.41 MiB。对一个刚发布的桌面应用来说，这个下载体积值得认真查一遍：用户要多等一会儿，网络不好的时候也更容易放弃。

经过一轮打包优化，DMG 降到 110.59 MiB，少了 83.82 MiB，约 43%。这次优化先厘清发布包里哪些文件会在运行时用到，再按平台和架构精确打包，保留应用实际需要的能力。

## 先分清“开发时需要”和“用户运行时需要”

Electron 项目里，很多依赖只服务于开发、测试或构建。若把它们都放在 `dependencies`，打包器可能会把整份依赖目录一并带进应用，即使业务代码已经通过 Vite 编译进主进程或渲染器。

我们把纯 JavaScript 依赖放到 `devDependencies`，让 Vite 在构建阶段编译、压缩并做 tree-shaking；`dependencies` 则只保留运行时仍需从 Node 加载的 Transformers。调整前后可以在[体积优化提交](https://github.com/Zenyet/smallest-agent/commit/3e1c4d8c68bc49fdc7152a05845e1cd59c58423c)中看到。

这一步不能靠“看名字猜”。如果某个原生模块在运行时仍需要从 `node_modules` 加载，把它挪出生产依赖就会造成启动或功能故障。因此，依赖分类之后还要实际检查打包产物。

## 按运行环境裁掉重复内容

这个应用的本地 embedding 在 Node.js 中使用 CPU 推理。Transformers 4.2.0 的 Node 入口已经包含所需的 JavaScript 辅助代码，因此浏览器和 WASM 用的 `onnxruntime-web` 发行文件没有必要留在桌面包里。配置里还排除了 Transformers 的源码、类型文件和未使用的发行文件，以及 ONNX Runtime 的源码和脚本。

原生二进制则按目标系统和架构保留：macOS arm64 包只带 macOS arm64 的 ONNX 运行库，Windows x64 包只带 Windows x64 的版本。`sharp` 和 `libvips` 也采用同样的筛选规则。pnpm 为跨平台构建准备的其他平台二进制不会跟着进入当前安装包。

## 用明确的白名单约束产物

应用文件规则收录编译输出 `out/**/*`、运行时所需的 `package.json` 和应用使用的 Markdown 技能文件。缓存、环境文件、源码映射等不进入发布包。Electron 自带的语言资源也只保留英文、简体中文和繁体中文。

macOS DMG 使用 UDBZ 压缩格式。它可以减小下载体积，代价是构建镜像需要更长时间。对于用户下载的文件，这个取舍是值得的。

白名单配置有个容易踩的坑：不要把根目录的正向 `files` 规则和某个平台只有排除项的规则混在一起。electron-builder 可能因此把意料之外的源码树也纳入打包。为每个目标平台生成一份独立的文件规则，可以让最终内容更清楚，也更容易审查。

## 体积变小，必要能力仍要能用

瘦身不能只检查安装包大小。ONNX 原生库、`sharp` 的平台二进制、内置 MCP 服务和技能文件都是应用功能的一部分；把它们排除虽然能让数字更漂亮，却会让用户在运行时遇到问题。离线 embedding 模型缓存也没有放进安装包，知识库仍按原来的逻辑在首次使用时加载模型。

因此，每次打包还要验证产物本身。项目的 `check:package` 会检查归档白名单、ONNX 与 sharp 是否匹配目标平台、源码映射和缓存是否缺失，并在当前机器上运行打包后的 Transformers ESM/CJS 入口、ONNX CPU 推理、sharp、MCP 子进程和技能文件检查。交叉打包可以做静态归档检查，但 Windows 安装和实际运行仍需要 Windows runner 验证。

可以从仓库的[发布构建配置](https://github.com/Zenyet/smallest-agent/blob/f724a8b300436a86e3ae2faaec66989c28175dd3/electron-builder.cjs)和[检查脚本](https://github.com/Zenyet/smallest-agent/blob/f724a8b300436a86e3ae2faaec66989c28175dd3/scripts/check-package.mjs)查看具体规则。

## 结果

| macOS arm64 产物 | 体积 |
| --- | ---: |
| 首轮优化前 DMG | 194.41 MiB |
| 优化后 DMG | 110.59 MiB |
| 优化后 ZIP | 120.05 MiB |

最终 DMG 减少约 43%，Transformers 本地推理和 MCP 等运行能力仍包含在包中。Windows x64 也复用了按目标架构筛选依赖的策略，提供安装版和免安装版。

Electron 应用的安装包优化需要厘清构建依赖、运行时依赖和目标平台原生文件的边界，再用打包后检查确认功能可用。这样得到的体积数字，才对应用户实际拿到的应用。

[查看当前 Release 下载页](https://github.com/Zenyet/smallest-agent/releases/tag/v0.1.0)
