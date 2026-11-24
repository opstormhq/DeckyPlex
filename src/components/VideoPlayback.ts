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
type PausedViewer = { restore: (resume: VideoResume) => boolean; discard: () => void };
let pausedVideo: { resume: VideoResume; duration: number; viewer?: PausedViewer } | null = null;
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

export function suspendVideoPlayback(retainedViewer?: PausedViewer) {
  const active = viewer?.playback;
  const resume = active?.suspend();
  if (!active || !resume) return false;
  pausedVideo = { resume, duration: active.duration, viewer: retainedViewer };
  resumeRequested = false;
  if (retainedViewer) viewer = null;
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
  const retainedViewer = pausedVideo.viewer;
  pausedVideo = null;
  resumeRequested = false;
  retainedViewer?.discard();
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
  const { resume, viewer } = pausedVideo;
  resumeRequested = false;
  if (viewer?.restore(resume)) {
    pausedVideo = null;
    publish();
    return null;
  }
  pausedVideo = { ...pausedVideo, viewer: undefined };
  publish();
  return resume;
}

export function finishPausedVideoResume(resume: VideoResume) {
  if (pausedVideo?.resume === resume) clearPausedVideo();
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
