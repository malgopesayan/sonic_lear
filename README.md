# SonicLayer Pro — Android

Your Chrome extension, wrapped as a native Android app (minSdk 29 / Android 10+).
`content.js`, `popup.js`, `popup.html` and `orbit-math.js` are your **unchanged** extension files
(only the logo in popup.html is inlined as a data URI). Two small shims replace the `chrome.*` APIs.

## Get the APK (no Android Studio needed)
1. Create a new GitHub repo, upload this whole folder (keep the hidden `.github` folder), push to `main`.
2. Repo → **Actions** → "Build APK" → open the run → download **SonicLayerPro-debug-apk** (zip containing `app-debug.apk`).
3. Copy to your phone, open it, allow "install unknown apps".

## Or build locally
Open this folder in Android Studio (Koala+ / JDK 17) → Build → Build APK(s).
Or, with Gradle 8.9 installed: `gradle assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk`.

## How it works
- Top bar = quick links (YouTube, SoundCloud, Twitch, Vimeo) + back. Page = a WebView.
- `content.js` is injected after each page load; saved per-site profile re-applies automatically.
- **EQ** button opens your popup UI in a bottom panel. Settings persist in SharedPreferences.
- Export saves JSON to Downloads; Import opens the system file picker.
- Alt+Shift+S shortcut has no mobile equivalent — use the Power toggle in the panel.

## Known limits
- Google blocks sign-in inside embedded WebViews, so you'll browse YouTube logged out (no Premium/ads-free).
- Audio may pause when the screen locks / app is backgrounded (YouTube pauses on visibility change). A foreground-service version would be the follow-up.
- Same DRM limits as the extension (Netflix, Spotify, etc. can't be processed).
- Popup layout was desktop-sized (440px); it's stretched to fit — tweak spacing in popup.html if anything looks cramped.
"# sonic_layer" 
