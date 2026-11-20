import type { ReactNode, Ref } from 'react';
import { DialogBodyText, DialogHeader, Focusable } from '@decky/ui';
import { FocusOutlineStyles, focusOutlineProps } from './FocusOutline';

export function ChoiceDialogBody({ title, subtitle, bodyRef, children }: {
  title: string;
  subtitle?: string;
  bodyRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div ref={bodyRef} style={{ width: 'min(31rem, 78vw)', minHeight: '9rem' }}>
      <FocusOutlineStyles />
      <DialogHeader style={{ marginBottom: subtitle ? '0.35rem' : '0.8rem', overflowWrap: 'anywhere' }}>{title}</DialogHeader>
      {subtitle && <DialogBodyText style={{ margin: '0 0 0.6rem', overflowWrap: 'anywhere' }}>{subtitle}</DialogBodyText>}
      {children}
    </div>
  );
}

export function ChoiceDialogList({ children }: { children: ReactNode }) {
  const keepChoiceVisible = ({ Element: choice }: { Element?: HTMLElement }) => {
    const list = choice?.closest<HTMLElement>('[data-deckyplex-choice-list]');
    if (!choice || !list?.offsetHeight) return false;
    const bounds = list.getBoundingClientRect();
    const scale = bounds.height / list.offsetHeight;
    if (!scale) return false;
    const choiceBounds = choice.getBoundingClientRect();
    const top = (choiceBounds.top - bounds.top) / scale - list.clientTop;
    const bottom = (choiceBounds.bottom - bounds.top) / scale - list.clientTop;
    const padding = 6;
    if (top < padding) list.scrollTop += top - padding;
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
        maxHeight: '48vh', overflowY: 'auto', padding: '0.4rem', scrollPaddingBlock: '6px' }}>
      {children}
    </Focusable>
  );
}

export function ChoiceDialogRow({ title, detail, icon, badge, actionDescription = title, rowRef, preferredFocus, disabled, selected,
  destructive, onChoose }: {
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
}) {
  const activate = (event: { preventDefault(): void; stopPropagation(): void }, isRepeat = false) => {
    event.preventDefault();
    event.stopPropagation();
    if (!disabled && !isRepeat) onChoose();
  };
  return (
    <Focusable ref={rowRef} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-pressed={selected}
      {...focusOutlineProps} {...{ focusable: !disabled, preferredFocus }} onOKActionDescription={actionDescription}
      onActivate={activate}
      onOKButton={event => activate(event, event.detail?.is_repeat)}
      onClick={activate}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') activate(event, event.repeat); }}
      style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', padding: '0.65rem 0.8rem', minHeight: '2.6rem',
        flexShrink: 0, minWidth: 0, color: destructive ? '#ffb3b3' : undefined,
        borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)',
        opacity: disabled ? 0.5 : 1 }}>
      <span aria-hidden="true" style={{ display: 'flex', flexShrink: 0, opacity: 0.65 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: '0.2rem', overflowWrap: 'anywhere' }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        {detail && <span style={{ fontSize: '0.82rem', opacity: 0.75 }}>{detail}</span>}
      </span>
      {badge && <span style={{ color: '#b8ddff', fontSize: '0.8rem', flexShrink: 0 }}>{badge}</span>}
    </Focusable>
  );
}
