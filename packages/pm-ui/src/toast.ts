// Tiny client-side toast bus.
//
// Mutation handlers fire window CustomEvents; a single <ToastViewport/> mounted
// in the layout subscribes and renders the stack.  No state library, no
// dependencies on backend state — just the DOM event bus.
//
// SSR-safety: every entry point guards `typeof window` so that calling
// notifySuccess / notifyError from a module loaded on the server is a no-op.

export type ToastKind = 'success' | 'error';

export interface ToastEventDetail {
  kind: ToastKind;
  message: string;
}

export const TOAST_EVENT = 'toast';

function dispatch(detail: ToastEventDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ToastEventDetail>(TOAST_EVENT, { detail }));
}

export function notifySuccess(message: string): void {
  dispatch({ kind: 'success', message });
}

export function notifyError(message: string): void {
  dispatch({ kind: 'error', message });
}
