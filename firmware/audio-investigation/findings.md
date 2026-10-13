# 预装 RPK → native 录音链路核对

日期：2026-10-13。范围：用户指定 firmware 目录中的 7 个 RPK、vela_ap.bin.raw、vela_audio.bin.raw、recorder.res.raw、voice.res.raw；静态分析，没有执行录音、刷机或修改固件。

## 结论

找到真实录音调用：微信使用 `system.app.loadLibrary("WECHAT_APP")` 返回的对象，经 Adam bridge 的 `js_invoke_function` 调用 `startRecord` / `stopRecord`。这不是在 manifest 中申请 `system.record` 的路径。

AP 镜像内存在匹配的 `jse_wechat.cpp`、`adam_js_native_bridge.cpp`、`watch_audio_manager.cpp` 字符串，另有 Silk 编码配置和麦克风采集音频图。JS 到 bridge 的调用关系由代码直接确认；bridge 到音频管理器/媒体采集的关系由名称、日志和配置相互印证，尚未用反汇编确认每一跳。

**尚未定位授权 gate，不能据此断言普通 RPK 能调用，也不能断言一定需要系统签名。** 已找到接口与底层采集能力，但没有获得/验证第三方录音权限。

## 1. 七个 RPK 的结果

| RPK | manifest 声明 system.audio | manifest 声明 system.record | 录音相关结论 |
|---|---|---|---|
| com.baidu.BaiduMap 3.7 | 是 | 否 | 发现播放模块；Record 等命中需排除 JS 辅助代码，不是已确认录音调用 |
| com.bcz.watch 1.0.11 | 是 | 否 | 未找到与微信相同的 native 录音入口 |
| com.netease.vela 1.0.49 | 是 | 否 | 未找到与微信相同的 native 录音入口 |
| com.tencent.wechatrtos 1.1.0 | 否 | 否 | 找到 loadLibrary + Adam 录音调用 |
| com.vela.calculator 1.0.1 | 否 | 否 | 未找到录音入口 |
| com.xiaomi.smarthome.watch 1.0.3 | 否 | 否 | DEVICE_INFO 权限声明，与录音无关 |
| com.ximalaya.wearsmart 7.4.0 | 是 | 否 | 未找到与微信相同的 native 录音入口 |

搜索覆盖 ZIP 中的 `.js/.json/.ux/.txt` 内容和成员名称，没有把二进制模板/图片解码成代码。system.audio 声明本身不能证明录音。全部 manifest 和成员清单在 `rpk-inventory.json`，关键字上下文在 `rpk-hits.json`。

微信 RPK SHA-256：`12c87bacc4b669b15341e96b15724f12bc247684c1f6e06074a33cb93f3fb552`。

REA 确认该 RPK 是 ZIP，inventory Evidence：`ev_0243a80965d2bd868aaccf02479fb500902d0c8db650d6fc2affa2171b22f6e8`；inspect Evidence：`ev_6a52424d5ba7bd2704ab86c118ecc2ff8d384354a4f540e50aab26396cfb842d`。ZIP inventory 不覆盖签名区/中央目录外字节，因此没有据此验证签名身份。

## 2. JS 的实际协议

下列内容依据解压原始代码整理，变量名规范化；不是可直接使用的公共 API 示例。

```js
// app.js 字符偏移 2248: loadLibrary
native = app.loadLibrary("WECHAT_APP");
native.js_regist_task_callback(({ task_id, resp_body }) => {
  // 分派到 task_id 对应回调；resp_body 在原实现中解析成 JSON。
});
native.js_regist_event_callback(eventCallback);

// pages/message/index.js 字符偏移 65980: invokeFunction
native.js_invoke_function({
  task_id: taskId,
  func_name: functionName,
  request_body: typeof body === "object" ? JSON.stringify(body) : body
});
```

`pages/message/index.js` 实际录音行为：

