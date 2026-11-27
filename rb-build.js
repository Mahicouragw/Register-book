// rb-build.js — "what this build contains" stamp.
//
// tools/prepare-www.js OVERWRITES this file inside www/ for every APK build,
// so the app always knows whether Android Firebase (google-services.json) was
// part of the package. This copy is the website default: no Android build, so
// no Firebase -> the APK-only push registration path stays switched off.
window.RB_BUILD = { firebase: false, platform: "web" };
window.RB_FIREBASE = false;
window.RB_FIREBASE_CONFIG = null;
