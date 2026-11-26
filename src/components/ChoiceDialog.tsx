import type { ReactNode, Ref } from 'react';
import { DialogBodyText, DialogHeader, Focusable } from '@decky/ui';
import { FocusOutlineStyles, focusOutlineProps } from './FocusOutline';
import { selectWithSound } from './GamepadSounds';

export function ChoiceDialogBody({ title, subtitle, bodyRef, children }: {
  title: string;
  subtitle?: string;
  bodyRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div ref={bodyRef} style={{ display: 'flex', flexDirection: 'column', width: 'min(31rem, 78vw)', maxHeight: 'min(68vh, 36rem)', minHeight: '9rem' }}>
      <FocusOutlineStyles />
      <DialogHeader style={{ flexShrink: 0, marginBottom: subtitle ? '0.35rem' : '0.8rem', overflowWrap: 'anywhere' }}>{title}</DialogHeader>
      {subtitle && <DialogBodyText style={{ flexShrink: 0, margin: '0 0 0.6rem', overflowWrap: 'anywhere' }}>{subtitle}</DialogBodyText>}
      {children}
    </div>
  );
}

export function ChoiceDialogList({ children, centerFocused = false }: { children: ReactNode; centerFocused?: boolean }) {
  const keepChoiceVisible = ({ Element: choice }: { Element?: HTMLElement }) => {
    const list = choice?.closest<HTMLElement>('[data-deckyplex-choice-list]');
    if (!choice || !list?.offsetHeight) return false;
    const bounds = list.getBoundingClientRect();
    const scale = bounds.height / list.offsetHeight;
    if (!scale) return false;
    const row = choice.closest<HTMLElement>('[data-deckyplex-choice-row]') ?? choice;
    const choiceBounds = row.getBoundingClientRect();
    const top = (choiceBounds.top - bounds.top) / scale - list.clientTop;
    const bottom = (choiceBounds.bottom - bounds.top) / scale - list.clientTop;
    const padding = 6;
    if (centerFocused) {
      const center = list.scrollTop + (top + bottom - list.clientHeight) / 2;
      const target = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, center));
      const visible = top >= padding && bottom <= list.clientHeight - padding;
      const moving = !list.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (Math.abs(list.scrollTop - target) > 1) list.scrollTo({ top: target, behavior: visible && moving ? 'smooth' : 'instant' });
    } else if (top < padding) list.scrollTop += top - padding;
    else if (bottom > list.clientHeight - padding) list.scrollTop += bottom - list.clientHeight + padding;
    return true;
  };
  return (
    <Focusable flow-children="column" data-deckyplex-choice-list=""
      {...{ scrollIntoViewWhenChildFocused: 'force', fnScrollIntoViewHandler: keepChoiceVisible }}
      onFocusCapture={event => {
        if (event.target instanceof HTMLElement) keepChoiceVisible({ Element: event.target });
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem',
        minHeight: 0, maxHeight: '48vh', boxSizing: 'border-box', overflowY: 'auto', padding: '6px', scrollPaddingBlock: '6px' }}>
      {children}
    </Focusable>
  );
}

export function ChoiceDialogRow({ title, detail, icon, badge, actionDescription = title, rowRef, preferredFocus, disabled, selected,
  destructive, onChoose, onToggle }: {
  title: string;
  detail?: string;
  icon: ReactNode;
  badge?: string;
  actionDescription?: string;
  rowRef?: Ref<HTMLDivElement>;
  preferredFocus?: boolean;
  disabled?: boolean;
  selected?: boolean;
  destructive?: boolean;
  onChoose: () => void;
  onToggle?: () => void;
}) {
  const activate = (event: { preventDefault(): void; stopPropagation(): void }, action: () => void, isRepeat = false) => {
    event.preventDefault();
    event.stopPropagation();
    if (!disabled && !isRepeat) selectWithSound(event, action);
  };
  return (
    <Focusable ref={rowRef} data-deckyplex-choice-row="" role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-pressed={selected}
      {...focusOutlineProps} {...{ focusable: !disabled, preferredFocus }} onOKActionDescription={actionDescription}
      onActivate={event => activate(event, onChoose)}
      onOKButton={event => activate(event, onChoose, event.detail?.is_repeat)}
      onSecondaryActionDescription={onToggle ? 'Toggle library' : undefined}
      onSecondaryButton={onToggle ? event => activate(event, onToggle, event.detail?.is_repeat) : undefined}
      onClick={event => activate(event, onToggle ?? onChoose)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') activate(event, event.key === ' ' ? onToggle ?? onChoose : onChoose, event.repeat);
      }}
      style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', padding: '0.65rem 0.8rem', minHeight: '2.6rem',
        flexShrink: 0, minWidth: 0, color: destructive ? 'var(--deckyplex-error, #ffb3b3)' : undefined,
        borderRadius: '0.5rem', border: '1px solid var(--deckyplex-border, rgba(255,255,255,0.14))',
        background: 'var(--deckyplex-button, rgba(255,255,255,0.06))',
        opacity: disabled ? 0.5 : 1 }}>
      <span aria-hidden="true" style={{ display: 'flex', flexShrink: 0, opacity: 0.65 }}>{icon}</span>
      <span data-deckyplex-choice-text="" style={{ flex: 1, minWidth: 0, display: 'grid', gap: '0.2rem', overflowWrap: 'anywhere' }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        {detail && <span style={{ fontSize: '0.82rem', opacity: 0.75 }}>{detail}</span>}
      </span>
      {badge && <span style={{ color: 'var(--deckyplex-accent, #b8ddff)', fontSize: '0.8rem', flexShrink: 0 }}>{badge}</span>}
    </Focusable>
  );
}
