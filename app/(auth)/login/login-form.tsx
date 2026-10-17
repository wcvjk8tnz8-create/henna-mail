"use client";

import { useState, useTransition } from "react";
import { requestEmailCode, signInWithPassword } from "./actions";

export interface LoginFormProps {
  readonly methods: readonly string[];
  readonly passwordMinLength: number;
  readonly otpCooldownSeconds: number;
  readonly githubEnabled: boolean;
  readonly emailOtpEnabled: boolean;
  readonly hasPendingMfa: boolean;
  readonly nextPath: string;
}

type Mode = "password" | "email_otp";

export function LoginForm(props: LoginFormProps) {
  const [mode, setMode] = useState<Mode>(props.methods.includes("password") ? "password" : "email_otp");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);

  const passwordAllowed = props.methods.includes("password");
  const emailOtpAllowed = props.methods.includes("email_otp") && props.emailOtpEnabled;

  function onPasswordSubmit(formData: FormData) {
    setMessage(null);
    startTransition(async () => {
      const result = await signInWithPassword(formData);
      if (result && !result.ok) setMessage(result.message);
    });
  }

  function onRequestCode(formData: FormData) {
    setMessage(null);
    startTransition(async () => {
      const result = await requestEmailCode(formData);
      setOtpSent(true);
      setMessage(result.message);
    });
  }

  return (
    <div className="mt-8">
      {props.hasPendingMfa ? (
        <a
          href="/mfa"
          className="mb-6 block rounded-md border border-henna-400 bg-henna-50 px-3 py-2 text-sm text-henna-900"
        >
          You have a sign-in waiting on a second factor. Continue →
        </a>
      ) : null}

      <div className="mb-6 flex gap-1 rounded-lg bg-neutral-100 p-1 dark:bg-neutral-900">
        {passwordAllowed ? (
          <button
            type="button"
            onClick={() => setMode("password")}
            aria-pressed={mode === "password"}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${
              mode === "password"
                ? "bg-white shadow-sm dark:bg-neutral-800"
                : "text-neutral-600 dark:text-neutral-400"
            }`}
          >
            Password
          </button>
        ) : null}
        {emailOtpAllowed ? (
          <button
            type="button"
            onClick={() => setMode("email_otp")}
            aria-pressed={mode === "email_otp"}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${
              mode === "email_otp"
                ? "bg-white shadow-sm dark:bg-neutral-800"
                : "text-neutral-600 dark:text-neutral-400"
            }`}
          >
            Email code
          </button>
        ) : null}
      </div>

      {mode === "password" && passwordAllowed ? (
        <form action={onPasswordSubmit} className="space-y-4">
          <input type="hidden" name="next" value={props.nextPath} />
          <Field
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            required
            description="Use the address on your Henna account."
          />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            minLength={props.passwordMinLength}
            description={`At least ${props.passwordMinLength} characters.`}
          />
          <Submit pending={pending} label="Sign in" />
        </form>
      ) : null}

      {mode === "email_otp" && emailOtpAllowed ? (
        <form action={onRequestCode} className="space-y-4">
          <input type="hidden" name="next" value={props.nextPath} />
          <Field
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            required
            description="We will send a 6-digit code, valid for 10 minutes."
          />
          {otpSent ? (
            <Field
              label="Code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              description="The code can only be used once."
            />
          ) : null}
          <Submit pending={pending} label={otpSent ? "Verify code" : "Send code"} />
        </form>
      ) : null}

      {message ? (
        <p role="status" className="mt-4 text-sm text-neutral-700 dark:text-neutral-300">
          {message}
        </p>
      ) : null}

      {props.githubEnabled ? (
        <>
          <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wide text-neutral-500">
            <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
            or
            <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
          </div>
          <a
            href="/api/auth/github"
            className="flex w-full items-center justify-center gap-2 rounded-md border border-neutral-300 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            <GitHubMark />
            Continue with GitHub
          </a>
        </>
      ) : null}

      <p className="mt-6 text-xs text-neutral-500">
        Trouble signing in? Ask an administrator for a recovery code — Henna never emails passwords.
      </p>
    </div>
  );
}

function Field(props: {
  readonly label: string;
  readonly name: string;
  readonly type?: string;
  readonly description?: string;
  readonly autoComplete?: string;
  readonly required?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly inputMode?: "numeric" | "text";
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{props.label}</span>
      <input
        name={props.name}
        type={props.type ?? "text"}
        autoComplete={props.autoComplete}
        required={props.required}
        minLength={props.minLength}
        maxLength={props.maxLength}
        inputMode={props.inputMode}
        className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-henna-600 dark:border-neutral-700 dark:bg-neutral-900"
      />
      {props.description ? (
        <span className="mt-1 block text-xs text-neutral-500">{props.description}</span>
      ) : null}
    </label>
  );
}

function Submit({ pending, label }: { readonly pending: boolean; readonly label: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-henna-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-henna-700 disabled:opacity-60"
    >
      {pending ? "Working…" : label}
    </button>
  );
}

function GitHubMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995 7.995 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
