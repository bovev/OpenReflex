import { useEffect, type RefObject } from "react";

/**
 * Modal dialog focus management.
 *
 * When the dialog opens, focus moves into it (the first focusable control,
 * so a keyboard user lands on the confirmation input or the first action).
 * When it closes, focus goes back to the element that was focused before
 * the dialog opened - a predictable restoration, so a keyboard-only user
 * never gets stranded on the document body.
 */
export function useDialogFocus(ref: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = ref.current?.querySelector<HTMLElement>("input, button, [href]");
    (first ?? ref.current)?.focus();
    return () => {
      if (previous !== null && document.body.contains(previous)) {
        previous.focus();
      }
    };
  }, [ref]);
}
