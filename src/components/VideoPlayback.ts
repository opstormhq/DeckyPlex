import { useSyncExternalStore } from 'react';
import type { VideoItem } from './GamePip';

export interface ViewerPlayback {
  item: VideoItem;
  episodes: VideoItem[];
  playing: boolean;
  busy: boolean;
  transferring: boolean;
  ready: boolean;
  error?: string;
  position: number;
  duration: number;
  volume: number;
  toggle: () => void;
  seek: (position: number) => void;
  setVolume: (volume: number) => void;
  stop: () => void;
  playEpisode: (itemId: string) => void;
  removeEpisode: (itemId: string) => void;
  expand?: () => void;
  popOut?: () => Promise<void>;
}

let viewer: { owner: symbol; playback: ViewerPlayback } | null = null;
const listeners = new Set<() => void>();

export function setViewerPlayback(owner: symbol, playback: ViewerPlayback | null) {
  if (!playback && viewer?.owner !== owner) return;
  viewer = playback ? { owner, playback } : null;
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useViewerPlayback() {
  return useSyncExternalStore(subscribe, () => viewer?.playback ?? null);
}
