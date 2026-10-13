#!/usr/bin/env bash
#
# deploy.sh - Build and deploy a Vela Quick App RPK to Xiaomi Mi Band 8 Pro
#
# Deploys via the hidden "Third App Support" debug page in Mi Fitness.
# Requires: ADB, Android SDK (javac + d8), phone paired with band.
#
# Usage:
#   ./deploy.sh --project <dir> [options]
#
# Options:
#   --project <dir>       Path to the Vela JS project (required)
#   --serial <serial>     Phone ADB serial (default: auto-detect)
#   --no-build            Skip building, deploy existing RPK
#   --uninstall           Uninstall old version before installing
#   -h, --help            Show this help
#
# Environment variables:
#   PHONE_SERIAL          Phone ADB serial (overridden by --serial)
#   ANDROID_HOME          Android SDK path (default: ~/Library/Android/sdk)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Defaults ---
PHONE_SERIAL="${PHONE_SERIAL:-}"
PROJECT_DIR=""
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
DO_BUILD=true
DO_UNINSTALL=false

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --project)    PROJECT_DIR="$2"; shift 2 ;;
        --serial)     PHONE_SERIAL="$2"; shift 2 ;;
        --no-build)   DO_BUILD=false; shift ;;
        --uninstall)  DO_UNINSTALL=true; shift ;;
        -h|--help)
            sed -n '2,/^$/{ s/^# \?//; p }' "$0"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1 (use --help for usage)"
            exit 1
            ;;
    esac
done

if [ -z "$PROJECT_DIR" ]; then
    echo "ERROR: --project <dir> is required"
    echo "Run with --help for usage"
    exit 1
fi

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

# --- Read package name from manifest.json ---
MANIFEST="$PROJECT_DIR/src/manifest.json"
if [ ! -f "$MANIFEST" ]; then
    echo "ERROR: No manifest.json found at $MANIFEST"
    exit 1
fi
PKG_NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST')).package)")
RPK_FILENAME="$(echo "$PKG_NAME" | tr '.' '_').rpk"

# --- Auto-detect phone serial ---
if [ -z "$PHONE_SERIAL" ]; then
    # Try USB devices first, then wireless
    PHONE_SERIAL=$(adb devices | grep -v emulator | grep -E 'device$' | head -1 | awk '{print $1}')
    if [ -z "$PHONE_SERIAL" ]; then
        echo "ERROR: No phone found via ADB. Connect via USB or wireless debugging."
        echo "  USB: plug in phone with USB debugging enabled"
        echo "  Wireless: adb pair <ip:port> <code>, then adb connect <ip:port>"
        exit 1
    fi
fi
ADB="adb -s ${PHONE_SERIAL}"

# --- Auto-detect Android SDK tools ---
if [ ! -d "$ANDROID_HOME" ]; then
    echo "ERROR: Android SDK not found at $ANDROID_HOME"
    echo "Set ANDROID_HOME to your SDK path"
    exit 1
fi

# Find latest platform
PLATFORM=$(ls -d "$ANDROID_HOME"/platforms/android-* 2>/dev/null | sort -V | tail -1)/android.jar
if [ ! -f "$PLATFORM" ]; then
    echo "ERROR: No Android platform found in $ANDROID_HOME/platforms/"
    exit 1
fi

# Find latest build-tools
BUILD_TOOLS=$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -1)
if [ ! -d "$BUILD_TOOLS" ]; then
    echo "ERROR: No build-tools found in $ANDROID_HOME/build-tools/"
    exit 1
fi

DEVICE_RPK="/sdcard/Xiaomi-band/$RPK_FILENAME"
LAUNCH_DEX="/data/local/tmp/launch.dex"
LAUNCH_JAVA="/tmp/LaunchFragment.java"

# --- Verify prerequisites ---
echo "==> Phone: $PHONE_SERIAL"
echo "==> Package: $PKG_NAME"
if ! $ADB get-state &>/dev/null; then
    echo "ERROR: Device $PHONE_SERIAL not reachable via ADB"
    exit 1
fi

# --- Step 1: Build ---
if [ "$DO_BUILD" = true ]; then
    echo "==> Building..."
    (cd "$PROJECT_DIR" && npm run build 2>&1 | tail -2)
else
    echo "==> Skipping build (--no-build)"
