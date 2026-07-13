// Platform detection for keyboard-hint labels. The ⌘K / Ctrl-K palette handler already accepts
// both modifiers (App.tsx) — this only fixes the *label* so Windows/Linux users don't see a Mac
// symbol for a shortcut that's actually Ctrl-K on their machine.
export const isMac =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test(
    (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
      navigator.platform ||
      navigator.userAgent
  );

/** Label for the command-palette shortcut, e.g. "⌘K" on macOS, "Ctrl K" elsewhere. */
export const modKeyLabel = isMac ? '⌘K' : 'Ctrl K';