- `startRecord` 传入 **conversation_name 字符串**，不是 `{sampleRate: ...}` 对象。UI 调用位于字符偏移约 14386，包装方法位于 76240 附近。
- 每 3 秒调用 `recordNoop`，body 为 `{}`；无回调时 task_id 为 0。
- 60 秒后 UI 调用停止；native 日志也有 60 秒自动停止。
- `stopRecord` 的 body 是字符串 `"cancel"`、`"send"` 或 `"trans"`。`send` 是发送微信语音，`trans` 可返回 `text`。**没有在该代码路径看到通用 WAV/PCM URI 返回。**
- 开始错误：RepeatStart=1、TimeOut=3、LostFocus=4、Channel=5、Logic=6。
- 停止错误：Success=0、NotRecording=2、Channel=5、Logic=6。

提取源文件在 `wechat/app.js`、`wechat/pages/message/index.js`。偏移是 Unicode 字符索引，不是压缩包偏移；原文件含历史编码混杂的中文，接口名/参数 ASCII 不受影响。

## 3. native 证据位置

以下全部为 **原始文件偏移**，不是虚拟地址、函数入口地址或已验证符号表项。函数名可能来自日志/debug 字符串。

| 文件 | 偏移 | 原始证据 |
|---|---|---|
| vela_ap.bin.raw | 0x121e71 | wechat_init |
| vela_ap.bin.raw | 0x121edf | jse_wechat.cpp:51 |
| vela_ap.bin.raw | 0x121f94 | wechat_js_invoke_function |
| vela_ap.bin.raw | 0x12200e | jse_wechat.cpp:81 |
| vela_ap.bin.raw | 0x122041 / 0x122049 / 0x122053 | task_id / func_name / request_body |
| vela_ap.bin.raw | 0x1adf54 | .../jsbridge_comm/adam_js_native_bridge.cpp |
| vela_ap.bin.raw | 0x1ae114 / 0x1ae12c / 0x1ae140 | start record taskid:%d / Receive recordNoop / stop record taskid:%d |
| vela_ap.bin.raw | 0x1ac564 | .../src/watch_audio_manager.cpp |
| vela_ap.bin.raw | 0x1ac698 / 0x1ac6ac / 0x1ac5dc | WatchAudioManager / startRecord / stopRecord |
| vela_ap.bin.raw | 0x1ac628 | Is recording and it is 60s timeout need auto stop |
| vela_ap.bin.raw | 0x1ac800 | lost record focus event callback to js:%d |
| vela_ap.bin.raw | 0xf2c4c | format=silk:sample_rate=16000:ch_layout=mono:b=23900 |
| vela_ap.bin.raw | 0x15069e | media_recorder_with_focus |
| vela_ap.bin.raw | 0x37c18 | adevsrc@pcm0c=format=nuttx:devname=/dev/audio/pcm0c[pcm0c], |
| vela_ap.bin.raw | 0x37c54 / 0x37c8f / 0x37cc7 | SelMic → SelCap → amoviesink_async@Capture |
| vela_ap.bin.raw | 0xbe220 / 0xbdeef / 0xbe056 | recorder_opt_start / recorder_opt_stop / recorder_opt_pause |
| vela_ap.bin.raw | 0x1389c7 | system.record |
| vela_audio.bin.raw | 0x1cd1e4 / 0x1cdb58 | nxrecorder / /dev/audio/%s |
| vela_audio.bin.raw | 0x1cdc88 / 0x1cdca0 | Record a pcm raw file / Record a media file |
| vela_audio.bin.raw | 0x206074 | /dev/audio/pcm0c 的音频图配置 |

采集链概念关系：麦克风 pcm0c → SelMic → SelCap → Capture → media recorder；微信在上层使用 Adam/WatchAudioManager 管理录音、焦点和 Silk 数据。这是配置和静态字符串支持的模型，未通过实机追踪确认。

recorder.res.raw 和 voice.res.raw 的前四字节为 `EGMI`；本轮没有匹配的 ASCII 录音/授权字符串。不能把资源文件当成 native executable，也不能用该负结果证明系统没有录音能力。

## 4. 如何判断能否给自己的 RPK 使用

当前关键问题是 **loadLibrary 的授权与分派**，其次是微信服务的初始化和录音结果导出，而非猜一个 manifest 权限名。