fi

# Find the RPK
RPK_FILE=$(find "$PROJECT_DIR/dist" -name "*.rpk" -type f | sort -r | head -1)
if [ -z "$RPK_FILE" ]; then
    echo "ERROR: No .rpk file found in $PROJECT_DIR/dist/"
    exit 1
fi
echo "==> RPK: $RPK_FILE"

# --- Step 2: Ensure launch.dex exists ---
if ! $ADB shell "test -f $LAUNCH_DEX" 2>/dev/null; then
    echo "==> Building launcher dex..."
    if [ ! -f "$LAUNCH_JAVA" ]; then
        cat > "$LAUNCH_JAVA" << 'JAVA'
import android.content.Intent;
import android.os.Looper;
import android.os.Parcelable;

public class LaunchFragment {
    public static void main(String[] args) {
        try {
            Looper.prepareMainLooper();
            String apkPath = args[0];
            dalvik.system.PathClassLoader cl = new dalvik.system.PathClassLoader(apkPath, ClassLoader.getSystemClassLoader());
            Class<?> builderClass = cl.loadClass("com.xiaomi.fitness.baseui.common.FragmentParams$b");
            Object builder = builderClass.newInstance();
            Class<?> fragmentClass = cl.loadClass("com.xiaomi.xms.wearable.ui.debug.ThirdAppDebugFragment");
            java.lang.reflect.Method setClass = builderClass.getMethod("e", Class.class);
            setClass.invoke(builder, fragmentClass);
            java.lang.reflect.Method build = builderClass.getMethod("b");
            Object fp = build.invoke(builder);
            Intent intent = new Intent();
            intent.setClassName("com.xiaomi.wearable", "com.xiaomi.fitness.baseui.common.CommonBaseActivity");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            intent.putExtra("fragment_param", (Parcelable) fp);
            Class<?> amClass = Class.forName("android.app.ActivityManager");
            java.lang.reflect.Method getService = amClass.getDeclaredMethod("getService");
            getService.setAccessible(true);
            Object am = getService.invoke(null);
            for (java.lang.reflect.Method m : am.getClass().getMethods()) {
                if (m.getName().equals("startActivity") && m.getParameterTypes().length == 10) {
                    Object[] callArgs = new Object[10];
                    Class<?>[] params = m.getParameterTypes();
                    for (int i = 0; i < 10; i++) {
                        if (params[i] == int.class) callArgs[i] = 0;
                        else if (params[i] == Intent.class) callArgs[i] = intent;
                        else if (params[i] == String.class && i == 1) callArgs[i] = "com.android.shell";
                        else callArgs[i] = null;
                    }
                    m.invoke(am, callArgs);
                    System.out.println("SUCCESS");
                    return;
                }
            }
            System.out.println("FAILED: no matching startActivity method");
        } catch (Throwable e) {
            System.err.println("ERROR: " + e);
            e.printStackTrace();
        }
    }
}
JAVA
    fi
    javac -source 8 -target 8 -bootclasspath "$PLATFORM" "$LAUNCH_JAVA" -d /tmp/launch_classes 2>/dev/null
    mkdir -p /tmp/launch_dex
    "$BUILD_TOOLS/d8" /tmp/launch_classes/LaunchFragment.class --output /tmp/launch_dex/ 2>/dev/null
    $ADB push /tmp/launch_dex/classes.dex "$LAUNCH_DEX" 2>/dev/null
    echo "    Launcher dex ready"
fi

# --- Step 3: Push RPK ---
echo "==> Pushing RPK to device..."
$ADB shell mkdir -p /sdcard/Xiaomi-band 2>/dev/null || true
$ADB push "$RPK_FILE" "$DEVICE_RPK"

# --- Step 4: Get APK path and launch debug page ---
APK_PATH=$($ADB shell pm path com.xiaomi.wearable | head -1 | sed 's/package://' | tr -d '\r')
if [ -z "$APK_PATH" ]; then
    echo "ERROR: Mi Fitness (com.xiaomi.wearable) not found on phone"
    exit 1
fi
echo "==> Launching Third App Support debug page..."
RESULT=$($ADB shell "CLASSPATH=$LAUNCH_DEX app_process / LaunchFragment $APK_PATH" 2>&1)
if ! echo "$RESULT" | grep -q "SUCCESS"; then
    echo "ERROR: Failed to launch debug page: $RESULT"
    exit 1
