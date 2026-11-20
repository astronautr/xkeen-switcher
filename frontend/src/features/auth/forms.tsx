import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useChangePassword, useLogin, usePairLogin, useSetup } from "../../api/mutations";
import { StaleSessionError } from "../../api/client";
import type { SessionDto } from "../../api/types";
import { useNotifications } from "../../app/AppSessionProvider";
import { useTheme } from "../../app/theme";
import type { Theme } from "../../browser/preferences";
import { ActionButton, Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { errorMessage } from "../../ui/format";

export function authError(error: unknown) {
  const retry = error && typeof error === "object" && "retryAfter" in error
    ? error.retryAfter : null;
  return errorMessage(error) + (retry ? ` · retry in ${retry}s` : "");
}

export function AuthBrand({ theme: selectedTheme }: { theme?: Theme }) {
  const { theme: savedTheme } = useTheme();
  const theme = selectedTheme ?? savedTheme;
  return (
    <div className="brand">
      <picture>
        {theme === "auto" && <source srcSet="/icon-dark.svg" media="(prefers-color-scheme: dark)" />}
        <img className="brand-ico" alt="" src={theme === "dark" ? "/icon-dark.svg" : "/icon-light.svg"} />
      </picture>
      xkeen.switch
    </div>
  );
}

function Username() {
  return <input
    type="text"
    name="username"
    value="admin"
    readOnly
    autoComplete="username"
    className="visually-hidden"
    tabIndex={-1}
    aria-hidden="true"
    />;
}

export function LoginContent() {
  const login = useLogin();
  const pair = usePairLogin();
  const input = useRef<HTMLFormElement>(null);
  const [code, setCode] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const busy = login.isPending || pair.isPending;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    try {
      if (code) await pair.mutateAsync({ code: value });
      else await login.mutateAsync({ password: value });
    } catch (failure) {
      if (!(failure instanceof StaleSessionError)) setError(authError(failure));
    }
  }

  return (
    <div className="app">
      <div className="gate">
        <AuthBrand />
        <p className="g-sub">Sign in to your home dashboard</p>
        <form ref={input} onSubmit={submit}>
          <Username />
          <label className="gate-label" htmlFor="login-secret">{code ? "One-time code" : "Admin password"}</label>
          {code && <p className="g-hint" id="login-code-hint" data-marker="gate-code-hint">On a signed-in browser, choose link device and enter the six digits it shows. Codes expire after five minutes.</p>}
          <Field
            marker="gate-input"
            className="g-input"
            id="login-secret"
            name={code ? "code" : "password"}
            type={code ? "text" : "password"}
            required
            placeholder={code ? "000 000" : "Admin password"}
            autoComplete={code ? "one-time-code" : "current-password"}
            inputMode={code ? "numeric" : "text"}
            maxLength={code ? 16 : 128}
            spellCheck={false}
            aria-describedby={code ? "login-code-hint" : undefined}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            />
          <div className="g-err" role="alert" data-marker="gate-error">{error}</div>
          <ActionButton className="ui-button g-btn" marker="gate-submit" type="submit" disabled={busy}
            idle="sign in" pending="signing in" busy={busy} />
          <Button variant="bracket" className="gate-mode" marker="gate-mode" disabled={busy} onClick={() => {
            setCode(!code);
            setValue("");
            setError("");
            input.current?.querySelector<HTMLInputElement>('[data-marker="gate-input"]')?.focus();
          }}>{code ? "Sign in with password" : "Sign in with code"}</Button>
        </form>
      </div>
    </div>
  );
}

export type PasswordContentProps = {
  changing?: boolean;
  onCancel: () => void;
  onSaved?: (replacement?: SessionDto) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
};

export function PasswordContent({ changing = false, onCancel, onSaved, onDirtyChange, onPendingChange }: PasswordContentProps) {
  const setup = useSetup();
  const change = useChangePassword();
  const notifications = useNotifications();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const busy = setup.isPending || change.isPending;
  const dirty = !!(current || password || repeat);

  useLayoutEffect(() => { onDirtyChange?.(dirty); }, [onDirtyChange, dirty]);
  useLayoutEffect(() => { onPendingChange?.(busy); }, [onPendingChange, busy]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (password !== repeat) {
      setError("passwords do not match");
      return;
    }
    try {
      let replacement: SessionDto | undefined;
      if (changing) replacement = await change.mutateAsync({ current_password: current, password });
      else await setup.mutateAsync({ password });
      setCurrent("");
      setPassword("");
      setRepeat("");
      notifications.publish(changing ? "password changed · other browsers signed out" : "Admin password created.");
      onSaved?.(replacement);
    } catch (failure) {
      if (!(failure instanceof StaleSessionError)) setError(authError(failure));
    }
  }

  const content = (
    <div className={changing ? "settings-password gate" : "gate"}>
      {!changing && <AuthBrand />}
      <h1 className="g-sub">{changing ? "change admin password" : "Create admin password"}</h1>
      <p className="g-hint">{changing ? "changing the password signs out other browsers." : "Set a password to sign in and manage your home dashboard."}</p>
      <form data-marker="password-form" onSubmit={submit}>
        <Username />
        {changing && <>
          <label className="gate-label" htmlFor="password-current">current password</label>
          <Field
            autoFocus
            marker="password-current"
            className="g-input"
            type="password"
            id="password-current"
            name="current_password"
            autoComplete="current-password"
            required
            maxLength={128}
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            />
        </>}
        <label className="gate-label" htmlFor="password-new">{changing ? "new password" : "New admin password"}</label>
        <Field
          marker="password-new"
          className="g-input"
          type="password"
          id="password-new"
          name="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          />
        <p className="g-hint">{changing ? "12–128 characters. spaces count." : "Use 12–128 characters. Spaces count."}</p>
        <label className="gate-label" htmlFor="password-repeat">{changing ? "confirm password" : "Confirm admin password"}</label>
        <Field
          marker="password-repeat"
          className="g-input"
          type="password"
          id="password-repeat"
          name="password_confirmation"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
          value={repeat}
          onChange={(event) => setRepeat(event.target.value)}
          />
        <div className="g-err" role="alert" data-marker="password-error">{error}</div>
        <ActionButton marker="password-submit" className="ui-button g-btn" type="submit" disabled={busy}
          idle={changing ? "save admin password" : "create admin password"}
          pending={changing ? "saving password" : "creating password"} busy={busy} />
        <Button
          marker="password-cancel"
          variant="bracket"
          className="gate-mode"
          disabled={busy}
          onClick={onCancel}>{changing ? "cancel" : "already set up? sign in"}</Button>
      </form>
    </div>
  );
  return changing ? content : <div className="app">{content}</div>;
}
