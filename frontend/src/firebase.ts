/**
 * firebase.ts
 *
 * Initialises the Firebase client SDK.
 * Config is read from Vite environment variables (frontend/.env).
 *
 * Used by:
 *   - api.ts         → injects ID tokens in API requests
 *   - AuthGate.tsx   → sign-in / sign-out UI
 */
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
  type User,
  type Auth,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

// Only initialise when the mandatory config is present (avoids emulator crashes
// when running vitest without a .env file).
let app: FirebaseApp | null = null;
let auth: Auth | null = null;

if (firebaseConfig.apiKey) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
}

export { app, auth };
export type { User };
export { signInWithEmailAndPassword, fbSignOut as signOut, onAuthStateChanged };

/**
 * Returns the current user's Firebase ID token, or null if not signed in.
 * Automatically refreshes the token if it is about to expire.
 */
export async function getIdToken(): Promise<string | null> {
  if (!auth || !auth.currentUser) return null;
  try {
    return await auth.currentUser.getIdToken();
  } catch {
    return null;
  }
}
