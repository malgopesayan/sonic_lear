plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.malgopelabs.soniclayer"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.malgopelabs.soniclayer"
        minSdk = 29
        targetSdk = 34
        versionCode = 53
        versionName = "5.3"
    }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
