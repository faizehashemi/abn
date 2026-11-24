# ABN Portal — Android app

A thin shell: one full-screen WebView showing https://raajsoftware.com/abn/. There are no native
screens or menus; the app only provides what a browser tab would otherwise provide:

- camera and location permission for **Self check-in** (selfie after punching on the X990),
- file picking (profile photo), downloads (CSV exports), the back button,
- external links (WhatsApp, maps, email, phone) open in their own apps,
- a simple "No connection — Try again" page when offline.

The portal recognises the app by `ABNApp/1.0` in the user agent (check-ins are tagged `app`).

## Build

Requires JDK 17+ and the Android SDK (platform 35, build-tools 35).

```bash
cd android
export ANDROID_HOME=/path/to/android-sdk
./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
cp app/build/outputs/apk/release/app-release.apk ../public/abn/app/abn-portal.apk   # served at /abn/app
```

## Signing

Release builds are signed with the key described in `android/keystore.properties`
(not committed — see `.gitignore`):

```
storeFile=/absolute/path/abn-portal-release.jks
storePassword=…
keyAlias=abn
keyPassword=…
```

**Keep the .jks file and its password safe.** Android only installs an update over an existing
installation if it is signed with the same key. For each release bump `versionCode` in
`app/build.gradle`.
