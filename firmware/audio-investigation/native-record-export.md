# 独立 native recorder / system.record 边界核对

日期：2026-10-13。静态只读，未运行设备、录音或修改固件。
目标：vela_ap.bin.raw，SHA-256 1e510ba5d1cfa5ff49e58aeb89ffcc39fe9742ac1331929c314ad69ee21f3174。
地址沿用 startup 已验证映射：code VA=0x0c080000+raw；复制区字符串 VA=0x3bff1cb8+raw。工具为 Capstone 5.0.6，focused decode，不是厂商原始符号表。

## 结论

固件独立 native 录音器实际构造带文件路径的 Capture/Record 请求，输出目录为 `/data/app/recorder/`，格式为 Opus、16000 Hz、mono；不是微信的 Silk 内存数据链。但当前没有恢复出普通自有 RPK 可调用它的 JS 方法入口，也没有证明其私有目录能由普通 RPK 读取。

`system.record` 的这一次引用属于 background feature 校验名单，不能当作已注册 recorder JS 模块。已检查的 AIOTJS 注册表有 `audio` 和 `media`，没有 record/recorder。audio 的实际方法表为播放/属性方法，没有 capture/start recording。这个负结果仅限表与代码范围，不证明不存在其他入口。

## system.record 的实际引用

- 字符串 raw+0x1389c7，VA 0x3c12a67f；唯一精确地址字引用在 raw+0x139294。
- raw+0x139288..0x139294 四个地址分别为 `system.audio`、`system.request`、`system.geolocation`、`system.record`。
- raw+0x56b550 加载这四项的基址 0x3c12af40；raw+0x56b552 LDM 读四项，raw+0x56b554 STM 保存到栈。
- 上文 raw+0x56b47e/0x56b508 正在读取 `background`；raw+0x56b51e..0x56b546 读取 `features` 并检查数组。
- raw+0x56b5dc..0x56b608 遍历 feature 字符串与这四项逐个 strcmp（0x0c704304），匹配跳 raw+0x56b48c。此处未见 record 方法注册、采集调用或 URI 返回。
- 证据文件：thumb-56b500.txt、thumb-56b5dc.txt、thumb-56b460.txt。

## JS audio 注册范围

raw+0x1cd63c..0x1cd808 是连续 20 字节结构的 native module 名称/指针表，覆盖 file、link、sensor、wechat、audio、event、Timer、health、miwear、prompt、media、Battery、network、request、storage、Settings、Bluetooth 等。audio 项 raw+0x1cd68c 指向 finalizer 0x0c5a7159 与 getter 0x0c5a6c67。media 项 raw+0x1cd704 指向 0x0c5b8e6d（仅 push/add/pop 的空 finalizer）。不能仅由 finalizer 断言 media 模块全部能力为空。

实际 audio 方法表 raw+0x12ffd0..0x130040 每项 16 字节：

| 方法 | Thumb 指针（VA） |
|---|---|
| init | 0x0c5acdb1 |
| uninit | 0x0c5acfd1 |
| play | 0x0c5a7881 |
| pause | 0x0c5a7f41 |
| stop | 0x0c5a8061 |
| getplaystate | 0x0c5ad189 |
| setattribute | 0x0c5ad6a1 |
| getattribute | 0x0c5ad3ed |

该表末项下一地址已经进入 event 方法表。raw+0x52cdb0 的 init 读取 `package`，分配 Audio 对象；源名 jse_audio.cpp。字符串群中 `__audio_media_player_*` 与 play/pause/stop 相互印证其播放器实现。在以上 audio 表没有录音方法。raw+0x54d454 加载 `audio` 名，并在 raw+0x54d470 调用注册 helper；这不是 record 注册。

证据文件：thumb-52cdb0.txt、thumb-527158.txt、thumb-54d440.txt。

## 独立 recorder 真正的文件请求

raw+0x421eec..0x42205e 属于 recorder_sync_mode 中初始化分支：

1. raw+0x421f74..0x421fa6 以 `%lld`、`-%02d` 构造时间/次数名称；没有静态固定录音文件名。
2. raw+0x421ffc..0x422026 清零 0x4a0 大小 native request，设置 command 0x26、源/过滤名 `Capture`/`Record`、回调 Thumb 指针 0x0c4a3be5。
3. raw+0x422028..0x422034 用 `%s%s` 将 `/data/app/recorder/` 与动态名称写到 request+0x15。
4. raw+0x422038..0x422040 将 `format=opus:sample_rate=16000:ch_layout=mono` 写到 request+0x55。
5. raw+0x422054..0x422056 将 command 0x26 交给 native 控制函数 0x0c49e8d0。
6. raw+0x42208a..0x42208c 开始分支传 0x22 复用控制函数；是否完全等价 begin 需结合控制函数进一步解码。

这已经是带输出文件 URL 的真实 native 构造路径，优于仅从目录字符串推断。还未追到底层文件写入/关闭，不声称实机已生成该文件。

native UI 事件回调 raw+0x423d70（日志 eventbus_cb）按 event+8 的 code 7..10 分派；raw+0x423daa..0x423e3c 为 recorder_opt_start，raw+0x423e5e..0x423ed6 pause，raw+0x423ed8 后 stop。读取 native UI/global 状态，调用 LVGL 风格对象方法，不能直接作为 JS API。

证据文件：thumb-421ee0.txt、thumb-423d70.txt、thumb-423e40.txt。

## 容易误判的另一目录命中

原先给出的 `/data/app/recorder` 无尾斜线字符串 raw+0x17601e，只被 literal raw+0x647efc 引用。真正代码 raw+0x647e70 的源日志名为 `mic_rm_file` / `check_tool`：open directory、遍历、跳过 retest 后 remove 路径。它是检查工具的删除文件操作，不是录音接口或导出接口。没有执行它。

证据文件：thumb-647e70.txt。

## 当前未解边界

- 没有已确认可由普通 RPK 调用的独立 recorder JS 方法；没有参数/返回值协议可实现。
- 独立 native app/event bus 是否能由普通 RPK 经 system.app 等入口安全、公开调用，未建立路径。
- 目录权限与文件传输到手机的可用协议未验证。
- 没有恢复全部模块构造器、全部动态注册路径，因此不能绝对断言 system.record 不存在。
- 不应猜 loadLibrary("RECORDER")、猜 stop("save") 或伪造包名来实现。

用户已把当前目标调整为确认实际录音能力，主流程继续使用已实机可加载的 WeChat bridge 并验证 trans 结果；本文件保留独立文件路线的边界，未改应用。
