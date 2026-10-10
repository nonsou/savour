import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { safeNext } from "@/lib/urls";
import { sendCode, signIn, signUp, verifyCode } from "./actions";

export const metadata = { title: "Sign in — SAVOUR" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const hidden = <input type="hidden" name="next" value={next} />;
  return (
    <main className="container narrow stack">
      <Link href="/" className="brand">SAVOUR</Link>
      <h1>Sign in</h1>
      {sp.error === "link" && <p className="notice error">That sign-in link is invalid or expired. Request a new one.</p>}
      {next.startsWith("/invite/") && <p className="notice warn">Sign in with the email address the invitation was sent to.</p>}

      <section className="card">
        <h2>Email and password</h2>
        <ActionForm action={signIn}>
          {hidden}
          <div className="field"><label htmlFor="si-email">Email</label>
            <input id="si-email" name="email" type="email" autoComplete="email" required /></div>
          <div className="field"><label htmlFor="si-pass">Password</label>
            <input id="si-pass" name="password" type="password" autoComplete="current-password" required /></div>
          <SubmitButton className="btn primary block" pendingText="Signing in…">Sign in</SubmitButton>
        </ActionForm>
      </section>

      <section className="card">
        <h2>Email me a sign-in link</h2>
        <p className="muted small">Useful for guest assessors. Works for new and existing accounts.</p>
        <ActionForm action={sendCode}>
          {hidden}
          <div className="field"><label htmlFor="otp-email">Email</label>
            <input id="otp-email" name="email" type="email" autoComplete="email" required /></div>
          <SubmitButton className="btn block" pendingText="Sending…">Send link</SubmitButton>
        </ActionForm>
        <details className="small" style={{ marginTop: ".75rem" }}>
          <summary>I have a code</summary>
          <ActionForm action={verifyCode}>
            {hidden}
            <div className="field"><label htmlFor="code-email">Email</label>
              <input id="code-email" name="email" type="email" autoComplete="email" required /></div>
            <div className="field"><label htmlFor="code">Code</label>
              <input id="code" name="token" inputMode="numeric" autoComplete="one-time-code" required /></div>
            <SubmitButton className="btn block" pendingText="Checking…">Verify code</SubmitButton>
          </ActionForm>
        </details>
      </section>

      <section className="card">
        <h2>Create an account</h2>
        <ActionForm action={signUp}>
          {hidden}
          <div className="field"><label htmlFor="su-email">Email</label>
            <input id="su-email" name="email" type="email" autoComplete="email" required /></div>
          <div className="field"><label htmlFor="su-pass">Password <span className="hint">(at least 10 characters)</span></label>
            <input id="su-pass" name="password" type="password" autoComplete="new-password" minLength={10} required /></div>
          <SubmitButton className="btn block" pendingText="Creating…">Create account</SubmitButton>
        </ActionForm>
      </section>
    </main>
  );
}
