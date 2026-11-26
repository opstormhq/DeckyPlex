import type { Ref } from 'react';
import { Focusable, GamepadButton, type GamepadEvent } from '@decky/ui';
import { FocusOutlineStyles, focusOutlineProps } from './FocusOutline';

export function PlaybackSlider({ label, value, min, max, step = 1, compact, disabled, sliderRef, onChange,
  confirmLabel, onConfirm, secondaryLabel, onSecondary }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  compact?: boolean;
  disabled?: boolean;
  sliderRef?: Ref<HTMLDivElement>;
  onChange: (value: number) => void;
  confirmLabel: string;
  onConfirm: () => void;
  secondaryLabel?: string;
  onSecondary?: (event: GamepadEvent) => void;
}) {
  const slide = (position: number) => {
    const next = Math.max(min, Math.min(max, position));
    if (!disabled && next !== value) onChange(next);
  };
  const confirm = (event: { preventDefault(): void; stopPropagation(): void }, repeat?: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    if (!disabled && !repeat) onConfirm();
  };
  const percent = (value - min) / (max - min) * 100;
  return <Focusable {...focusOutlineProps} ref={sliderRef} role="slider" tabIndex={disabled ? -1 : 0} aria-label={label}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value}%`}
    aria-disabled={disabled} {...{ focusable: !disabled }} onOKActionDescription={confirmLabel} onActivate={confirm}
    onOKButton={event => confirm(event, event.detail?.is_repeat)}
    onSecondaryActionDescription={secondaryLabel} onSecondaryButton={onSecondary}
    onGamepadDirection={event => {
      const button = event.detail.button;
      if (button !== GamepadButton.DIR_LEFT && button !== GamepadButton.DIR_RIGHT) return;
      event.preventDefault();
      event.stopPropagation();
      slide(value + (button === GamepadButton.DIR_LEFT ? -step : step));
    }}
    onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        slide(value + (event.key === 'ArrowLeft' ? -step : step));
      } else if (event.key === 'Enter' || event.key === ' ') confirm(event, event.repeat);
    }}
    style={{ color: 'var(--deckyplex-text, #f3f6fa)', background: 'var(--deckyplex-button, rgba(255,255,255,0.08))',
      ...(compact ? { display: 'flex', alignItems: 'center', gap: '0.55rem', height: '100%', boxSizing: 'border-box',
        padding: '0 0.65rem 0 0.8rem', borderRadius: 999 } : { padding: '0.8rem', borderRadius: '0.5rem' }) }}>
    <FocusOutlineStyles />
    {!compact && <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.35rem' }}>
      <span>{label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}%</span>
    </div>}
    <div aria-hidden="true" style={compact ? { flex: 1, minWidth: 0, paddingBlock: '0.65rem' } : { paddingBlock: '0.55rem' }} onClick={event => {
      const { left, width } = event.currentTarget.getBoundingClientRect();
      if (width) {
        event.stopPropagation();
        const fraction = Math.max(0, Math.min(1, (event.clientX - left) / width));
        slide(min + Math.round(fraction * (max - min) / step) * step);
      }
    }}>
      <div style={{ position: 'relative', height: 5, borderRadius: 5, background: 'var(--deckyplex-border, #61758a)' }}>
        <div style={{ width: `${percent}%`, height: '100%', background: 'var(--deckyplex-accent, #a4dbff)', borderRadius: 5 }} />
        <span style={{ position: 'absolute', left: `${percent}%`, top: '50%', transform: 'translate(-50%, -50%)',
          width: 12, height: 12, borderRadius: '50%', background: 'var(--deckyplex-accent, #a4dbff)' }} />
      </div>
    </div>
    {compact && <span aria-hidden="true" onClick={event => confirm(event)}
      style={{ minWidth: '3ch', textAlign: 'end', fontSize: '0.75rem', fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }}>
      {value}%
    </span>}
  </Focusable>;
}
