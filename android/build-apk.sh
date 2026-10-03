#!/usr/bin/env bash
# Builds the signed APK with only the Android SDK (no Gradle / Maven downloads needed).
#   ANDROID_HOME=/path/to/android-sdk ./build-apk.sh   →  ../app/daily.apk
# Needs: platforms;android-34 and build-tools;37.0.0 (sdkmanager), a JDK 17+.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:?set ANDROID_HOME}"
BT="$SDK/build-tools/${BUILD_TOOLS:-37.0.0}"
JAR="$SDK/platforms/android-34/android.jar"
PKG=io.github.shalone86.daily
VERSION_CODE=$(grep -o "versionCode [0-9]*" app/build.gradle | grep -o "[0-9]*")
VERSION_NAME=$(grep -o "versionName '[^']*'" app/build.gradle | cut -d"'" -f2)
OUT=build/manual
rm -rf "$OUT" && mkdir -p "$OUT/classes" "$OUT/dex"
sed "s#<manifest #<manifest package=\"$PKG\" #" app/src/main/AndroidManifest.xml > "$OUT/AndroidManifest.xml"
"$BT/aapt2" compile --dir app/src/main/res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" --manifest "$OUT/AndroidManifest.xml" \
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" "$OUT/res.zip"
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$JAR" -d "$OUT/classes" $(find app/src/main/java -name "*.java")
"$BT/d8" --lib "$JAR" --min-api 24 --release --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -j ../base.apk classes.dex)
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks daily.keystore --ks-pass pass:dailyapp --key-pass pass:dailyapp --ks-key-alias daily --out ../app/daily.apk "$OUT/aligned.apk"
"$BT/apksigner" verify ../app/daily.apk
echo "Built ../app/daily.apk (version $VERSION_NAME / $VERSION_CODE)"
