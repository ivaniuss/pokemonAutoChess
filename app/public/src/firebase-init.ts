import firebase from "firebase/compat/app"
import "firebase/compat/auth"
import { FIREBASE_AUTH_EMULATOR_URL, FIREBASE_CONFIG } from "../../config"

let emulatorConnected = false

// "auto" resolves to the emulator running on the same host as the page,
// so the game also works when opened from another machine on the network
function resolveEmulatorUrl(url: string) {
  return url === "auto"
    ? `${window.location.protocol}//${window.location.hostname}:9099`
    : url
}

export function initFirebase() {
  if (!firebase.apps.length) {
    firebase.initializeApp(FIREBASE_CONFIG)
  }
  if (FIREBASE_AUTH_EMULATOR_URL && !emulatorConnected) {
    firebase.auth().useEmulator(resolveEmulatorUrl(FIREBASE_AUTH_EMULATOR_URL))
    emulatorConnected = true
  }
}
