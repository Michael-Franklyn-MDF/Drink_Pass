import { useEffect, useState } from "react";
import { clearEvent, refreshEvent } from "./lib/liveEventStore.js";
import { supabase } from "./lib/supabaseClient.js";
import { Screen, ScreenTitle, TextField } from "./ui.jsx";

export default function LiveEventGate({ mode, role, children }) {
  const operator = mode === "admin" || mode === "bartender";
  const [access, setAccess] = useState(operator ? "checking" : "loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    let timer;
    async function refresh(initial = false) {
      try {
        await refreshEvent();
        if (active) {
          setAccess("ready");
          setError("");
        }
      } catch (issue) {
        if (active) {
          if (initial) setAccess("failed");
          setError(issue.message || "Couldn’t connect to Drink Pass.");
        }
      }
    }
    async function start() {
      if (operator) {
        const { data } = await supabase.auth.getSession();
        if (!active) return;
        if (!data.session) {
          setAccess("sign-in");
          return;
        }
      }
      await refresh(true);
      if (active) poll();
    }
    function poll() {
      timer = window.setTimeout(async () => {
        await refresh();
        if (active) poll();
      }, 2000);
    }
    void start();
    return () => {
      active = false;
      window.clearInterval(timer);
      clearEvent();
    };
  }, [operator, retry]);

  async function signIn(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = new FormData(event.currentTarget);
    try {
      const { error: issue } = await supabase.auth.signInWithPassword({
        email: values.get("email").trim(),
        password: values.get("password"),
      });
      if (issue) throw issue;
      setAccess("checking");
      setRetry((value) => value + 1);
    } catch {
      setError("Couldn’t sign in. Check your email and password.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    const { error: issue } = await supabase.auth.signOut({ scope: "local" });
    if (issue) {
      setError("Couldn’t sign out. Try again.");
      return;
    }
    setError("");
    setAccess("sign-in");
    setRetry((value) => value + 1);
  }

  if (access === "ready") {
    return (
      <>
        {children}
        {error && <p className="field-error" role="alert">Couldn’t refresh Drink Pass. Retrying…</p>}
        {operator && <button className="text-link live-sign-out" type="button" onClick={signOut}>Sign out</button>}
      </>
    );
  }

  return (
    <Screen role={role}>
      <div className="screen-content">
        <ScreenTitle>{access === "sign-in" ? `Sign in as ${role}` : "Connect to Drink Pass"}</ScreenTitle>
        {!supabase && <p className="field-error" role="alert">The Supabase project URL and publishable key are required.</p>}
        {supabase && access === "sign-in" && (
          <form className="admin-form" onSubmit={signIn}>
            <TextField label="Email" name="email" type="email" autoComplete="username" />
            <TextField label="Password" name="password" type="password" autoComplete="current-password" />
            {error && <p className="field-error" role="alert">{error}</p>}
            <button className="button button-primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
        )}
        {supabase && (access === "checking" || access === "loading") && <p role="status">Loading live event…</p>}
        {access === "failed" && (
          <>
            <p className="field-error" role="alert">{error}</p>
            <button className="button button-secondary" onClick={() => setRetry((value) => value + 1)}>Try again</button>
            {operator && <button className="text-link" onClick={signOut}>Sign out</button>}
          </>
        )}
      </div>
    </Screen>
  );
}
