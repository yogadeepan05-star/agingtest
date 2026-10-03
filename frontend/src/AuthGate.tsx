/**
 * AuthGate.tsx
 *
 * Wraps the entire application.  Until an operator signs in with a Firebase
 * account that has the `operator: true` custom claim, only the sign-in form is
 * rendered.
 *
 * Usage:
 *   <AuthGate>{children}</AuthGate>
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  auth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from './firebase';

interface Props {
  children: ReactNode;
}

type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

export function AuthGate({ children }: Props) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [signingIn, setSigningIn] = useState(false);

  // If Firebase SDK is not configured (e.g., during local emulator dev without
  // .env), skip auth and render children directly.
  const authDisabled = !auth;

  useEffect(() => {
    if (authDisabled) {
      setStatus('signed-in');
      return;
    }
    const unsub = onAuthStateChanged(auth!, (u) => {
      setUser(u);
      setStatus(u ? 'signed-in' : 'signed-out');
    });
    return unsub;
  }, [authDisabled]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth) return;
    setError('');
    setSigningIn(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      // onAuthStateChanged will fire and update status
    } catch (err: unknown) {
      const msg = (err instanceof Error) ? err.message : 'Sign-in failed.';
      // Strip Firebase's verbose error prefixes for cleaner UX
      setError(msg.replace('Firebase: ', '').replace(/ \(auth\/.*\)\.$/, '.'));
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    if (!auth) return;
    await signOut(auth);
  };

  if (status === 'loading') {
    return (
      <div className="connecting-overlay">
        <div className="connecting-spinner" />
        <p>Loading…</p>
      </div>
    );
  }

  if (status === 'signed-out') {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <div className="auth-logo">
            <span className="auth-logo-icon">🔋</span>
            <h1 className="auth-title">Aging Test</h1>
            <p className="auth-subtitle">Operator sign-in required</p>
          </div>

          <form onSubmit={handleSignIn} className="auth-form" id="signin-form">
            <div className="auth-field">
              <label htmlFor="auth-email" className="auth-label">Email</label>
              <input
                id="auth-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="auth-input"
                placeholder="operator@example.com"
                disabled={signingIn}
              />
            </div>
            <div className="auth-field">
              <label htmlFor="auth-password" className="auth-label">Password</label>
              <input
                id="auth-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="auth-input"
                placeholder="••••••••"
                disabled={signingIn}
              />
            </div>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button
              type="submit"
              id="signin-btn"
              className="auth-submit"
              disabled={signingIn}
            >
              {signingIn ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Signed in — render children plus a small sign-out affordance in the corner
  return (
    <>
      {children}
      {user && (
        <div className="auth-topbar">
          <span className="auth-user-email">{user.email}</span>
          <button
            id="signout-btn"
            className="auth-signout-btn"
            onClick={handleSignOut}
            title="Sign out"
          >
            Sign out
          </button>
        </div>
      )}
    </>
  );
}
