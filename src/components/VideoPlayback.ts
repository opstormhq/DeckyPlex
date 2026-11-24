import { useSyncExternalStore } from 'react';
import type { VideoItem, VideoResume } from './GamePip';

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
  suspend: () => VideoResume | null;
}

type PausedViewer = { restore: (resume: VideoResume) => boolean; discard: () => void };
interface VideoPlaybackStore {
  viewer: { owner: symbol; playback: ViewerPlayback } | null;
  pausedVideo: { owner: symbol; resume: VideoResume; duration: number; viewer?: PausedViewer } | null;
  resumeRequested: boolean;
  listeners: Set<() => void>;
}

// Decky's routed browser and Quick View can load separate copies in the same window.
const playbackWindow = window as Window & { __deckyPlexVideoPlayback?: VideoPlaybackStore };
const store = playbackWindow.__deckyPlexVideoPlayback ??= {
  viewer: null, pausedVideo: null, resumeRequested: false, listeners: new Set(),
};
export const resumePausedVideoEvent = 'deckyplex-resume-paused-video';

function publish() {
  store.listeners.forEach(listener => listener());
}

export function setViewerPlayback(owner: symbol, playback: ViewerPlayback | null) {
  if (playback && store.pausedVideo?.owner === owner && store.pausedVideo.viewer) return;
  if (!playback && store.viewer?.owner !== owner) return;
  store.viewer = playback ? { owner, playback } : null;
  publish();
}

export function suspendVideoPlayback(retainedViewer?: PausedViewer) {
  const active = store.viewer;
  const resume = active?.playback.suspend();
  if (!active || !resume) return false;
  store.pausedVideo = { owner: active.owner, resume, duration: active.playback.duration, viewer: retainedViewer };
  store.resumeRequested = false;
  if (retainedViewer) store.viewer = null;
  publish();
  return true;
}

export function refreshPausedViewer(owner: symbol) {
  if (store.pausedVideo?.owner !== owner || !store.pausedVideo.viewer) return;
  store.pausedVideo = { ...store.pausedVideo };
  publish();
}

export function updatePausedVideo(update: (resume: VideoResume) => VideoResume) {
  const paused = store.pausedVideo;
  if (!paused) return;
  store.pausedVideo = { ...paused, resume: update(paused.resume) };
  publish();
}

export function clearPausedVideo() {
  if (!store.pausedVideo) return;
  const retainedViewer = store.pausedVideo.viewer;
  store.pausedVideo = null;
  store.resumeRequested = false;
  retainedViewer?.discard();
  publish();
}

export function requestPausedVideo(playing: boolean) {
  if (!store.pausedVideo) return false;
  store.resumeRequested = true;
  updatePausedVideo(resume => ({ ...resume, playing }));
  return true;
}

export function takePausedVideo(serverId: string) {
  const paused = store.pausedVideo;
  if (!store.resumeRequested || paused?.resume.serverId !== serverId) return null;
  const { resume, viewer } = paused;
  store.resumeRequested = false;
  if (viewer?.restore(resume)) {
    store.pausedVideo = null;
    publish();
    return null;
  }
  store.pausedVideo = { ...paused, viewer: undefined };
  publish();
  return resume;
}

export function finishPausedVideoResume(resume: VideoResume) {
  if (store.pausedVideo?.resume === resume) clearPausedVideo();
}

function subscribe(listener: () => void) {
  store.listeners.add(listener);
  return () => { store.listeners.delete(listener); };
}

export function useViewerPlayback() {
  return useSyncExternalStore(subscribe, () => store.viewer?.playback ?? null);
}

export function usePausedVideo() {
  return useSyncExternalStore(subscribe, () => store.pausedVideo);
}
