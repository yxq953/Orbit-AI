# Orbit AI

**面向 Redmi Watch 5 的腕上 AI 助手：语音提问、DeepSeek 回答与 AnySearch 联网搜索。**

Orbit AI 基于小米 Vela JS 快应用框架开发。你可以在手表上说出问题，由手机与服务端协同完成语音识别、模型调用和工具执行，再将回答送回手表。问答与搜索由 Linux 云服务器运行；Windows 电脑仅运行打印代理。云端管理网页通过 SSH 隧道访问。

当前服务器版使用 `http://47.100.201.122:8767`，由 systemd 常驻运行，启用问答、搜索与本地打印桥接。手机可通过 Wi-Fi 或移动网络连接，无需与电脑处于同一局域网；语音识别仍依赖微信与小米运动健康。

## 概念图

![Orbit AI 手表与电脑控制台概念图](../../docs/images/dashboard-overview.png)

*概念图用于展示产品布局与交互思路，实际界面以当前版本为准。*

## 主要功能

- **语音提问**：使用手表麦克风录音，借助微信原生服务转为文字，自动提交问题并接收回答。
- **腕上阅读**：采用深色与薄荷绿配色，回答按行显示，支持滚动查看长文本。
- **联网搜索**：通过 AnySearch 完成通用搜索、垂直搜索、批量查询和网页正文提取，再由模型生成简短摘要。
- **云端打印桥接**：手表发出明确打印请求，云端生成任务，本地代理通过 SSH 隧道领取并调用 Windows 打印机，再回传结果。
- **电脑控制台**：查看识别文字、模型任务和回答送达状态；支持“询问 DeepSeek”与“直接发送到手表”两种模式。

当前手表应用版本为 **v1.0.5**，包名为 `com.example.redmi.voicedeepseek`。

## 工作流程

```text
手表录音 → 微信原生服务转文字 → 手机转发 → 服务端
                                              ↓
                                         DeepSeek
                                         ↙      ↘
                                  AnySearch    云端打印队列 → SSH 隧道 → Windows 打印代理
                                              ↓
服务端消息队列 → 手表轮询 → 分行显示回答或工具执行结果
```

项目向服务端和 DeepSeek 提交的是识别文字，不导出或上传原始音频文件。语音识别仍依赖手机微信登录、手表微信服务及手机连接；所选微信会话用于满足录音协议，应用不会通过 `stopRecord('send')` 发送微信聊天消息。

## 仓库结构

```text
examples/watch-voice-deepseek-tool-newlook/
├── src/                 # 手表界面、录音与通信逻辑
├── desktop/             # 本地打印代理与 Windows 打印接口
├── cloud/               # 云端 HTTP、DeepSeek、AnySearch 适配与打印队列
├── shared/              # 打印参数协议与持久化工具
├── deploy/              # Linux systemd 单元与安装脚本
├── tool/                # Windows 打印脚本（已移除 AnySearch CLI）
├── tools/               # 构建工具与图标生成脚本
└── tests/               # 手表端逻辑测试

docs/                    # 部署文档与概念图
scripts/                 # 部署及模拟器辅助脚本
firmware/                # 固件资料与分析记录
```

## 环境准备

| 用途 | 要求 |
| --- | --- |
| 电脑服务 | Node.js 20.3 或更高版本；服务本身仅使用 Node.js 内置模块 |
| 手表应用构建 | 项目 `package.json` 中声明的开发依赖，包括 aiot-toolkit 与 @aiot-toolkit/jsc |
| 模型问答 | 可用的 DeepSeek API Key |
| 语音识别 | Redmi Watch 5、已登录微信的手机、可用的手表微信服务，以及与手表连接的小米运动健康 |
| 网络通信 | 手机可访问服务地址；局域网部署需同一网络，服务器部署需开放对应端口 |
| 文本打印（可选） | Windows、已安装 pywin32 的 Python，以及已配置的打印机 |
| 联网搜索（可选） | 可用的 AnySearch Skill 目录与网络连接 |

