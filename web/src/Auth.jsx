// Auth.jsx — minimal email/password auth modal (Phase 1). Uses the headless
// aws-amplify/auth APIs so it matches the app's bespoke styling instead of the
// default Authenticator UI. Auth is OPTIONAL: study works logged-out; signing in
// only turns on cross-device sync.
import { useState, useRef } from "react";
import { signIn, signUp, confirmSignUp, resendSignUpCode, signOut, getCurrentUser, fetchUserAttributes } from "aws-amplify/auth";

const msg = (e) => (e && e.message ? e.message : String(e));

export async function currentUser() {
  try {
    await getCurrentUser();
    const attrs = await fetchUserAttributes();
    return { email: attrs.email || "" };
  } catch {
    return null;
  }
}

export async function logOut() {
  try { await signOut(); } catch { /* ignore */ }
}

export default function Auth({ onAuthed, onClose }) {
  const [mode, setMode] = useState("signIn"); // signIn | signUp | confirm
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState(""); // neutral info (e.g. "code sent")
  const inflight = useRef(false); // hard guard against double-submit (re-entrancy)

  const go = (m) => { setErr(""); setNotice(""); setMode(m); };

  const done = async () => {
    const u = await currentUser();
    if (u) onAuthed(u);
  };

  // Resend a fresh confirmation code (manual button, and used by recovery paths).
  const resend = async () => {
    setErr(""); setNotice(""); setBusy(true);
    try {
      await resendSignUpCode({ username: email });
      setNotice(`A new code is on its way to ${email}.`);
    } catch (e2) {
      setErr(msg(e2));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (inflight.current) return; // ignore a second submit while one is running
    inflight.current = true;
    setErr(""); setNotice("");
    setBusy(true);
    try {
      if (mode === "signIn") {
        try {
          await signIn({ username: email, password });
          await done();
        } catch (e2) {
          // Already-confirmed session lingering from a prior tab.
          if (e2?.name === "UserAlreadyAuthenticatedException") { await done(); return; }
          // Account exists but was never confirmed (e.g. refreshed before
          // entering the code): resend a fresh code and drop into confirm.
          if (e2?.name === "UserNotConfirmedException") {
            try { await resendSignUpCode({ username: email }); } catch { /* existing code may still be valid */ }
            setMode("confirm");
            setNotice("This account isn't confirmed yet — we've emailed you a fresh code.");
            return;
          }
          throw e2;
        }
      } else if (mode === "signUp") {
        try {
          await signUp({ username: email, password, options: { userAttributes: { email } } });
          setMode("confirm");
          setNotice(`We emailed a confirmation code to ${email}.`);
        } catch (e2) {
          // Email already registered. If it's unconfirmed, resend + confirm;
          // otherwise it's a real account — nudge to sign in.
          if (e2?.name === "UsernameExistsException") {
            try {
              await resendSignUpCode({ username: email });
              setMode("confirm");
              setNotice("You already started an account that isn't confirmed — we've sent a fresh code.");
            } catch {
              setMode("signIn");
              setErr("An account with this email already exists — try signing in.");
            }
            return;
          }
          throw e2;
        }
      } else {
        try {
          await confirmSignUp({ username: email, confirmationCode: code });
        } catch (e2) {
          // The account was already confirmed (e.g. confirmed in the AWS console
          // out of band). That's not a failure — skip straight to signing in.
          const already = e2?.name === "NotAuthorizedException" && /CONFIRMED/i.test(msg(e2));
          if (!already) throw e2;
        }
        await signIn({ username: email, password });
        await done();
      }
    } catch (e2) {
      setErr(msg(e2));
    } finally {
      setBusy(false);
      inflight.current = false;
    }
  };

  const title = mode === "signIn" ? "Sign in to sync" : mode === "signUp" ? "Create an account" : "Confirm your email";

  return (
    <div className="dq-auth-backdrop" onClick={onClose}>
      <form className="dq-auth" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="dq-auth-h">{title}</div>
        <p className="dq-auth-note">Your study progress is saved on this device either way — signing in keeps it in sync across your devices.</p>

        {mode !== "confirm" && (
          <>
            <input className="dq-auth-in" type="email" placeholder="email" autoComplete="email"
                   value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input className="dq-auth-in" type="password" placeholder="password" autoComplete={mode === "signUp" ? "new-password" : "current-password"}
                   value={password} onChange={(e) => setPassword(e.target.value)} required />
          </>
        )}
        {mode === "confirm" && (
          <>
            <input className="dq-auth-in" type="text" inputMode="numeric" placeholder="confirmation code"
                   value={code} onChange={(e) => setCode(e.target.value)} required />
            <button type="button" className="dq-auth-link" onClick={resend} disabled={busy}>
              Didn't get it? Resend code
            </button>
          </>
        )}

        {notice && <div className="dq-auth-info">{notice}</div>}
        {err && <div className="dq-auth-err">{err}</div>}

        <button className="dq-primary" type="submit" disabled={busy}>
          {busy ? "…" : mode === "signIn" ? "Sign in" : mode === "signUp" ? "Sign up" : "Confirm"}
        </button>

        <div className="dq-auth-switch">
          {mode === "signIn" ? (
            <button type="button" onClick={() => go("signUp")}>Need an account? Sign up</button>
          ) : mode === "signUp" ? (
            <button type="button" onClick={() => go("signIn")}>Have an account? Sign in</button>
          ) : (
            <button type="button" onClick={() => go("signIn")}>Back to sign in</button>
          )}
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
