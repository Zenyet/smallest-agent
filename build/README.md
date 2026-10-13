# Smallest Agent 标识

圆润的 S 代表 Smallest，右上角的蓝色小圆点代表独立的 Agent 核心。深色圆角底板与桌面界面一致；16–1024 px 使用同一轮廓，避免依赖细线或文字。

- `icon.svg`：可编辑的主源文件，包含底板和 `mark` 图形。
- `icon.icns`：macOS 图标，覆盖 16–512 pt 及对应的 Retina 尺寸。
- `icon.ico`：Windows 图标，包含 16、24、32、48、64、128、256 px。
- `icon.png`：1024 px 透明边距应用图标，用于 Linux 和开发模式。
- `logo.svg` / `logo-inverse.svg`：透明背景标识，分别用于浅色和深色背景。
- `brand-preview.svg` / `brand-preview.png`：品牌及小尺寸展示稿。

修改 `icon.svg` 后运行 `pnpm build:icons`。PNG、ICO 和两种独立标识会重新生成；ICNS 需要在 macOS 上通过系统 `iconutil` 生成。应用侧边栏和启动页直接引用 SVG，安装包由 `electron-builder.cjs` 引用各平台图标。
