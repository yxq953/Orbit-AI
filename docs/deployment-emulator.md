# Deploying to the Emulator

The Vela emulator runs NuttX RTOS with ADB support. No IDE interaction is needed after the initial emulator startup.

## Filesystem Layout

| Path | Type | Contents |
|------|------|----------|
| `/data/quickapp/app/` | fatfs (writable) | User-installed Quick Apps |
| `/quickapp/` | romfs (read-only) | Pre-installed Quick Apps |
| `/bin/` | romfs | System binaries including `vapp`, `pm`, `am` |

## Deployment Flow

```bash
# 1. Push RPK
adb -s emulator-5554 push app.rpk /data/quickapp/app/com.example.app.rpk

# 2. Extract
adb -s emulator-5554 shell unzip -o /data/quickapp/app/com.example.app.rpk -d /data/quickapp/app/com.example.app

# 3. Start (auto-kills previous instance)
adb -s emulator-5554 shell "vapp app/com.example.app &"
```

## Key Binaries

| Binary | Purpose |
|--------|---------|
| `vapp` | Quick App JS runtime. Runs an extracted app. |
| `pm install <rpk>` | Async RPK installer (needs Quick App runtime active) |
| `am start <pkg>` | Start app (needs Quick App runtime active) |
| `am stop <pkg>` | Stop app |

`vapp` is the most reliable way to run apps. It doesn't need the Quick App runtime service - it IS the runtime.

## gRPC Control

The emulator exposes a gRPC server (port 8554) for programmatic control. Proto files are in the AIoT IDE extension:

```
~/.aiot-ide/extensions/vela.aiot-emulator-*/proto/emulator_controller.proto
```

### Services

- **EmulatorController**: Screenshots, input events, sensor simulation
- **UiController**: Extended controls panel
- **Rtc**: WebRTC streaming

### Mouse vs Touch

The Vela Quick App framework in the emulator responds to **mouse events** (sendMouse) but not always **touch events** (sendTouch) for `onclick` handlers. Always use `click` (mouse) for UI interaction:

```bash
node emulator-grpc.js click 168 240  # Works for onclick
node emulator-grpc.js tap 168 240    # May not trigger onclick
```

## Coordinate System

The emulator renders at the device's native resolution, but `designWidth` in the manifest means CSS units map differently. For example, the Mi Band 8 Pro emulator is 336x480 pixels with `designWidth: 192`:

```
scale = screen_width / designWidth    (e.g., 336 / 192 = 1.75)
screen_x = css_x * scale
```

For gRPC commands, use screen pixel coordinates. Check your device's resolution in the emulator settings.