构建脚本优先使用本项目的 `node_modules`，缺少时尝试复用 `examples/hello-world/node_modules` 中已有的构建依赖。仓库不包含这些依赖，也不包含 `hello-world` 参考项目；首次使用时需按本项目的 `package.json` 准备构建环境。构建脚本不会自动安装 NPM 包。

## 本地打印代理

在本项目目录运行：

```powershell
npm.cmd start
```

本地只启动 Node.js 打印代理与 SSH 客户端，不启动 HTTP 问答服务、不读取 DeepSeek Key，也不加载或执行 AnySearch。项目内原有 `tool/anysearch-skill` 已移除；系统中的 Codex Skill 不受影响。

私密配置位于 `.runtime/print-agent.json`（已忽略，不可提交）：

```json
{ "sshTarget": "root@47.100.201.122", "localPort": 18768, "token": "<独立的打印桥接密钥，至少32字符>" }
```

部署时在服务器生成 `/etc/orbit-ai/print-agent.json`，通过 SCP 下载到上述位置。它使用独立桥接密钥，不使用手表配对令牌。当前依赖已配置的 SSH 密钥登录；无需安装 NPM 依赖、无需打开本地公网端口。保持终端、电脑和打印机开启。按 Ctrl+C 关闭代理后，问答与搜索继续运行，打印会提示电脑未连接。

连接路径：

```text
手表 → 手机 → 公网 47.100.201.122:8767 → DeepSeek 的 print_text
                                      ↓
                        云端持久化打印队列（127.0.0.1:8768）
                                      ↑ SSH 加密隧道
                        本地代理（127.0.0.1:18768）
                                      ↓
                        Python / Windows 打印队列 / HP
                                      ↓
                        结果原路回到云端 → 手表
```

云端仅在回环地址开放打印桥接端口；公网 8767 不提供领取、回传接口。代理每1.5秒领取任务，SSH 断线后自动重连。关闭或重启代理不会自动重打已经领取的任务。换代理进程后，云端旧心跳最多40秒过期。

## Linux 服务器部署

当前实例为 Ubuntu 24.04 / Node.js 24，`orbit-ai.service` 以专用用户运行，开机自启、异常自动重启。服务启动入口为 `node cloud/server.cjs`（或 `npm run start:cloud`）；本地 `npm.cmd start` 不是云端入口。

| 位置 | 内容 |
| --- | --- |
| `/opt/orbit-ai/current` | 当前云端版本软链接 |
| `/opt/orbit-ai/releases/` | 历次代码版本 |
| `/opt/orbit-ai/anysearch-skill` | 仅云端安装的 AnySearch CLI |
| `/etc/orbit-ai/server.env` | DeepSeek、AnySearch 和桥接密钥 |
| `/etc/orbit-ai/connection.json` | 与已有 RPK 一致的公网地址和配对令牌 |
| `/var/lib/orbit-ai/print-queue.json` | 持久化打印任务和去重记录 |
| `/etc/orbit-ai/backups/` | 部署前配置、systemd 单元与上个版本路径 |

更新现有服务器时：

```powershell
node tools/package-server.cjs
# 用上一步输出的全路径替换 <stage>；打包内容仅为代码，不含密钥。
tar -czf .runtime/orbit-ai-cloud.tgz -C <stage> .
ssh root@47.100.201.122 'install -d -m 700 /root/orbit-ai-bridge-upload'
scp .runtime/orbit-ai-cloud.tgz root@47.100.201.122:/root/orbit-ai-bridge-upload/release.tgz
ssh root@47.100.201.122 'tar -xzf /root/orbit-ai-bridge-upload/release.tgz -C /root/orbit-ai-bridge-upload && bash /root/orbit-ai-bridge-upload/deploy/install-server.sh'
scp root@47.100.201.122:/etc/orbit-ai/print-agent.json .runtime/print-agent.json
```

安装脚本保留已有密钥和手表配对配置；首次迁移时将上个云端版本的 AnySearch CLI 移至独立安装目录。后续更新不再上传本地 Skill。此脚本用于已配置实例的升级，不用于空白服务器初始化。

环境设置包含 `PRINT_ENABLED=1`、独立的 `PRINT_BRIDGE_TOKEN`、`PRINT_QUEUE_FILE` 和 `ANYSEARCH_SKILL_DIR=/opt/orbit-ai/anysearch-skill`。云端不调用 Windows Python，只向本地代理分发任务。可设置 `PRINT_ENABLED=0` 关闭模型打印工具。

