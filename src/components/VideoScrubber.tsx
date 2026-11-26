import { useEffect, useRef, useState } from 'react';
import { Button, GamepadButton } from '@decky/ui';
import { plexMediaUrl } from './PlexMediaUrl';
import { videoSeekStep } from './VideoQueue';

export function formatVideoTime(seconds: number) {
  const value = Math.floor(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60) % 60;
  const remainder = String(value % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

export function VideoScrubber({ position, duration, disabled, seek, previewUrl, localConnection, compact, steamStyle, overlay }: {
  position: number; duration: number; disabled?: boolean; seek: (position: number) => void; previewUrl?: string;
  localConnection?: boolean; compact?: boolean; steamStyle?: boolean; overlay?: boolean;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const [thumbnail, setThumbnail] = useState('');
  const [failedThumbnail, setFailedThumbnail] = useState('');
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
  const thumbnailTime = preview === null ? null : Math.floor(preview / 5) * 5000;
  useEffect(() => {
    if (!previewUrl || thumbnailTime === null) {
      setThumbnail('');
      return;
    }
    const timer = window.setTimeout(() => {
      const url = new URL(previewUrl);
      url.pathname += `/${thumbnailTime}`;
      setThumbnail(plexMediaUrl(url.href, localConnection));
    }, 140);
    return () => window.clearTimeout(timer);
  }, [previewUrl, thumbnailTime, localConnection]);
  const percent = duration > 0 ? 100 * displayed / duration : 0;
  return <div data-deckyplex-video-scrubber="" data-compact={compact || undefined} data-steam-style={steamStyle || undefined}
    data-video-overlay={overlay || undefined}
    data-video-scrubbing={editing || undefined}
    style={{ width: '100%', position: 'relative' }}
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
    <style>{`
      [data-deckyplex-video-scrubber] .deckyplex-video-position {
        box-shadow: inset 0 1px rgba(255,255,255,0.15), 0 2px 5px rgba(0,0,0,0.32) !important;
      }
      [data-deckyplex-video-scrubber] .deckyplex-video-position:not(:disabled, [aria-disabled="true"]):is(.gpfocus, :focus-visible) {
        outline: 2px solid #a0c9ef; outline-offset: -2px;
      }
      [data-deckyplex-video-scrubber] .deckyplex-video-position:is(:disabled, [aria-disabled="true"]) { opacity: 0.55; }
      [data-deckyplex-video-scrubber][data-steam-style] .deckyplex-video-position {
        background: rgba(255, 255, 255, 0.07);
        color: #dae5f2;
        --deckyplex-seek-rail: rgba(138, 159, 182, 0.65);
        --deckyplex-seek-fill: currentColor;
      }
      [data-deckyplex-video-scrubber]:not([data-steam-style]) .deckyplex-video-position {
        background: #283441 !important;
        color: #f3f6fa !important;
        --deckyplex-seek-rail: #5c6b7a;
        --deckyplex-seek-fill: #89d3ff;
      }
      [data-deckyplex-video-scrubber]:not([data-steam-style]) .deckyplex-video-position:is(:focus-visible, :active, .gpfocus),
      [data-video-scrubbing="true"]:not([data-steam-style]) .deckyplex-video-position {
        background: #e5edf5 !important;
        color: #172433 !important;
        --deckyplex-seek-rail: #a0aebc;
        --deckyplex-seek-fill: #20577b;
      }
      [data-deckyplex-video-scrubber][data-compact]:not([data-steam-style]) .deckyplex-video-position {
        background: transparent !important;
        color: #dae5f2 !important;
        --deckyplex-seek-rail: #52657b;
        --deckyplex-seek-fill: #9acfff;
      }
      [data-compact]:not([data-steam-style]) .deckyplex-video-position:is(:focus-visible, :active, .gpfocus),
      [data-compact][data-video-scrubbing="true"]:not([data-steam-style]) .deckyplex-video-position {
        background: #314760 !important;
        color: #fff !important;
        --deckyplex-seek-rail: #788c9f;
        --deckyplex-seek-fill: #bce0ff;
      }
      [data-deckyplex-video-scrubber][data-video-overlay] .deckyplex-video-position {
        background: transparent !important;
        color: #f1f5fa !important;
        --deckyplex-seek-rail: rgba(230, 239, 249, 0.36);
        --deckyplex-seek-fill: #a4dbff;
      }
      [data-deckyplex-video-scrubber][data-video-overlay] .deckyplex-video-position:is(:focus-visible, :active, .gpfocus),
      [data-deckyplex-video-scrubber][data-video-overlay][data-video-scrubbing="true"] .deckyplex-video-position {
        background: rgba(222, 239, 255, 0.15) !important;
        color: #fff !important;
        outline: 2px solid rgba(240, 248, 255, 0.88) !important;
        outline-offset: -2px;
        --deckyplex-seek-rail: rgba(230, 239, 249, 0.5);
        --deckyplex-seek-fill: #c2e8ff;
      }
      [data-deckyplex-light] [data-deckyplex-video-scrubber] .deckyplex-video-position {
        background: var(--deckyplex-button) !important;
        color: var(--deckyplex-text) !important;
        --deckyplex-seek-rail: var(--deckyplex-border);
        --deckyplex-seek-fill: var(--deckyplex-accent);
      }
      [data-deckyplex-light] [data-deckyplex-video-scrubber][data-video-overlay] .deckyplex-video-position {
        background: transparent !important;
      }
      [data-deckyplex-light] [data-deckyplex-video-scrubber] .deckyplex-video-position:is(:focus-visible, :active, .gpfocus),
      [data-deckyplex-light] [data-deckyplex-video-scrubber][data-video-scrubbing="true"] .deckyplex-video-position {
        background: var(--deckyplex-hover) !important;
        color: var(--deckyplex-focus-text) !important;
        outline: 2px solid var(--deckyplex-focus) !important;
        outline-offset: -2px;
      }
    `}</style>
    <Button className="deckyplex-video-position" noFocusRing disabled={disabled} focusable={!disabled}
      onClick={activate}
      aria-label={`Playback position ${formatVideoTime(displayed)} of ${formatVideoTime(duration)}`}
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
      style={{ display: 'block', width: '100%', padding: overlay ? '0.35rem 0.55rem' : '0.4rem 0.65rem',
        margin: overlay ? '0 0 0.5rem' : undefined, boxSizing: 'border-box', borderRadius: overlay ? 9 : 5 }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', fontSize: '0.8rem',
        fontVariantNumeric: 'tabular-nums', marginBottom: '0.15rem' }}>
        <span>{formatVideoTime(displayed)}</span>
        <span>{formatVideoTime(duration)}</span>
      </span>
      <span onClick={editing ? event => {
        // A physical pointer can set the preview anywhere along the track.
        if (!event.detail) return;
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.width) update(duration * (event.clientX - bounds.left) / bounds.width);
      } : undefined} style={{ display: 'block', paddingBlock: '0.3rem' }}>
        <span style={{ display: 'block', height: 4, background: 'var(--deckyplex-seek-rail)', borderRadius: 3 }}>
          <span style={{ display: 'block', position: 'relative', height: '100%', width: `${percent}%`,
            background: 'var(--deckyplex-seek-fill)', borderRadius: 3 }}>
            <span style={{ position: 'absolute', right: -4, top: -2, width: 8, height: 8,
              borderRadius: '50%', background: 'inherit', outline: editing ? '2px solid currentColor' : undefined }} />
          </span>
        </span>
      </span>
    </Button>
    {editing && thumbnail && thumbnail !== failedThumbnail && <img key={thumbnail} src={thumbnail} alt=""
      onError={() => setFailedThumbnail(thumbnail)}
      style={{ position: 'absolute', bottom: 'calc(100% + 0.45rem)', left: `clamp(80px, ${percent}%, 100% - 80px)`,
        transform: 'translateX(-50%)', width: 'min(160px, 100%)', aspectRatio: '16 / 9', objectFit: 'contain',
        background: '#0b0f15', border: '1px solid #556574', borderRadius: 5, pointerEvents: 'none' }} />}
  </div>;
}