1. 识别 raw 镜像的加载地址/段布局，恢复 `system.app.loadLibrary` 从 WECHAT_APP 到 `wechat_init` 的分派；检查是否比较包名、证书或 capability。AP raw 中本轮未发现 WECHAT_APP/loadLibrary 的 ASCII 字面量，说明不能只靠名字搜索完成。
2. 沿 `wechat_js_invoke_function` 到 `adam_js_native_bridge` 的交叉引用，核对初始化、前台状态、登录/channel 条件。Channel/Logic 错误以及 conversation_name 参数显示这不是独立文件录音接口。
3. 若自有 RPK 要做设备实验，先仅检查 loadLibrary 是否存在、返回对象及桥接方法；不要把微信的 `send` 操作当作录音测试。返回对象成功也不等于 recorder 已授权。随后才验证取消式录音及数据是否能独立导出。
4. 如果证实有签名/系统身份检查，则需要厂商授权或系统集成；如果只是桥接加载而无该检查，还要验证服务条件及音频导出路径。当前没有确定哪种情况成立。

本轮发现的 `permission denied` 在 0x124aa8，周边主要是文件/事件/crypto 相关文本，不能将它直接归因于录音 gate。manifest 签名校验日志也不能直接证明 WECHAT_APP 加载必须系统签名。

## 5. 限制与复现

REA 对 `vela_ap.bin.raw` 返回 `target_unavailable: unsupported binary format`，因此没有得到反汇编、调用 xref 或 gate 伪代码。未安装 NPM 依赖，也未更改 REA 配置。native-evidence.json 包含各 raw 的 SHA-256、头部、大小和完整命中偏移。

后续已验证：AP/audio raw 分别与 full OTA 的 ZIP/deflate 成员逐字节一致，CRC 和解压长度通过。详见第 6 节。压缩成员内的 raw 偏移不能直接加到 OTA 偏移上。rootfs.squashfs 完整匹配 full OTA 偏移 99560044。

复现命令（工作目录为仓库根目录）：

```powershell
python xiaomi-band-development/firmware/audio_probe.py
```

脚本只读输入，向 audio-investigation 写分析数据/微信文本；使用 Python 标准库。已有 recording-analysis.md 中“微信一定需要系统签名/专属身份”等授权推断应以本报告的未知状态为准。


## 6. 继续调查：来源、段映射与机器码（2026-10-13）

已按用户授权在 `D:/Application/Miniconda3/python.exe` 环境安装并导入 `capstone==5.0.6`；没有安装 NPM 包。已有 Keil fromelf 可辅助反汇编，当前不必安装 Ghidra/JDK。

### 来源校验

`audio_layout_probe.py` 用标准库解析 OTA 内局部 ZIP 头并解压 deflate：

| 成员 | OTA local header / payload 偏移（十进制） | 解压大小 | SHA-256 |
|---|---|---|---|
| vela_ap.bin | 5039571 / 5039640 | 7821144 | 1e510ba5d1cfa5ff49e58aeb89ffcc39fe9742ac1331929c314ad69ee21f3174 |
| vela_audio.bin | 891963 / 892035 | 3035400 | d41a0e0cdbe5f623b6e43400ac24f309ac58b600ab74177e60421014ae65b067 |

两个成员均 CRC 正确、长度正确，并与现有 raw 完全相同；结果保存在 `layout-evidence.json`。

### 地址映射

AP 尾部原始构建配置写明 `CHIP=best1502x`、`KERNEL=NUTTX`、`FLASH_BASE=0x2C000000`、`OTA_CODE_OFFSET=0x80000`。启动代码 raw+0x10 的 BX 目标为 0x0c080015；按 Thumb 解码可恢复 MSP/MSPLIM 初始化和有效分支，支持代码映射 `VA = 0x0c080000 + raw_offset`。这不是原始 ELF 的符号信息，而是 startup/方法表共同支持的映射。

