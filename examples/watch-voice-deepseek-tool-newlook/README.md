# 腕上语音 AI：Redmi Watch 5 + DeepSeek + 打印 / AnySearch Tool

## Orbit AI 手表界面（v1.0.3）

本 `watch-voice-deepseek-tool-newlook` 项目的应用名为 **Orbit AI**，采用深色薄荷绿界面，手表图标为轨道环与语音波形。图标资源位于 `src/common/orbit-ai.png`，可编辑设计位于 `src/common/orbit-ai.svg`。

对话气泡按文字行分块绘制，以支持长回答逐行滚动。背景容器不设置内边距，文字独立保留左右 10px 内边距，使圆角补边层覆盖整个气泡宽度，修复标题与正文交界处右侧的缺口。

首次进入应用或退出后再次进入时，清空手表上的旧对话并跳过服务端积累的历史消息。同一次进入应用期间，连续提问、正常轮询、手动网络重试、断线恢复以及设备服务更换会话均保留当前界面历史。重复触发前台显示不会清空或重启同步；切换应用内的设置页面也不会清空。重新进入时，仍在上传或等待回答的当前问题继续接收结果，并保持原请求 ID，避免重复提交；已经清空的其他旧问题不会因迟到回复重新出现。

界面仅显示“开始说话 / 说完了 / 继续提问”和录音时的“取消”，不显示重发控件。上传失败或设备服务重启后，请重新提问。

本版本构建产物：`dist/com.example.redmi.voicedeepseek.debug.1.0.3.rpk`。上传到手机仍命名为 `Download/RedmiWatch/com.example.redmi.voicedeepseek.rpk`；ADB 上传与安装页面交接遵循本项目 `AGENTS.md`，填好包名后停留在页面，由用户手动选择 RPK 并上传到手表。电脑端服务程序未随此版本修改。

独立示例项目，包名 `com.example.redmi.voicedeepseek`，手表应用名“Orbit AI”。参考 `../watch-native-recorder` 的实机语音识别路径和 `../watch-chat-deepseek` 的电脑中转服务，实现：

```text
手表麦克风录音 → 微信原生服务转文字 → 手表获取识别结果
  → system.fetch / 手机与小米运动健康转发 → 电脑 /api/sync
  → DeepSeek 回答 → 电脑消息队列 → 手表轮询 → 分行显示回答
```

微信服务负责语音识别；本项目上传到电脑和 DeepSeek 的是识别文字，不导出或上传原始音频文件。微信识别仍需要手机微信登录、手表微信服务和手机连接。不会调用 `stopRecord('send')` 发送微信聊天消息。

## 启动

电脑服务只使用 Node.js 内置模块，需 Node.js 20.3+。构建复用 `../hello-world/node_modules` 内已有的 aiot-toolkit 2.0.5，不自动安装 NPM 包。

```powershell
cd D:\workspace01\xiaomicli\xiaomi-band-development\examples\watch-voice-deepseek-tool-newlook
npm.cmd run configure
npm.cmd test
npm.cmd run build
npm.cmd start
```

默认端口 **8767**，可与原 DeepSeek 项目的 8765 服务并行运行。`configure` 自动选择电脑局域网 IPv4，也可明确指定：

```powershell
npm.cmd run configure -- --host 192.168.0.175 --port 8767
```

电脑本机页面：<http://127.0.0.1:8767/>。手机连通性检查：`http://电脑IPv4:8767/health`。手机和电脑保持同一局域网，允许电脑防火墙接收该端口；小米运动健康保持运行并与手表蓝牙连接。

配对地址和随机令牌保存在 `.runtime/connection.json` 与 `src/common/connection.js`，均被本项目忽略。修改地址或端口后必须重新构建、安装 RPK。重复 configure 保留本项目令牌，不读取或更改参考项目配置。

服务端沿用仓库根目录 `../../deepseekapi.txt` 的 API Key，也支持 `DEEPSEEK_API_KEY` / `DEEPSEEK_KEY_FILE`。密钥不进入手表、网页或日志。默认模型 `deepseek-flash`，可通过 `DEEPSEEK_MODEL` 覆盖。问题文字会发送至 DeepSeek API，按其价格计费。

## 自动打印（最小版本）

只增加服务端能力，手表 APP、同步协议和 RPK 均无需修改。已有连接配置时，重启本目录的电脑服务即可：

```powershell
cd D:\workspace01\xiaomicli\xiaomi-band-development\examples\watch-voice-deepseek-tool
npm.cmd start
```

