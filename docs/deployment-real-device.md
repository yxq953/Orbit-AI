# Deploying to Real Device - Technical Deep Dive

The international Mi Fitness app (`com.xiaomi.wearable`) has a hidden debug page for installing third-party Quick Apps. It's not accessible via any menu - we launch it programmatically.

## The Hidden Debug Page

The class `com.xiaomi.xms.wearable.ui.debug.ThirdAppDebugFragment` provides a simple UI with four buttons:
1. "click to input package name"
2. "install third app"
3. "uninstall third app"
4. "go third app list"

## How We Launch It

A small Java file (`LaunchFragment.java`) is compiled to a `.dex` and executed via `app_process` on the phone:

```bash
APK_PATH=$(adb shell pm path com.xiaomi.wearable | head -1 | sed 's/package://')
adb shell "CLASSPATH=/data/local/tmp/launch.dex app_process / LaunchFragment $APK_PATH"
```

The Java code:
1. Creates a `PathClassLoader` that loads the Mi Fitness APK
2. Builds a `FragmentParams` object pointing to `ThirdAppDebugFragment`
3. Creates an `Intent` for `CommonBaseActivity` with the fragment params
4. Calls `ActivityManager.getService().startActivity()` with `"com.android.shell"` as the calling package

### Why app_process?

- We can't use a regular Android app because `FragmentParams` is a Mi Fitness internal Parcelable class - it can't be constructed from outside the app's ClassLoader
- `app_process` runs as shell user (uid=2000) and can load any APK's classes via `PathClassLoader`
- We use `"com.android.shell"` as the calling package to avoid permission errors

## UI Automation

After launching the debug page, ADB `input` commands automate the UI:

### Package Name Entry

The Samsung keyboard auto-adds a space after the first period in a package name. The script handles this:

```bash
adb shell input text "com"        # type first part
adb shell input keyevent 56       # dot key
adb shell input keyevent 67       # delete the auto-space
adb shell input text "example.app" # type the rest
```

### Button Coordinates

Rather than hardcoding coordinates (which vary by phone), the script uses `uiautomator dump` to find elements dynamically:

```bash
adb shell uiautomator dump /sdcard/ui_tmp.xml
# Then parse XML to find button bounds
```

### File Picker

After tapping "install third app", the system file picker opens in the `Xiaomi-band` folder showing the RPK file. The user taps it to install - this is the one manual step.

## Key Classes (for reference)

| Class | Purpose |
|-------|---------|
| `ThirdAppDebugFragment` | The hidden debug install UI |
| `CommonBaseActivity` | Hosts fragments in Mi Fitness |
| `FragmentParams` / `FragmentParams$b` | Parcelable for fragment navigation |

## Troubleshooting

- **ADB unauthorized**: Replug USB cable, tap "Allow" on phone. If no popup: Settings > Developer Options > Revoke USB debugging authorizations, then replug.
- **App not updating on band**: Bump `versionCode` in manifest.json. May need to uninstall first.
- **"not found" error**: Make sure Mi Fitness (`com.xiaomi.wearable`) is installed, not the Chinese version (`com.xiaomi.wearable.chn`).
