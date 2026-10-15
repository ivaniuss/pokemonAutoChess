export const FIREBASE_CONFIG = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
}

// Local development only: URL of the Firebase Auth emulator (e.g. http://127.0.0.1:9099)
export const FIREBASE_AUTH_EMULATOR_URL: string | undefined =
  process.env.FIREBASE_AUTH_EMULATOR_URL