启动函数 raw+0xac8（入口调用链 0x10→0xb24→0xac8）明确把 `[0x2c08e348, 0x2c254f28)` 复制到 `0x3c000000`，即 raw `[0xe348, 0x1d4f28)`。因此这一区域字符串/方法表地址为 `0x3c000000 + raw_offset - 0xe348`。不能把所有 raw 都统一套用代码基址。

`audio_make_elf.py` 生成的是带 `$t` mapping symbol 的**分析用派生 ELF**，不是从厂商镜像恢复的 ELF；其 literal pool 仍被线性反汇编显示为指令，必须按 PC-literal 引用区分代码和数据。`audio_thumb_probe.py` 则保存小范围 Capstone 反汇编，并对实际 PC literal 加上原始字符串注释；遇到不可解码数据会停止，未进行完整控制流恢复。

### 已验证的机器码链

原生注册表 raw+0x12f6a0，每项 16 字节，名字/元数据/Thumb 函数指针对应：

| 注册方法 | 代码 VA（清除 Thumb bit） | raw 代码偏移 |
|---|---|---|
| init（日志 wechat_init） | 0x0c5a9558 | 0x529558 |
| uninit | 0x0c5a9600 | 0x529600 |
| js_invoke_function | 0x0c5a96a4 | 0x5296a4 |
| js_regist_task_callback / js_regist_event_callback | 0x0c5a9b5c | 0x529b5c |
| js_unregist_task_callback / js_unregist_event_callback | 0x0c5a9c2c | 0x529c2c |

模块初始化代码 raw+0x54da00 引用这张表，raw+0x54da16 加载名字 `wechat`，然后调用注册函数。该固件内存在 AIOTJS 的 `wechat` 模块注册，**还不能将其直接等同于 RPK 的 WECHAT_APP loadLibrary 分派**。

进一步的直接分支证据：

1. raw+0x5296a4 `wechat_js_invoke_function` 检查对象/参数类型，提取 `task_id`、`func_name`、`request_body`；raw+0x529776 调用 `0x0c78e51c`。
2. raw+0x70e51c 对应 Adam bridge 的 `js_invoke_function`，由原始 source-path literal 支持；raw+0x70e55c 调用 `0x0c78bea4`，前置检查为桥接实例非空。
3. raw+0x70bea4 是较大的字符串分派函数。raw+0x70c31a 引用 `startRecord`，比较相等后 raw+0x70c326 跳到 raw+0x70ca16；这里保存传入 request 字符串与 task id 并构造队列任务。
4. 任务保存 `0x0c77e291`（Thumb 指针）于 raw+0x70ca98/0x70ca9e；任务投递调用位于 raw+0x70cad2。目标 `0x0c77e290` 的原始 literal 明确为 `startRecord` 和 `watch_audio_manager.cpp`，将之前字符串线索落到了机器码函数。
5. 该 startRecord raw+0x6fe2b6 检查对象状态字节 `[this+0x14]`，随后设置状态/时间戳、保存 task 和会话字符串、安排异步工作；raw+0x6fe378 通过成员对象 vtable+0x24 间接调用。实际 recorder/focus 入口还需要恢复该成员的构造和 vtable，不能给这个间接调用任意命名。

在**以上已阅读函数**中，没有发现包名/证书比较；已见检查是实例、参数和状态检查。这不证明上游加载无授权限制，也不证明间接调用下游无检查。`verifyAuth` 则存在另一张注册项（raw+0x12ffc0，函数指针 0x0c5ba885），当前未建立它与微信录音的调用关系。

### 当前答案与剩余问题

- 预装 RPK 的入口、参数、原生桥接分派、WatchAudioManager.startRecord：已找到，并用机器码进一步核对。
- native recorder、pcm0c 的能力和配置：已找到静态证据；尚未恢复微信成员对象到 media recorder 的完整调用链。
- 普通 RPK 能否获得底层录音权限：**未解决**。缺的是 `system.app.loadLibrary` 上游授权/分派和实机加载结果；不能凭 `system.record` 字符串或本轮未见签名比较断言可用。
- 原始 PCM/WAV 导出：**未找到**。微信链目前仍是会话/Silk/发送或转文字，不能当作通用文件录音接口。

