Isle Studio 1.2.0 · macOS 构建包
=================================

这个包里只有程序源码与打包配置：
  ✗ 不含任何用户数据（项目 / 资产 / 设置）
  ✗ 不含 API Key（首次启动后在「设置 → 模型」里填自己的）
  ✗ 不含 Windows 专用二进制（ffmpeg.exe / rcedit.exe）

在 Mac 上出包（需要 macOS + Node.js 20+）
----------------------------------------
1. 双击打开「终端」，cd 到本目录，例如：
     cd ~/Downloads/IsleStudio-1.2.0-mac-src
2. 执行：
     bash build-mac.sh
   （只出 Apple 芯片： bash build-mac.sh arm64 ；只出 Intel： bash build-mac.sh x64）
3. 完成后，产物在 release/ 目录：
     Isle Studio-1.2.0-arm64.dmg
     Isle Studio-1.2.0-arm64.zip
     Isle Studio-1.2.0-x64.dmg / .zip

未签名说明
----------
本次构建不带 Apple 开发者签名。macOS 首次打开会提示「无法验证开发者」：
  · 图形方式：在「访达」里右键 App → 打开 → 再点「打开」
  · 命令行：  xattr -cr "/Applications/Isle Studio.app"
想要彻底免提示，需要 Apple Developer 账号（$99/年）做 codesign + notarize，
配置点已经留好（build.mac 里 hardenedRuntime / entitlements 已就绪）。

功能差异（macOS）
----------------
· 成片合成（FFmpeg）不随包携带，需先执行： brew install ffmpeg
· 其它功能（生图 / 生视频 / 画布 / 项目管理）与 Windows 版一致
· 数据默认存在 ~/Library/Application Support/Isle Studio Release

没有 Mac？用 GitHub Actions 出包
--------------------------------
把本目录推到 GitHub 仓库（私有即可），进入 Actions → build-mac → Run workflow，
约 10 分钟后在 Artifacts 里下载 arm64 / x64 的 dmg（工作流文件已随包提供）。
