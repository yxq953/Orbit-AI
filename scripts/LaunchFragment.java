import java.lang.reflect.Constructor;
import java.lang.reflect.Method;

/** Run with app_process as the ADB shell; no Android SDK needed to compile. */
public final class LaunchFragment {
    public static void main(String[] args) {
        try {
            if (args.length != 2) {
                throw new IllegalArgumentException("Usage: LaunchFragment <apk-path> <fitness-package>");
            }
            String apkPath = args[0];
            String appPackage = args[1];
            if (!appPackage.equals("com.mi.health") && !appPackage.equals("com.xiaomi.wearable")) {
                throw new IllegalArgumentException("Unsupported fitness package");
            }
            Class.forName("android.os.Looper").getMethod("prepareMainLooper").invoke(null);
            Constructor<?> loaderCtor = Class.forName("dalvik.system.PathClassLoader")
                    .getConstructor(String.class, ClassLoader.class);
            ClassLoader loader = (ClassLoader) loaderCtor.newInstance(apkPath, ClassLoader.getSystemClassLoader());
            Class<?> builderClass = loader.loadClass("com.xiaomi.fitness.baseui.common.FragmentParams$b");
            Object builder = builderClass.getConstructor().newInstance();
            // Use the class-name setter to avoid loading Fragment's native dependencies in shell.
            builderClass.getMethod("d", String.class).invoke(builder,
                    "com.xiaomi.xms.wearable.ui.debug.ThirdAppDebugFragment");
            Class<?> bundleClass = Class.forName("android.os.Bundle");
            Object bundle = bundleClass.getConstructor().newInstance();
            bundleClass.getMethod("putBoolean", String.class, boolean.class).invoke(bundle, "isFromAdb", true);
            builderClass.getMethod("c", bundleClass).invoke(builder, bundle);
            Object fragmentParams = builderClass.getMethod("b").invoke(builder);
            Class<?> intentClass = Class.forName("android.content.Intent");
            Object intent = intentClass.getConstructor().newInstance();
            intentClass.getMethod("setClassName", String.class, String.class).invoke(intent, appPackage,
                    "com.xiaomi.fitness.baseui.common.CommonBaseActivity");
            intentClass.getMethod("addFlags", int.class).invoke(intent, 0x10000000);
            intentClass.getMethod("putExtra", String.class, Class.forName("android.os.Parcelable"))
                    .invoke(intent, "fragment_param", fragmentParams);
            Method getService = Class.forName("android.app.ActivityManager").getDeclaredMethod("getService");
            getService.setAccessible(true);
            Object service = getService.invoke(null);
            for (Method method : Class.forName("android.app.IActivityManager").getMethods()) {
                if (!method.getName().equals("startActivity")) continue;
                Class<?>[] types = method.getParameterTypes();
                Object[] values = new Object[types.length];
                boolean hasIntent = false;
                boolean hasCallingPackage = false;
                for (int i = 0; i < types.length; i++) {
                    if (types[i] == intentClass) { values[i] = intent; hasIntent = true; }
                    else if (types[i] == String.class && !hasCallingPackage) {
                        values[i] = "com.android.shell"; hasCallingPackage = true;
                    } else if (types[i] == int.class) values[i] = 0;
                    else if (types[i] == boolean.class) values[i] = false;
                    else if (types[i] == long.class) values[i] = 0L;
                }
                if (!hasIntent || !hasCallingPackage) continue;
                Object result = method.invoke(service, values);
                int status = ((Number) result).intValue();
                if (status < 0) throw new IllegalStateException("startActivity returned " + status);
                System.out.println("SUCCESS: startActivity=" + status);
                return;
            }
            throw new IllegalStateException("No compatible startActivity method");
        } catch (Throwable error) {
            error.printStackTrace();
            System.exit(1);
        }
    }
}