后续最有价值的验证是用自有 RPK 只做 WECHAT_APP 加载与方法枚举（不启动/发送录音），保存错误码和返回结构；静态分析则继续恢复上述 vtable+0x24 和上游库加载。当前无实机运行证据，没有修改固件、安装 RPK 或执行录音。

复现新增分析：

```powershell
D:/Application/Miniconda3/python.exe xiaomi-band-development/firmware/audio_layout_probe.py
D:/Application/Miniconda3/python.exe xiaomi-band-development/firmware/audio_thumb_probe.py 0x5296a4 0x138
D:/Application/Miniconda3/python.exe xiaomi-band-development/firmware/audio_thumb_probe.py 0x70c30e 0x2a
D:/Application/Miniconda3/python.exe xiaomi-band-development/firmware/audio_thumb_probe.py 0x6fe290 0xfa
```


## 7. 实机反馈与会话查询应用更新

用户已安装自有包 com.example.redmi.nativerecorder，并报告“桥接已加载，录音授权待验证”。这说明用户设备上 loadLibrary 和本应用必要回调注册未抛异常；录音调用、麦克风采集、文件导出尚未实机验证。

从预装 pages/message/index.js 的 Adam.startLongPolling 与 ConversationModel.syncConversationsLongpolling 确认协议：startLongpolling({time_interval:2000,req_func:"GetConversationList",req_body:JSON.stringify({size:5}),resp_body:""})；任务回调正文是 JSON，正文含 conversations / error_code / sync_status，列表元素使用 conversation_name。结束请求为 cancelLongpolling({taskid:原始任务id})，无回调请求 task_id=0。

探测应用 v1.1.0 新增单次读取会话和切换选项，12 秒超时，退出前台取消查询；只把真实 conversation_name 填到录音框，不猜昵称，不执行发送/删除/隐藏会话。11 项模拟测试通过，RPK 构建成功；会话查询尚未实机验证。


实机追加反馈：用户退出手表微信后，v1.1 会话查询返回外层 error_code=-4（页面显示“会话查询失败”，不是服务正文 error_code）。预装 JS 中未找到 -4 常量映射；longpolling manager 参数失败机器码使用 -100，因此不能直接将 -4 标为参数错误或录音权限拒绝。微信 onHide 发送 foregroundChanged(background)，onDestroy 调用 Adam.unInit 注销回调；这只能确认生命周期行为，未证明退出必然断开 native 服务。下一步应核对 Adam channel 和物理连接状态并恢复 -4 来源。


## 8. 最新实机反馈、音频输出边界与 v1.2（2026-10-13）

本节更新前文的历史未知状态。用户恢复手机微信连接后，已用自有 RPK 读取 **5 个会话**；8 秒测试显示“取消已确认；未返回录音文件”。后者是 v1.1 明确调用 `stopRecord('cancel')` 的预期结果，不能据此断言录音权限失败，也不能据此断言采到了音频。用户随后将目标调整为：不必导出，优先获得实际录音能力。

### 停止录音确有三种处理

Capstone 在 raw `0x6fe498` 的 WatchAudioManager.stopRecord 显示：`send` 的比较在 `0x6fe66a–0x6fe676`，`trans` 在 `0x6fe68e–0x6fe696`；分别设置对象 `+0x15` 的处理模式 1、2。其余字符串落到 cancel 模式 0；因此猜 `save`/`file` 并不能创建导出路径。状态置 stopping，再经成员 vtable `+0x28` 停止。

### 麦克风数据在 native 流内处理

