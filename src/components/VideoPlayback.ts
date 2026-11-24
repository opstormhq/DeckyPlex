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

let viewer: { owner: symbol; playback: ViewerPlayback } | null = null;
let pausedVideo: { resume: VideoResume; duration: number } | null = null;
let resumeRequested = false;
const listeners = new Set<() => void>();
export const resumePausedVideoEvent = 'deckyplex-resume-paused-video';

function publish() {
  listeners.forEach(listener => listener());
}

export function setViewerPlayback(owner: symbol, playback: ViewerPlayback | null) {
  if (!playback && viewer?.owner !== owner) return;
  viewer = playback ? { owner, playback } : null;
  publish();
}

export function suspendVideoPlayback() {
  const active = viewer?.playback;
  const resume = active?.suspend();
  if (!active || !resume) return false;
  pausedVideo = { resume, duration: active.duration };
  resumeRequested = false;
  publish();
  return true;
}

export function updatePausedVideo(update: (resume: VideoResume) => VideoResume) {
  if (!pausedVideo) return;
  pausedVideo = { ...pausedVideo, resume: update(pausedVideo.resume) };
  publish();
}

export function clearPausedVideo() {
  if (!pausedVideo) return;
  pausedVideo = null;
  resumeRequested = false;
  publish();
}

export function requestPausedVideo(playing: boolean) {
  if (!pausedVideo) return false;
  resumeRequested = true;
  updatePausedVideo(resume => ({ ...resume, playing }));
  return true;
}

export function takePausedVideo(serverId: string) {
  if (!resumeRequested || pausedVideo?.resume.serverId !== serverId) return null;
  const resume = pausedVideo.resume;
  clearPausedVideo();
  return resume;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useViewerPlayback() {
  return useSyncExternalStore(subscribe, () => viewer?.playback ?? null);
}

export function usePausedVideo() {
  return useSyncExternalStore(subscribe, () => pausedVideo);
}
