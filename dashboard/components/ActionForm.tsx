'use client';

import { createContext, useContext, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import type { ActionState } from '@/lib/types';

const PendingContext = createContext(false);

export function SubmitButton({
  children, pendingText = 'Working…', className = 'primary', disabled = false,
}: { children: ReactNode; pendingText?: string; className?: string; disabled?: boolean }) {
  const pending = useContext(PendingContext);
  return (
    <button type="submit" className={className} disabled={pending || disabled}>
      {pending ? pendingText : children}
    </button>
  );
}

/**
 * A <form> bound to a server action that reports { ok, message } back inline.
 * Submission goes through onSubmit + a transition (not the form `action` prop) so React never
 * auto-resets the fields: after a validation error the user's input is still there.
 */
export function ActionForm({
  action, children, className, hideMessageOnOk = false,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
  hideMessageOnOk?: boolean;
}) {
  const [state, setState] = useState<ActionState>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      try {
        setState(await action(null, fd));
      } catch {
        setState({ ok: false, message: 'Request failed. Check your connection and try again.' });
      }
    });
  }

  return (
    <PendingContext.Provider value={pending}>
      <form onSubmit={onSubmit} className={className}>
        {children}
        {state && !(hideMessageOnOk && state.ok) ? (
          <p className={`msg ${state.ok ? 'ok' : 'err'}`} role="status">{state.message}</p>
        ) : null}
      </form>
    </PendingContext.Provider>
  );
}

/** Tiny single-button form (acknowledge, cancel, watchlist toggle ...). */
export function ButtonForm({
  action, fields, label, pendingText, className = '', buttonClass = 'small',
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  fields: Record<string, string | number>;
  label: string;
  pendingText?: string;
  className?: string;
  buttonClass?: string;
}) {
  return (
    <ActionForm action={action} className={className}>
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={String(v)} />)}
      <SubmitButton className={buttonClass} pendingText={pendingText ?? label}>{label}</SubmitButton>
    </ActionForm>
  );
}