- raw `0x4b4ee0` 的 OnStartRecordEvent 构造 Capture/Record 原生媒体请求，回调为 Thumb `0x0c52f0ed`，采集格式 `format=silk:sample_rate=16000:ch_layout=mono:b=23900`；本段未设置输出文件名。
- raw `0x4af0ec` recorder_cb 在开始/数据事件分别调用 `0x0c52d2e4`，以 256 字节缓冲读取 native 数据；`0x4af030` 的 stop_record 发送 close command 并清零累计长度/缓冲，没有构造文件结果。
- raw `0x4ad2e4` wechat_notify_silk_data 经服务全局 `0x3c278b4c` 的 vtable `+0x20` 转发 buffer/length/state。服务由 `0x4b44f2` 调用 `0x0c77a2f0` 创建；该函数在 raw `0x6fa306–0x6fa314` 将 vtable VA `0x3c19deac` 写入实例首字（表 raw `0x1ac1f4`），其 `+0x20` 确为 Thumb `0x0c7785e1`。实例与此表的绑定已由构造赋值确认。
- raw `0x6f85e0` 将数据封装为异步任务，任务目标 Thumb `0x0c77e771`（raw `0x6fe770`）。该目标将数据累积至 4096 字节或结束时刷新，构造 `conversation_name/voice_id/data/type`，最终附加 duration，经 native 通道调用 `SendVoiceMessage`。
- data 经 `0x0c765518` 包装调用 `0x0c763188`；后者明确调用 Base64 编码（日志 `mbedtls_base64_encode`），不生成 JS 文件 URI。
- 已读取 double 常量：raw `0x6feaf0`=0（开始），`0x6feae8`=1（数据），停止 cancel `0x6feae0`=3、send `0x6febf0`=2、trans `0x6febe8`=4。因此即使最终取消，开始/数据仍进入微信原生通道；不能把探测应用描述为音频完全不传输。

以上是静态控制流与数据流证据，未抓取实机音频/网络包。`SendVoiceMessage` 的中间请求名不等于用户已发送微信聊天消息；停止 mode 决定最终处理，v1.2 只使用 trans 或 cancel，不使用 send。

### 文件相关候选的核对

`decodeSilkFile` 字符串比较 raw `0x70c89a–0x70c8a6` 相等跳到 `0x70d132`，那里只记录 `not supported for this platform!`，然后返回公共出口。`encodePcmData` 的命中 raw `0x70c700` 也跳到同类不支持分支 `0x70d0b0`，不是可调用的采集/转换接口。

预装 JS 的 getFile 需要已有 `file_id`，返回 path；语音播放使用聊天消息的 content 作为 file id。未发现 cancel 回调生成 file id、path 或原始录音数据，因此不能把聊天语音下载接口当作取消录音的直接导出。

固件另有独立 native recorder，构造 Opus/16kHz/mono 文件请求，但没有确认普通 RPK 的 JS 调用入口。详见 `native-record-export.md`。`system.record` 唯一字符串引用实际落在 background.features 校验名单，并非 JS 录音模块注册表；`system.audio` 已读取方法表只有播放相关方法。负结论仅覆盖已读取的表/函数，不证明其他固件或其他系统接口永远不可用。

### 实现及尚待验证项

v1.2 将自动停止从 cancel 改为 trans，显示回调 text，新增“停止并验证”。返回非空文字仍要求用户核对与刚才说话一致；无文字、停止成功、取消成功均不显示已获取通用权限。开始错误仍执行取消，停止/识别超时阻止重启，离开前台取消，旧响应不覆盖新结果。

17 项模拟测试通过，v1.2 RPK 构建成功。仍需用户实机安装后验证手表麦克风采集和转文字；未修改固件、未自动录音、未发送微信消息。微信依赖和音频交给原生服务处理已写入应用说明；这不是独立离线录音接口。

### v1.2 实机验证成功

本次 v1.2 RPK 通过 ADB 上传成功到 `/sdcard/Download/RedmiWatch/com.example.redmi.nativerecorder.rpk`。用户随后报告：**“成功识别我说的话。”** 此结果是用户实机反馈，不是模拟测试或 agent 自动录音观测；支持自有 RPK 通过 WECHAT_APP 调用 native 采音并经 trans 返回实际语音文字。

按用户修订后的“无需导出、能够实际录音”目标，这条依赖微信原生服务的路径已验证可用。它不证明通用 system.record 权限已授权，不证明独立离线录音或音频文件访问已可用。继续使用应保持手机微信与手表连接、应用录音时保持前台；完全退出微信服务时曾出现查询 -4。
