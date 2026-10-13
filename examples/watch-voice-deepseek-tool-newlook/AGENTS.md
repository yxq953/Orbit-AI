# 项目约定

本文件适用于 `watch-voice-deepseek-tool-newlook`（Orbit AI）项目。

- 默认只修改本项目的手表端界面及相关构建产物。电脑端服务程序、其他示例项目和配对配置不随界面修改而改动，除非用户明确要求。
- 对话历史只在初次进入应用或退出后再次进入时清空；正常连续提问、轮询、手动网络重试、断线恢复和设备服务重启均保留当前界面历史。清空由应用进入生命周期触发，不放在开始录音或网络连接回调中。
- 当前终端运行在普通用户权限下。如需安装新的 NPM 依赖包，必须提示用户：“当前终端没有管理员权限，请告诉我需要安装哪些 NPM 包，我将为你进行手动安装。”优先复用已有依赖，不自动安装新包。

## 通过 ADB 上传并打开安装页面

用户要求将软件上传到手机、打开手表应用安装页面时，按以下顺序执行。默认终点是：手机停留在已填写正确包名的第三方应用安装页面；选择 RPK 和上传到手表由用户手动完成。

### 1. 先输出包名和 RPK 文件名，再连接手机

从本项目 `src/manifest.json` 读取 `package` 和 `versionName`，确认 `dist` 中存在最新构建的 RPK。需要构建时，在本项目内使用已有构建依赖。

**在执行任何 ADB 命令前，先向用户清楚输出以下信息：**

- 应用包名。
- 本地构建的 RPK 文件名。
- 上传到手机后的 RPK 文件名及目录，方便用户稍后手动选择。

当前命名示例（以当次 manifest 和构建产物为准）：

| 项目 | 名称或路径 |
| --- | --- |
| 包名 | `com.example.redmi.voicedeepseek` |
| 本地 RPK | `com.example.redmi.voicedeepseek.debug.1.0.3.rpk` |
| 手机 RPK | `com.example.redmi.voicedeepseek.rpk` |
| 手机目录 | `Download/RedmiWatch/` |

然后执行 `adb devices -l`，确认手机已连接且状态为 `device`。后续命令使用明确的手机序列号。多台手机且目标不明确时，先确认目标；不要盲目选择设备。

### 2. 上传到手机的 Download/RedmiWatch/ 目录

目标目录固定为 `/sdcard/Download/RedmiWatch/`，上传文件统一命名为 `<package>.rpk`，即不带本地构建文件名中的 `.debug.<versionName>` 部分。

```powershell
# 在本项目目录执行；$phoneSerial 为上一步确认的手机序列号。
$watchManifest = Get-Content -LiteralPath src/manifest.json -Raw | ConvertFrom-Json
$watchRpkName = '{0}.debug.{1}.rpk' -f $watchManifest.package, $watchManifest.versionName
$phoneRpkPath = '/sdcard/Download/RedmiWatch/' + $watchManifest.package + '.rpk'
adb -s $phoneSerial shell mkdir -p /sdcard/Download/RedmiWatch
adb -s $phoneSerial push (Join-Path 'dist' $watchRpkName) $phoneRpkPath
```

确认 push 成功；条件允许时核对手机端文件大小或哈希。连接中断时如实报告当前进度，恢复连接后继续尚未完成的步骤。

### 3. 打开安装页面，填写包名并停留

复用仓库已有的 `LaunchFragment` DEX 和小米运动健康第三方应用调试页打开方式。参考仓库的 `scripts/deploy-watch.ps1` 与 `scripts/LaunchFragment.java`，根据手机实际安装情况选择 `com.mi.health` 或 `com.xiaomi.wearable`。

页面操作顺序：

1. 打开 `ThirdAppDebugFragment` 第三方应用安装页面。
2. 点击 `inputPackageName`，进入包名输入对话框。
3. 在 `pkgNameView` 填入本次 manifest 的完整包名；如已有内容，先替换，避免追加。
4. 确认输入无误，收起键盘并确认包名对话框。
5. 重新读取页面，核对 `showPackageName` 与本次包名完全一致。
6. **停留在这个安装页面，停止自动操作。**

定位控件使用当次 UI 层级和 resource-id，不使用过期坐标。只确认包名对话框，不点击 `installThirdApp`，不打开文件选择器，不选择 RPK，也不启动向手表上传或安装。

**现有 `scripts/deploy-watch.ps1` 在核对包名后会自动点击 `installThirdApp`，因此不能原样执行完整脚本。复用其必要步骤时，必须在核对 `showPackageName` 后停下。**

完成后告诉用户：已上传的手机目录、手机上的 RPK 文件名，以及安装页面已打开并填好包名。

### 4. 用户手动选择软件并上传到手表

后续由用户在手机上点击安装入口，选择 `Download/RedmiWatch/<package>.rpk`，并完成向手表上传和安装。助手保持交接时的页面，不继续点击。

上传到手机或打开页面不代表已安装到手表；只有用户告知安装完成或获得明确的安装成功证据后，才能确认安装完成。
