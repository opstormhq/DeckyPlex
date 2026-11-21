import { FaCheck } from 'react-icons/fa';

type WatchState = {
  type: string;
  leafCount?: number;
  viewedLeafCount?: number | null;
  viewCount?: number;
  viewOffset?: number;
  duration?: number;
};

export function VideoWatchIndicator({ item, compact }: { item: WatchState; compact?: boolean }) {
  const playable = item.type === 'movie' || item.type === 'episode';
  const collection = item.type === 'show' || item.type === 'season';
  const duration = item.duration ?? 0;
  const offset = item.viewOffset ?? 0;
  const progress = playable && duration > 0 && offset > 0 && offset < duration
    ? Math.max(1, Math.min(99, Math.round(offset / duration * 100))) : 0;
  const unwatched = collection && item.leafCount && item.viewedLeafCount != null
    ? Math.max(0, Math.min(item.leafCount, item.leafCount - item.viewedLeafCount)) : undefined;
  const watched = unwatched === 0 || (playable && !progress && !!item.viewCount);
  const label = watched ? 'Watched' : unwatched === 1 ? '1 unwatched episode'
    : unwatched != null ? `${unwatched} unwatched episodes` : '';
  return <>
    {label && <span role="img" aria-label={label} style={{ position: 'absolute', top: compact ? 2 : 5, right: compact ? 2 : 5,
      minWidth: compact ? 12 : 20, height: compact ? 12 : 20, paddingInline: compact ? 2 : 4, boxSizing: 'border-box',
      display: 'grid', placeItems: 'center', borderRadius: compact ? 2 : 4, background: 'rgba(0,0,0,0.78)',
      color: '#fff', fontSize: compact ? '0.55rem' : '0.72rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums',
      pointerEvents: 'none' }}>
      {watched ? <FaCheck aria-hidden="true" /> : unwatched}
    </span>}
    {progress > 0 && <span role="progressbar" aria-label="Watch progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
      style={{ position: 'absolute', inset: 'auto 0 0', height: compact ? 2 : 4, background: 'rgba(0,0,0,0.78)', pointerEvents: 'none' }}>
      <span style={{ display: 'block', width: `${progress}%`, height: '100%', background: '#ffc356' }} />
    </span>}
  </>;
}