手表识别文字或电脑网页“询问 DeepSeek”消息会交给模型判断意图，通过 `tools` + `tool_choice: auto` 选择 `print_text`。例如“帮我打印：明天下午三点开会”会自动打印正文一份；“打印机怎么连接？”、“不要打印，只告诉我……”仍作为普通问题回答。仅提到打印而未说明内容时，助手询问要打印什么。每条消息独立处理，追问后需重新发送完整打印指令。网页“直接发送到手表”模式不调用模型或打印。

第一版只支持最多500个字符、排版后最多30行的文本，每次一份；文件、多份、字号和双面暂未暴露为 tool 参数。中文按短行排版，使用16pt微软雅黑。服务端固定调用本项目 `tool/print/scripts/print.py text`，显式指定 `NPI689498 (HP LaserJet MFP M233dw)`，等待队列最多10秒，原样回传打印机、页数、任务号及验证结果。“仍在队列”或“未看到对应任务”不会被改写成打印成功。工具调用结束后直接回传脚本摘要，不再请求模型生成确认文字，也不自动重试打印。

默认使用 `py -3`，需该 Python 已安装 `pywin32`，并且 Windows 已连接目标打印机。可在启动前设置：

```powershell
# 仅在需要切换 Python / 打印机时设置，Python 路径不要带命令行参数。
$env:PRINT_PYTHON = 'C:\Users\yxq\AppData\Local\Programs\Python\Python310\python.exe'
$env:PRINT_PRINTER = 'NPI689498 (HP LaserJet MFP M233dw)'
# 调试时只排版、验证接口，不出纸；恢复真实打印前删除此变量并重启服务。
$env:PRINT_DRY_RUN = '1'
npm.cmd start
```

删除演练模式：`Remove-Item Env:PRINT_DRY_RUN -ErrorAction SilentlyContinue`，然后重启服务。同一进程内重试相同消息 ID 不会重复打印；手动“重发文字”会生成新 ID，服务重启也会清空去重记录，因此任务状态不明确时应先检查打印队列。

## AnySearch 联网搜索

已接入本机安装的 `anysearch-skill`，复用其 Node.js CLI，不安装新 NPM 依赖。手表识别文字和电脑网页“询问 DeepSeek”均可使用，原手表 APP 无需重新构建。默认 Skill 路径是当前用户目录下的 `.codex/skills/anysearch-skill`；换机器或安装位置不同，可通过 `ANYSEARCH_SKILL_DIR` 指定。

向助手发送完整请求即可自动选择工具，例如：

- “联网搜索 Node.js 22 官方发布说明，用一句话总结并注明来源。”
- “搜索苹果股票的最新行情。”（先发现金融子领域及参数，再搜索。）
- “读取 https://example.com 的内容，简短总结。”
- “搜索这个问题，并帮我打印一段简短摘要。”（打印结果仍由打印脚本直接回传。）

提供四个工具：`anysearch_search`、`anysearch_batch_search`、`anysearch_get_sub_domains`、`anysearch_extract`。通用搜索默认3条结果，最多5条；批量最多5个查询。垂直搜索必须先发现子领域，服务端补齐缺失必填参数为空字符串。网页提取支持 HTML、文本、JSON、Markdown，不支持 PDF、Office、图片等二进制文件。单次工具输出最多16000字符，模型再总结成手表短回答。

```powershell
# 默认安装目录正确时无需设置。
$env:ANYSEARCH_SKILL_DIR = 'C:\Users\yxq\.codex\skills\anysearch-skill'
# API Key 可选；不配置也可匿名访问，但额度较低。
# 设置方式：在本机环境变量中配置 ANYSEARCH_API_KEY，或写入 Skill 目录的 .env。
npm.cmd start
```

Key 读取优先级遵循 Skill CLI：Skill 的 `.env` 高于环境变量，随后是匿名访问。搜索词和待提取 URL 会发送至 AnySearch API。服务端不会自动保存服务返回的新 Key，也不会将 CLI stderr 中的凭据回传。搜索失败会作为工具错误交回模型说明，不自动切换其他搜索服务。搜索结果只作为外部数据处理。

每个问题最多4轮工具调用，最后一轮模型总结时关闭工具；整次任务最多65秒。每个 AnySearch CLI 进程最多20秒。每次问题仍不带上一次的历史，搜索与工具上下文只在本次任务内保留。

## 安装手表应用

构建产物：`dist/com.example.redmi.voicedeepseek.debug.1.0.3.rpk`。新包名可与两个参考应用同时保留。

ADB 上传遵循本项目 `AGENTS.md`：先打印包名和 RPK 文件名，上传到 `Download/RedmiWatch/`，使用现有 Launcher DEX 打开安装页，填好包名后停下。由用户手动选择 `Download/RedmiWatch/com.example.redmi.voicedeepseek.rpk` 并上传到手表。共享部署脚本会自动打开文件选择器，不能原样执行完整脚本。

