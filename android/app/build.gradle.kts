import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// License + public key are secrets — supplied via local.properties, never
// committed. Request them through your MedWand sales representative.
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun localProperty(name: String): String =
    localProperties.getProperty(name) ?: System.getenv(name) ?: ""

fun String.asBuildConfigString(): String =
    "\"${replace("\\", "\\\\").replace("\"", "\\\"")}\""

kotlin {
    jvmToolchain(21)
}

android {
    namespace = "com.medwand.poc"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.medwand.poc"
        // The MedWand SDK AAR declares API 26 as its minimum platform.
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        // Instrumented tests (src/androidTest) exercise the real Android graphics
        // stack — Bitmap pixel copy, Canvas downscale, Skia JPEG encode — which the
        // JVM/Robolectric shadows can't faithfully reproduce.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "MW_SDK_LICENSE", localProperty("MW_SDK_LICENSE").asBuildConfigString())
        buildConfigField("String", "MW_SDK_PUBLIC_KEY", localProperty("MW_SDK_PUBLIC_KEY").asBuildConfigString())
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        buildConfig = true
    }

    testOptions {
        unitTests {
            // Robolectric drives the bridge/protocol tests against a real Android
            // runtime (real org.json, Base64, Looper) instead of the stub jar.
            isIncludeAndroidResources = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    // Local MedWand Android SDK (BETA), driven by the device layer. The version
    // is kept in the filename so the bundled binary is self-documenting.
    implementation(files("libs/android-sdk-beta_0.0.0.3.aar"))
    // UVC camera backend the SDK's UvcCameraPreviewTarget delegates to. Required
    // at runtime for the MedWand's USB video (otoscope/dermatoscope) preview.
    implementation("com.herohan:UVCAndroid:1.0.11")

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    // WebViewCompat.addWebMessageListener + JavaScriptReplyProxy array-buffer replies.
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // Pure-JVM unit tests for the frame logic and the pipeline's threading/drop
    // contract need only JUnit.
    testImplementation("junit:junit:4.13.2")
    // Robolectric supplies a real Android runtime (org.json, Base64, Looper) so
    // the bridge protocol serialization can be tested off-device.
    testImplementation("org.robolectric:robolectric:4.14.1")

    // Instrumented tests run on a device/emulator to exercise AndroidFrameCodec
    // against the real Bitmap/Canvas/JPEG stack.
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
