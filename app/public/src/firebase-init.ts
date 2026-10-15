import firebase from "firebase/compat/app"
import "firebase/compat/auth"
import { FIREBASE_AUTH_EMULATOR_URL, FIREBASE_CONFIG } from "../../config"

let emulatorConnected = false

export function initFirebase() {
  if (!firebase.apps.length) {
    firebase.initializeApp(FIREBASE_CONFIG)
  }
  if (FIREBASE_AUTH_EMULATOR_URL && !emulatorConnected) {
    firebase.auth().useEmulator(FIREBASE_AUTH_EMULATOR_URL)
    emulatorConnected = true
  }
}
