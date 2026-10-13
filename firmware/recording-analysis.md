# Redmi Watch 5 固件录音链路分析

分析对象：`miwear.watch.o65_v3.100.105_full_987d7afe.bin`（版本 `v3.100.105`）。

## 结论

Redmi Watch 5 的系统自身具备完整麦克风录音能力，但该能力没有向普通第三方 Quick App 开放。官方 Vela 文档的支持明细把 **REDMI Watch 5** 标为 `system.record` 不支持；实机探测也表现为 `require('@system.record')` 不可用，或录音调用没有返回 URI。

因此，普通 RPK 应用不能通过添加 manifest：

```json
{ "name": "system.record" }
```

来获得录音权限。`vela_ap.bin.raw` 中出现 `system.record` 只证明运行时编译了通用模块/注册表，不证明本产品启用了该模块。

## 系统录音链路

静态固件字符串给出的底层音频图为：

```text
/dev/audio/pcm0c  麦克风采集
        |
SelMic -> SelCap -> Capture(amoviesink_async)
        |
媒体 session / recorder -> WAV 或其他编码文件
```

同时存在：

- `/dev/audio/pcm1c`：蓝牙 SCO 输入
- `/dev/audio/pcm2p`：扬声器播放
- `/dev/audio/pcm1p`：蓝牙 SCO 输出
- `MicSelDomain`、`MicFadeoutDomain`、`netTalk_aec`、`hfp_aec`：麦克风选择、淡出和回声消除场景
- `media_session_open`、`media_session_register`、`media_recorder_open`、`media_recorder_prepare`、`mediatool_cmd_uv_recorder_open_exec`、`mediatool_uv_recorder_write_cb` 等媒体控制符号
- `format=wav:sample_rate=48000:ch_layout=mono`：系统录音测试配置

在 `vela_audio.bin.raw` 中还可以看到 NuttX `nxrecorder` 的命令字符串：`Record a pcm raw file`、`Record a media file`、`Pause record`、`Resume record`、`Stop record`，以及 `/dev/audio/%s` 设备访问模板。这说明采集、编码和媒体文件写入都位于固件底层，而不是 Quick App 自己实现的 JavaScript 功能。

系统录音应用的证据包括：

- 包名：`com.xiaomi.miwear.recorder`
- 资源目录：`S:/system/image/recorder/`
- 数据目录：`/data/app/recorder`
- 函数/符号：`init_recorder`、`recorder_opt_start`、`recorder_opt_stop`、`recorder_opt_pause`、`new_a_record`、`write_record`、`read_record`、`del_a_record_file`
- 状态文件：`/data/app/recorder/flag.bin`、`/data/app/recorder/flagtmp.bin`

可还原的系统调用关系是：

```text
系统录音 UI
  -> 内部 recorder/media session
  -> Capture 音频图
  -> /dev/audio/pcm0c
  -> 编码器/媒体 sink
  -> /data/app/recorder 下的录音文件
```

## Quick App 与微信的差异

在 `vela_ap.bin.raw` 的运行时字符串表附近可以看到 `system.audio`、`system.geolocation`、`system.record`，并能看到 `permissions`、`permission denied`、`minAPILevel`、`minPlatformVersion` 等运行时校验字符串。这个结果只能证明运行时包含通用能力框架；它不能绕过型号能力表、应用权限和进程隔离。

公开 `system.audio` 只提供播放控制，不是麦克风采集接口。公开 `system.record` 文档虽然定义了 `start`/`stop` 和 WAV/PCM/Opus 参数，但支持明细明确列出：

文档地址：<https://iot.mi.com/vela/quickapp/zh/features/system/record.html>

```text
REDMI Watch 5 -> 不支持
Xiaomi Watch S5 -> 支持
```

微信使用的是另一条私有链路。微信 RPK manifest 没有 `system.record` 和 `system.audio`，JS 通过：

```js
system.app.loadLibrary("WECHAT_APP")
```

再调用 Adam bridge 的 `startRecord`、`stopRecord`、`recordNoop`。固件字符串对应的私有服务是 `WatchAudioManager`，配置为：

```text
format=silk:sample_rate=16000:ch_layout=mono:b=23900
```

该服务还处理 60 秒自动停止、音频焦点丢失、Silk 分片通知和微信发送状态。因此它是微信专属 native bridge/服务身份，不能作为普通 RPK 的公共录音 API。

## 对第三方软件的实际结论

以下做法在普通 Redmi Watch 5 RPK 中没有可行证据：

1. 仅在 manifest 增加 `system.record`。
2. 调用未公开的 `startRecord` 或猜测 `WECHAT_APP` 接口。
3. 直接打开 `/dev/audio/pcm0c`。Quick App 没有设备节点访问权限，`system.file` 也只负责应用文件 URI。
4. 用 `system.audio` 代替录音。该模块是播放模块。

可行路径按风险排序：

1. **推荐**：手表 Quick App 只负责按钮、状态和传输；手机端原生应用申请 `RECORD_AUDIO`，录音后通过蓝牙/局域网/互联网桥接到现有服务。
2. **需要厂商或系统签名**：把应用做成系统组件，调用内部 recorder/media service，并获得对应签名、权限和前台音频焦点身份。
3. **固件级实验**：修改 Quick App runtime 的产品能力 gate、权限映射和媒体 IPC 暴露。必须同时处理签名、启动服务、权限隔离和 OTA 校验，不能只改 RPK manifest。

## REA 状态

已尝试使用 REA：

- 对完整固件和 `vela_ap.bin.raw` 调用 `open_binary`：均被判定为不支持的二进制格式。
- 调用 `extract_firmware`：当前 Windows 环境缺少 REA 所需的 Linux/`REA_UNBLOB_COMMAND`，返回 `capability_unavailable`。

所以本文的固件结论来自本地提取后的静态字符串、RPK manifest、JS 代码和实机 Quick App 探测，不声称 REA 已成功反汇编该固件。要继续恢复具体权限 gate，需要在 Linux 上用 REA/Unblob 提取并识别目标 CPU、加载地址和代码段，然后对 Quick App runtime 做机器码级分析。

## 相关文件

- `vela_ap.bin.raw`
- `vela_audio.bin.raw`
- `recorder.res.raw`
- `wechat_js/app.js`
- `examples/watch-voice-qwen/README.md`
- `examples/watch-voice-qwen/src/pages/index/index.ux`

