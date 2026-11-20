import { useRef, useState } from 'react';
import { Button, GamepadButton } from '@decky/ui';
import { videoSeekStep } from './VideoQueue';

function formatTime(seconds: number) {
  const value = Math.floor(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60) % 60;
  const remainder = String(value % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

export function VideoScrubber({ position, duration, disabled, seek }: {
  position: number; duration: number; disabled?: boolean; seek: (position: number) => void;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const draft = useRef<number | null>(null);
  const start = useRef(0);
  const update = (value: number | null) => {
    draft.current = value === null ? null : Math.max(0, Math.min(duration, value));
    setPreview(draft.current);
  };
  const move = (direction: number) => update((draft.current ?? position) + direction * videoSeekStep(duration));
  const activate = () => {
    if (disabled) return;
    const target = draft.current;
    if (target === null) {
      start.current = position;
      update(position);
      return;
    }
    update(null);
    if (target !== start.current) seek(target);
  };
  const editing = preview !== null;
  const displayed = Math.max(0, Math.min(duration, preview ?? position));
  return <div data-video-scrubbing={editing || undefined} style={{ marginBottom: '0.45rem' }}
    onBlur={() => { if (draft.current !== null) update(null); }}
    onKeyDown={editing ? event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        move(event.key === 'ArrowLeft' ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        update(null);
      }
    } : undefined}>
    <Button onClick={activate} disabled={disabled}
      aria-label={`Playback position ${formatTime(displayed)} of ${formatTime(duration)}`}
      onOKActionDescription={editing ? 'Seek' : 'Choose position'}
      onCancelActionDescription={editing ? 'Cancel scrub' : undefined}
      onGamepadDirection={editing ? event => {
        const button = event.detail.button;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (button === GamepadButton.DIR_LEFT || button === GamepadButton.DIR_RIGHT) {
          move(button === GamepadButton.DIR_LEFT ? -1 : 1);
        }
      } : undefined}
      onCancelButton={editing ? event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        update(null);
      } : undefined}
      style={{ display: 'block', width: '100%', padding: '0.4rem 0.55rem', background: 'rgba(255,255,255,0.055)' }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', fontSize: '0.8rem', marginBottom: '0.35rem' }}>
        <span>{formatTime(displayed)}</span>
        <span style={{ opacity: 0.65 }}>{formatTime(duration)}</span>
      </span>
      <span onClick={editing ? event => {
        // A physical pointer can set the preview anywhere along the track.
        if (!event.detail) return;
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.width) update(duration * (event.clientX - bounds.left) / bounds.width);
      } : undefined} style={{ display: 'block', paddingBlock: '0.3rem' }}>
        <span style={{ display: 'block', height: 4, background: '#ffffff30', borderRadius: 3 }}>
          <span style={{ display: 'block', position: 'relative', height: '100%', width: `${100 * displayed / duration}%`,
            background: editing ? '#fff' : '#66c0f4', borderRadius: 3 }}>
            <span style={{ position: 'absolute', right: -3, top: -2, width: 8, height: 8,
              borderRadius: '50%', background: 'inherit' }} />
          </span>
        </span>
      </span>
    </Button>
  </div>;
}
