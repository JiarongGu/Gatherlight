import type { ReactNode, MouseEventHandler } from 'react';

interface Props {
  icon: ReactNode;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  title?: string;
  ariaLabel?: string;
  /** extra class for context-specific sizing (e.g. "topbar-icon-btn") */
  className?: string;
  danger?: boolean;
  disabled?: boolean;
}

/** L1 — a borderless icon button (display + onClick). */
export function IconButton({ icon, onClick, title, ariaLabel, className = '', danger, disabled }: Props) {
  return (
    <button
      type="button"
      className={`icon-btn ${danger ? 'danger' : ''} ${className}`}
      title={title}
      aria-label={ariaLabel ?? title}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
    </button>
  );
}