fi
echo "    Debug page launched"

# --- Step 5: Automate UI interaction ---
sleep 4

enter_package_name() {
    echo "==> Entering package name..."
    $ADB shell uiautomator dump /sdcard/ui_tmp.xml 2>/dev/null
    local COORDS=$($ADB pull /sdcard/ui_tmp.xml /tmp/ui_tmp.xml 2>/dev/null; python3 -c "
import sys, re
xml = open('/tmp/ui_tmp.xml').read()
m = re.search(r'text=\"click to input package name\".*?bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', xml)
if m: print(f'{(int(m.group(1))+int(m.group(3)))//2} {(int(m.group(2))+int(m.group(4)))//2}')
" 2>/dev/null)

    if [ -n "$COORDS" ]; then
        $ADB shell input tap $COORDS
    else
        echo "    WARN: Could not find 'click to input package name' button"
        $ADB shell input tap 720 689
    fi
    sleep 1.5

    # Find and tap the EditText in the dialog
    $ADB shell uiautomator dump /sdcard/ui_tmp.xml 2>/dev/null
    COORDS=$($ADB pull /sdcard/ui_tmp.xml /tmp/ui_tmp.xml 2>/dev/null; python3 -c "
import sys, re
xml = open('/tmp/ui_tmp.xml').read()
m = re.search(r'class=\"android.widget.EditText\".*?bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', xml)
if m: print(f'{(int(m.group(1))+int(m.group(3)))//2} {(int(m.group(2))+int(m.group(4)))//2}')
" 2>/dev/null)

    if [ -n "$COORDS" ]; then
        $ADB shell input tap $COORDS
    fi
    sleep 0.5

    # Type package name: keyboard adds space after first dot only
    local FIRST_PART="${PKG_NAME%%.*}"
    local REST="${PKG_NAME#*.}"
    $ADB shell input text "$FIRST_PART"
    sleep 0.2
    $ADB shell input keyevent 56  # dot
    sleep 0.3
    $ADB shell input keyevent 67  # delete auto-space
    sleep 0.1
    $ADB shell "input text '$REST'"
    sleep 0.3

    # Tap OK button
    sleep 0.3
    $ADB shell uiautomator dump /sdcard/ui_tmp.xml 2>/dev/null
    COORDS=$($ADB pull /sdcard/ui_tmp.xml /tmp/ui_tmp.xml 2>/dev/null; python3 -c "
import re
xml = open('/tmp/ui_tmp.xml').read()
m = re.search(r'text=\"OK\".*?bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', xml)
if m: print(f'{(int(m.group(1))+int(m.group(3)))//2} {(int(m.group(2))+int(m.group(4)))//2}')
" 2>/dev/null)
    if [ -n "$COORDS" ]; then
        $ADB shell input tap $COORDS
    else
        $ADB shell input tap 1023 1577
    fi
    sleep 1.5
}

tap_button() {
    local BUTTON_TEXT="$1"
    $ADB shell uiautomator dump /sdcard/ui_tmp.xml 2>/dev/null
    local COORDS=$($ADB pull /sdcard/ui_tmp.xml /tmp/ui_tmp.xml 2>/dev/null; python3 -c "
import sys, re
xml = open('/tmp/ui_tmp.xml').read()
m = re.search(r'text=\"$BUTTON_TEXT\".*?bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', xml)
if m: print(f'{(int(m.group(1))+int(m.group(3)))//2} {(int(m.group(2))+int(m.group(4)))//2}')
" 2>/dev/null)

    if [ -n "$COORDS" ]; then
        $ADB shell input tap $COORDS
        return 0
    fi
    return 1
}

enter_package_name

if [ "$DO_UNINSTALL" = true ]; then
    echo "==> Uninstalling old version..."
    tap_button "uninstall third app"
    sleep 5
fi

echo "==> Tapping 'install third app'..."
tap_button "install third app"
sleep 2

echo ""
echo "==> File picker is now open on your phone."
echo "    Please select the RPK file: $RPK_FILENAME"
echo ""
echo "    Waiting for you to select the file..."
echo "    (The app will be pushed to your band automatically after selection)"