## 使用

1. 保持手机微信登录。先确认手表微信能读取会话，再返回表盘、打开“Orbit AI”；不要结束微信服务。
2. 应用首次打开自动加载接口和读取会话，默认采用首个真实 `conversation_name`。如果失败，进入“设置”点“读取会话”，可“换会话”或输入实际会话标识。昵称不能替代标识；选取会话只是满足录音协议，并非向该联系人发送消息。
3. 点击“开始说话”或“继续提问”，对手表说出问题；8 秒后自动停止并识别，也可点“说完了”提前停止。同一次进入应用期间，每轮问题和回答保留在历史列表中。
4. 识别成功后自动上传完整文字，手表显示“我: …”，再等待 DeepSeek 回传“AI: …”。电脑网页同时显示文字、模型任务和回答送达状态。
5. 保持手表页面前台接收回复。网络失败自动重试同一个消息 ID；点顶部连接状态可立即重试。上一条上传或回答未完成时，录音按钮阻止再次提交。
6. “取消”用于取消当前录音/识别；已提交的问题会继续生成。回答等待超过 75 秒后允许重新录音提问，原任务可能仍在电脑队列中。界面不显示重发控件。

每次问题独立回答，不带历史上下文，不含语音播放。识别文字上限 2000 个 Unicode 字符，超过时显示原文并提示重录，不截断或拆成多次模型请求。回答最多保留 420 个 Unicode 字符、每段最多 120 个字符，在手表上按 13 字一行显示，避免 list-item 不换行导致文字丢失。

## 状态和限制

- 录音、识别、网络与模型状态独立显示，轮询成功不会覆盖“正在识别”或“等待 AI”提示。
- 空识别、错误结果、取消后的迟到回调不会上传；离开前台取消正在进行的录音/识别并停止 HTTP 轮询，返回后继续接收已提交问题的回答。
- 识别最多等待 30 秒；停止或取消未确认时，需先确认取消才能继续录音。微信会话查询 -4 时检查微信服务和连接。
- 单次模型调用最多等待 45 秒，整次任务（含多轮搜索）最多 65 秒。打印工具有 25 秒进程超时（队列验证等待 10 秒），AnySearch CLI 有 20 秒超时。电脑串行处理，最多 8 条排队；模型错误或队列已满会以文字回传，不自动重试模型或打印。
- 回答携带请求 ID 和分段编号，当前问题只在全部分段接收后解锁。电脑重启会清空队列和聊天，手表会提示重发已确认但未完成的问题。
- 同一电脑服务进程内，同一来源和消息 ID 去重；服务重启后不能保证不重复调用模型。聊天、识别和任务保存在内存；电脑服务重启清空服务端内存，手表历史在退出后再次进入时清空。网页仅允许电脑本机访问，LAN 同步需要配对令牌。

## 验证

```powershell
npm.cmd test
npm.cmd run build
```

测试复用参考项目的录音状态机、HTTP 通信和模型错误验证，并通过真实本机 HTTP 服务、模拟 native 回调与模拟模型，覆盖“录音 → 转文字 → 自动上传 → 回答回传”完整链路、长 Unicode 问题、丢 ACK 去重、分段回复、后台暂停、空/取消结果和超长识别拒绝。测试不使用真实 API Key，不产生模型费用。

打印新增测试覆盖 tool 注册和执行、普通回答不调用打印、无效参数拒绝、命令行内容按字面传递、队列验证结果保留，以及 HTTP 重试不重复打印。`npm.cmd test` 使用模拟打印进程，不出纸。另已用真实 DeepSeek 和本机打印脚本的 dry-run 验证明确打印意图、否定打印和未提供打印内容三种情况；dry-run 只验证调用与排版，不代表实体出纸验收。

当前已完成自动化链路验证与 RPK 构建；新组合应用仍需安装到实际手表后验证麦克风、微信服务、网络转发与屏幕显示。两个参考项目的实机记录不等于本应用已完成实机验收。

AnySearch 新增测试覆盖子领域发现和必填参数补齐、跨问题隔离、批量查询、网页提取、参数校验、错误信息脱敏、多轮模型协议、工具次数上限，以及搜索后打印一次。自动化测试使用模拟搜索服务，不访问网络。

另已通过真实 DeepSeek 和 AnySearch 验证“查询代码子领域 → 搜索 Node.js 22 官方发布说明 → 回传短摘要”，并验证 `https://example.com` 的网页提取。当前44项自动化测试全部通过，手表端 `src` 文件哈希保持一致。