健康检查：[http://47.100.201.122:8767/health](http://47.100.201.122:8767/health)。手表继续使用 `POST /api/sync` 和原配对令牌，无需修改、构建或重新安装 RPK。

访问云端管理网页：

```powershell
ssh -N -L 18767:127.0.0.1:8767 root@47.100.201.122
```

浏览器打开 [http://127.0.0.1:18767/](http://127.0.0.1:18767/)。云端运维使用 `systemctl status orbit-ai`、`journalctl -u orbit-ai -n 50 --no-pager`。公网手表链路沿用现有 HTTP；本地打印代理链路通过 SSH 加密。

## RPK 构建与安装

本次连续对话修改需要更新 RPK。可运行 `npm.cmd test` 和 `npm.cmd run build`，产物为 `dist/com.example.redmi.voicedeepseek.debug.1.0.5.rpk`。修改服务器地址或配对令牌才需要 `npm.cmd run configure -- --host <IPv4> --port <端口>` 并重建；不要为启用打印重新配置地址。

手机上传与安装交接遵循 [AGENTS.md](AGENTS.md)：上传到 `Download/RedmiWatch/com.example.redmi.voicedeepseek.rpk`，填写包名后由用户手动选择文件并安装。

## 使用方法

1. 保持手机微信登录，并确认手表微信能够读取会话；返回表盘后打开 Orbit AI，保持微信服务运行。
2. 应用会自动读取会话。若读取失败，在“设置”中点击“读取会话”，选择“换会话”或输入实际会话标识；昵称不能替代会话标识。
3. 点击“开始说话”或“继续提问”。录音将在 8 秒后自动停止，也可点击“说完了”提前结束。
4. 识别成功后，完整文字会自动上传。手表先显示提问，再显示 DeepSeek 的回答；电脑控制台同步显示任务状态。
5. 保持应用在前台接收回答。网络失败时会使用同一消息 ID 重试，也可点击顶部连接状态立即重试；上一条问题未完成时不能再次提交录音。
6. “取消”用于结束当前录音或识别，已提交的问题仍会继续处理。等待回答超过 75 秒后可以重新提问，原任务可能仍在服务端队列中。

同一次进入应用期间，连续提问、网络重试、断线恢复和设备服务重启均保留当前界面历史；切换应用内设置页面也不会清空。首次进入或退出后再次进入时会同时清空界面历史和云端模型上下文，仍在处理的当前问题会继续接收结果。

**连续上下文由云端按本次应用会话维护。** 服务器会把最近 6 轮问答作为后续提问的上下文，因此“这个”“刚才那件事”等追问可以结合前文理解。手表端只发送会话标识和“重新进入应用时清空上下文”的信号，不保存模型密钥或完整上下文。重新进入应用会新建上下文；网络重试、轮询和普通连续提问不会清空。云端服务重启后内存中的上下文会自然失效，需要重新说明必要背景。

## 联网搜索

发送完整请求即可由模型选择搜索工具，例如：

- “联网搜索 Node.js 22 官方发布说明，用一句话总结并注明来源。”
- “搜索苹果股票的最新行情。”
- “读取 https://example.com 的内容，简短总结。”
- “搜索这个问题，并帮我打印一段简短摘要。”

服务提供 `anysearch_search`、`anysearch_batch_search`、`anysearch_get_sub_domains` 和 `anysearch_extract` 四个工具。垂直搜索先查询子领域与参数，再执行检索。通用搜索默认返回 3 条结果，最多 5 条；批量搜索最多包含 5 个查询。网页提取支持 HTML、文本、JSON 和 Markdown，不支持 PDF、Office 文档或图片等二进制文件。

AnySearch 仅在云端调用，使用 `/opt/orbit-ai/anysearch-skill`，可由云端 `ANYSEARCH_SKILL_DIR` 覆盖。Key 保留在服务器配置中，本地打印代理无需搜索 Key 或 Skill。搜索词与待提取 URL 会发送至 AnySearch API。

搜索结果由模型整理为适合手表阅读的短回答。每个问题最多执行 4 轮工具调用，单次工具输出最多 16,000 个字符；搜索失败会交由模型说明，不自动切换其他搜索服务。

## 文本打印

云端模型决定是否调用打印工具，本地代理执行实际打印。启用或调整打印设置只需重启本地代理，无需重新构建 RPK。

例如，“帮我打印：明天下午三点开会”可触发正文打印；“打印机怎么连接？”属于普通问答，“不要打印，只告诉我……”不应触发打印。同一对话中可说“把刚才那段打印出来”，通过上下文确定正文；本轮没有明确要求打印时，不会因为历史中的打印请求而再次执行。未给出可确定的内容时，助手会询问；下一条消息仍需明确要求打印。电脑网页的“直接发送到手表”模式不会调用模型或打印工具。

当前支持 **1–500 个字符、排版后最多 30 行、每次一份** 的文本打印，使用 16 pt 微软雅黑。工具暂不提供文件、多份、字号或双面设置。默认打印机为 `NPI689498 (HP LaserJet MFP M233dw)`，可在启动前修改：

```powershell
# 可选：指定已安装 pywin32 的 Python；路径不附带命令行参数。
$env:PRINT_PYTHON = 'C:\Python310\python.exe'
$env:PRINT_PRINTER = '你的 Windows 打印机名称'

# 演练模式：验证工具调用与排版，不实际出纸。
$env:PRINT_DRY_RUN = '1'
npm.cmd start
```

恢复实际打印时，执行 `Remove-Item Env:PRINT_DRY_RUN -ErrorAction SilentlyContinue` 并重启服务。

工具会原样回传打印机、页数、任务号与队列验证结果，不将“仍在队列”或“未看到对应任务”表述为打印成功。打印不会自动重试；若任务状态不明确，请先检查队列。云端按原始请求 ID 持久化去重，本地按打印任务 ID 持久化去重。领取后不重新投递；代理执行中断标记为状态未确认。未领取任务超时取消。相同文字以新的请求 ID 再次发送，仍是一次新的打印请求。不要删除 `.runtime/print-journal.json` 或云端打印记录来重试。

## 当前限制

| 项目 | 行为与限制 |
| --- | --- |
| 识别文字 | 最多 2,000 个 Unicode 字符；超长时提示重新录音，不截断提交 |
| 回答显示 | 最多保留 420 个 Unicode 字符，分段回传并按行显示 |
| 超时 | 识别 30 秒；单次模型调用 45 秒；含工具调用的整次任务 65 秒；AnySearch 进程 20 秒；打印进程 25 秒，其中队列验证最多等待 10 秒 |
| 任务队列 | 云端串行处理，最多 8 条待处理任务；模型失败或队列已满会以文字回传 |
| 后台行为 | 离开前台会取消录音或识别并暂停轮询，返回前台后继续接收已提交问题的回答 |
| 数据保存 | 聊天和模型队列保存在内存；打印任务和去重记录保存在云端与本地磁盘 |
| 去重范围 | 聊天请求去重限于进程；打印副作用按持久化请求 ID 和任务 ID 去重 |
| 设备适配 | 当前针对 Redmi Watch 5 开发，其他设备的显示与原生服务兼容性需单独验证 |

## 开发与验证

在项目目录中执行：

```powershell
npm.cmd test
npm.cmd run build
```

自动化测试覆盖录音状态机、HTTP 同步、重试去重、Unicode 长文本、分段回复、后台暂停、取消与超长识别处理，以及模型错误、打印参数校验、队列结果保留、AnySearch 参数校验、多轮工具调用和搜索后打印等场景。

测试覆盖云端桥接认证、离线拒绝、任务超时、重启恢复、重复任务和回传丢失。测试使用模拟模型、搜索服务和打印进程，不消耗真实 API 额度，也不实际出纸。真实手表的麦克风、微信服务、手机转发和屏幕显示仍需单独验收；打印演练模式验证通过也不代表实体出纸成功。

## 许可证

仓库采用 [MIT License](../../LICENSE)。随附的工具与第三方资料如有独立许可证，以各自目录中的声明为准。
