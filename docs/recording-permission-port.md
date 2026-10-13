# 录音授权机制移植到当前项目

## 当前结论

当前项目是 Vela JS Quick App，录音调用位于 `examples/watch-voice-qwen/src/pages/index/index.ux`，应用包名为 `com.example.redmi.watchvoice`。该应用已经在 manifest 的 features 中声明 `system.record`，并在用户点击后尝试加载 `@system.record`。

`examples/watch-voice-qwen/README.md` 记录了 2026-10-11 Redmi Watch 5 实机“录音接口不可用”的结果。本文没有重新进行设备测试，也没有验证其他固件版本。

相邻 `app` 目录中的授权机制属于设备运行时的 C/C++ 层，不能复制到 JS 或 manifest 后就获得系统权限。要移植这套机制，需要能编译、部署目标设备的快应用运行时，并接入设备实际的权限服务和录音服务。当前仓库没有这些服务的完整实现和部署条件。

## 可以复用的代码

以下路径相对于工作区 `D:/workspace01/xiaomicli`：

| 来源 | 用途 |
| --- | --- |
| `app/frameworks_runtimes_feature-dev/include/feature_permission.h` | 录音权限枚举、权限位图；`HAPJS_PERMISSION_RECORD = 2`，名称 `hapjs.permission.RECORD` |
| `app/frameworks_runtimes_feature-dev/src/permissions_manager.cpp` | 保存待授权调用，授权后继续执行，拒绝后通知 Promise 或 fail 回调 |
| `app/frameworks_runtimes_feature-dev/src/feature_instance.cpp` | 将权限请求交给运行时任务队列，实例分离时清理请求 |
| `app/frameworks_runtimes_quickapp-dev/shell/common/permission/permission_manager_impl.cpp` | 注册 Feature 权限回调，将 `hapjs.permission.*` 映射成 `vela.permission.*`，处理授权结果 |
| `app/frameworks_runtimes_quickapp-dev/shell/common/permission/permission_manager.h` | `Client` 系统权限服务适配接口、`setClient()` 注册入口 |

这些文件依赖整个 Feature/Quick App 框架及其任务队列，不能仅复制一个头文件形成独立授权库。

## 目标运行时的接入步骤

1. 在实际录音入口的 JIDL 上声明 `[permissions="hapjs.permission.RECORD"]`，用匹配版本的生成器重新生成 native glue。现有 Rust 示例的 `blueos.permission.RECORD` 与这份框架及生成器的权限表不一致，移植时需要统一。
2. 在应用运行时初始化阶段启用权限管理器，并注册 Feature 权限回调。源码通过 `CONFIG_QUICKAPP_PERMISSION_MANAGER` 控制 ShellApp 中相关初始化。
3. 实现 `shell::PermissionManager::Client`，调用目标系统的权限查询/用户确认服务，并通过 `setClient()` 注册。`requirePermission()` 接收包名、权限 ID、系统权限名、API 名和结果回调。
4. 系统服务确认当前应用身份与声明，查询已保存的授权状态；需要用户选择时展示系统授权界面。只在系统确认授权后返回 `PermissionManager::GRANTED`，拒绝或错误返回对应结果。不要将本地变量或应用自行返回的 GRANTED 当成系统授权。
5. 由已有 `doPermissionResult()` 调用 `FeatureGrantPermissions()` 或 `FeatureRejectPermissions()`。授权成功后才进入真实录音实现。
6. 补齐录音服务调用、音频焦点、文件输出及停止/销毁时的资源释放。现有 `AudioRecorderImpl::start()` 仅等待 100ms 后返回模拟字符串，没有麦克风采集。
7. 让目标设备运行时注册并向该应用开放录音模块，再验证当前 RPK。已有页面调用的是 `system.record.start({ ... })`；Rust 示例则是 `system.media.audio.createAudioRecorder().start(...)`，两者接口形态不同，不能直接替换。

授权调用顺序：

```text
用户点击录音
  → JS 调用已注册的录音模块
  → 生成的 native glue 发起 FeatureRequestPermissions
  → Shell 权限管理器转换为 vela.permission.RECORD
  → Client 调用设备系统权限服务
  → 用户授权/已有授权状态
  → FeatureGrantPermissions 继续执行录音，或 FeatureRejectPermissions 返回失败
  → 实际录音服务输出文件 URI/音频数据
```

## 移植前需修正的行为

- 没有 Feature 权限回调时，`FeatureInstance::requestPermissions()` 返回 false；生成的 glue 在请求函数返回 false 后直接执行 native 方法。若目标入口必须鉴权，需要把“权限组件缺失”处理为明确失败，避免误执行。
- Shell 的 `requirePermission()` 在没有 Client 时返回 false，但没有调用 `result_cb`；`verifyAuth()` 没有处理这个返回值，待授权调用可能一直不结束。目标集成应在这个分支明确拒绝/返回错误并清理请求。
- Shell 的权限查询循环在第一个权限后 break。当前录音单权限可以沿用，但不能宣称这个实现已经支持多个权限全部通过后再执行。

## 验证标准

在有目标系统构建与设备条件后，分别验证：首次授权、用户拒绝、已授权、设置中撤销授权、缺少权限 Client、缺少权限回调、缺少录音模块，以及请求过程中退出页面。检查拒绝时没有启动麦克风，请求能结束，退出时释放资源。

成功回调必须返回真实录音文件/数据。当前语音服务要求 16kHz、单声道、16bit PCM WAV；还需要验证录音内容和上传格式，不能仅凭授权返回成功判断移植完成。

## 目前可交付范围

这份文档定位了可复用的授权代码和目标运行时接入步骤。当前 JS 项目没有新增模拟授权接口，也没有宣称已解锁 Redmi Watch 5 录音。继续实现设备内录音需要目标运行时/系统工程、可用的系统权限服务 API、媒体服务 API，以及对应的部署方式。
