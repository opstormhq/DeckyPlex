import { plexMediaUrl } from './PlexMediaUrl';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { call, getExternalResourceURL, toaster } from '@decky/api';
import { Button, DialogBodyText, DialogLabel, Focusable, GamepadButton, Navigation, type GamepadEvent } from '@decky/ui';
import Hls, { type LoaderCallbacks, type LoaderConfiguration, type LoaderContext } from 'hls.js';
import { FaArrowLeft, FaClosedCaptioning, FaCog, FaCompress, FaExpand, FaEyeSlash,
  FaPause, FaPlay, FaRedo, FaStepForward, FaStop, FaVolumeMute, FaVolumeUp } from 'react-icons/fa';
import { MdForward10, MdPictureInPictureAlt, MdReplay10 } from 'react-icons/md';
import { ChoiceDialogBody, ChoiceDialogList, ChoiceDialogRow } from './ChoiceDialog';
import { InlineSpinner } from './InlineSpinner';
import { showPlaybackStartDialog } from './PlaybackStartDialog';
import { reportVideoProgress, startGamePip, type ActiveVideoHls, type VideoItem, type VideoResume } from './GamePip';
import { finishPausedVideoResume, refreshPausedViewer, setViewerPlayback, suspendVideoPlayback } from './VideoPlayback';
import { VideoScrubber } from './VideoScrubber';
import { episodeLabel, resumePosition } from './VideoQueue';
import { VideoPlayerOptions, type VideoChapter, type VideoMarker, type VideoOption, type VideoOptionPage } from './VideoPlayerOptions';

interface MediaStream extends Partial<ActiveVideoHls> {
  kind: 'direct' | 'hls' | 'http' | 'image';
  url: string;
  mode?: 'audio-conversion' | 'direct-stream';
  fallback_url?: string;
}

interface MediaSource {
  local_connection?: boolean;
  streams?: MediaStream[];
  resume_ms?: number;
  duration_ms?: number;
  server_id?: string;
  quality?: string;
  has_audio?: boolean;
  handoff_key?: string;
  media_index?: number;
  versions?: VideoOption[];
  audio_tracks?: VideoOption[];
  subtitle_tracks?: VideoOption[];
  audio_track?: number;
  subtitle_track?: number;
  video_codec?: string;
  audio_codec?: string;
  channels?: number;
  container?: string;
  bitrate?: number;
  chapters?: VideoChapter[];
  preview_url?: string;
  error?: string;
}

const mediaStyle: CSSProperties = {
  position: 'absolute', inset: 0, objectFit: 'contain', width: '100%', height: '100%',
};

const videoPlayerStyles = `
  .deckyplex-video-heading {
    position: absolute;
    inset: 0 0 auto;
    padding: clamp(1rem, 3vw, 2.5rem) clamp(1.25rem, 4vw, 3rem) 3rem;
    background: linear-gradient(rgba(0, 0, 0, 0.78), rgba(0, 0, 0, 0));
    pointer-events: none;
    color: #fff;
    text-shadow: 0 1px 4px #000;
  }
  .deckyplex-video-title {
    font-size: clamp(1.15rem, 2.3vw, 1.75rem);
    font-weight: 650;
    line-height: 1.2;
  }
  .deckyplex-video-title, .deckyplex-video-subtitle {
    max-width: min(48rem, 88vw);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .deckyplex-video-subtitle {
    margin-top: 0.25rem;
    font-size: 0.88rem;
    color: #e0e6ef;
  }
  .deckyplex-video-dock {
    position: absolute;
    z-index: 2;
    inset-inline: clamp(0.8rem, 3.25vw, 3rem);
    bottom: clamp(0.8rem, 2.8vh, 2rem);
    max-width: 60rem;
    margin-inline: auto;
    display: grid;
    gap: 0.7rem;
    pointer-events: none;
  }
  .deckyplex-video-dock > * { pointer-events: auto; }
  .deckyplex-video-glass {
    box-sizing: border-box;
    background: rgba(16, 20, 27, 0.87);
    border: 1px solid rgba(255, 255, 255, 0.19);
    border-radius: 1rem;
  }
  @supports (backdrop-filter: blur(8px)) {
    .deckyplex-video-glass {
      background: rgba(16, 20, 27, 0.76);
      backdrop-filter: blur(8px) saturate(1.15);
    }
  }
  .deckyplex-video-transport { padding: 0.6rem clamp(0.55rem, 1.7vw, 1rem) 0.7rem; }
  .deckyplex-video-buttons { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
  .deckyplex-video-dock > .deckyplex-video-marker { justify-self: end; }
  .deckyplex-video-control,
  .deckyplex-video-control::before,
  .deckyplex-video-control::after {
    box-shadow: none !important; text-shadow: none !important; filter: none !important;
  }
  button.deckyplex-video-control {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    margin: 0 !important;
    flex: none;
    width: auto;
    min-width: 40px;
    min-height: 40px;
    padding: 0.35rem 0.6rem;
    background: rgba(255, 255, 255, 0.10) !important;
    color: #f3f6fa !important;
    border: 1px solid rgba(255, 255, 255, 0.14) !important;
    border-radius: 999px;
    font-size: 0.85rem;
  }
  button.deckyplex-video-control[data-video-play] {
    min-width: 46px;
    min-height: 46px;
    background: rgba(218, 236, 255, 0.24) !important;
  }
  button.deckyplex-video-control[data-video-utility-start] { margin-inline-start: auto !important; }
  button.deckyplex-video-control[aria-pressed="true"] {
    border-color: #a4d9ff !important;
    color: #a4d9ff !important;
  }
  button.deckyplex-video-control:not(:disabled, .Disabled):hover {
    background: rgba(255, 255, 255, 0.20) !important;
  }
  button.deckyplex-video-control.deckyplex-video-marker {
    background: rgba(16, 20, 27, 0.82) !important;
  }
  button.deckyplex-video-control.deckyplex-video-marker:hover {
    background: rgba(38, 47, 60, 0.9) !important;
  }
  button.deckyplex-video-control:not(:disabled, .Disabled):is(.gpfocus, :focus-visible, :active) {
    background: #e9f2fc !important;
    color: #121e2e !important;
    outline: 2px solid #fff !important;
    outline-offset: 2px;
  }
  button.deckyplex-video-control:is(:disabled, .Disabled) { opacity: 0.45; }
  .deckyplex-video-control svg { flex-shrink: 0; vertical-align: middle; }
  .deckyplex-video-notice { margin: 0.5rem 0 0; color: #f1f5fa; font-size: 0.85rem; }
  @media (max-width: 540px) {
    .deckyplex-video-buttons { gap: 0.3rem; }
    button.deckyplex-video-control[data-video-utility-start] { margin-inline-start: 0 !important; }
  }
`;

export interface VideoPresentation {
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  controlsHidden: boolean;
}
const streamingQualities = [
  { label: 'Original when possible', data: 'auto' },
  { label: '1080p · 8 Mbps', data: '1080p' },
  { label: '720p · 4 Mbps', data: '720p' },
  { label: '480p · 1.5 Mbps', data: '480p' },
];

function plexHlsLoader(manifest: URL, proxy: boolean, localConnection: boolean, cachedManifest: string | undefined,
  rememberManifest: (text: string) => void) {
  const DefaultLoader = Hls.DefaultConfig.loader;
  return class PlexLoader extends DefaultLoader {
    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
      const upstream = new URL(context.url, manifest);
      if (cachedManifest && context.responseType === 'text' && upstream.href === manifest.href) {
        const now = performance.now();
        this.stats.loaded = this.stats.total = cachedManifest.length;
        this.stats.loading = { start: now, first: now, end: now };
        queueMicrotask(() => {
          if (this.stats.aborted) return;
          rememberManifest(cachedManifest);
          callbacks.onSuccess({ url: manifest.href, data: cachedManifest, code: 200 }, this.stats, context, null);
        });
        return;
      }
      if (upstream.origin !== manifest.origin || !upstream.pathname.startsWith('/video/:/transcode/')) {
        super.load(context, config, callbacks);
        return;
      }
      for (const name of ['X-Plex-Token', 'X-Plex-Client-Identifier', 'X-Plex-Session-Identifier']) {
        const value = manifest.searchParams.get(name);
        if (value && !upstream.searchParams.has(name)) upstream.searchParams.set(name, value);
      }
      const url = upstream.toString();
      const localUrl = plexMediaUrl(url, localConnection);
      const requestUrl = proxy && localUrl === url ? getExternalResourceURL(url) : localUrl;
      const proxied = requestUrl !== url;
      super.load({ ...context, url: requestUrl }, config, {
        ...callbacks,
        // hls.js resolves relative playlist and segment paths from the response URL.
        onSuccess: (response, stats, sourceContext, details) => {
          if (upstream.pathname === manifest.pathname && upstream.search === manifest.search
              && typeof response.data === 'string' && response.data.length <= 65536) {
            rememberManifest(response.data);
          }
          callbacks.onSuccess(proxied ? { ...response, url } : response, stats, proxied ? context : sourceContext, details);
        },
      });
    }
  };
}

export function MediaViewer({
  item, subtitle, photo, initialVolume, initialPlayback, initialPosition, initialPresentation, close, minimized, onMinimizedChange, episodes, episodeQueueReady,
  playEpisode, removeEpisode, onPlaying,
  overGamePip, autoplay = true,
}: {
  item: VideoItem;
  subtitle?: string;
  photo: boolean;
  initialVolume: number;
  initialPlayback?: VideoResume | null;
  initialPosition?: number;
  initialPresentation?: VideoPresentation | null;
  close: () => void;
  minimized: boolean;
  onMinimizedChange: (minimized: boolean, episodes?: VideoItem[]) => void;
  episodes: VideoItem[];
  episodeQueueReady: boolean;
  playEpisode: (itemId: string, presentation: VideoPresentation) => boolean;
  removeEpisode: (itemId: string) => void;
  onPlaying: () => void;
  overGamePip: boolean;
  autoplay?: boolean;
}) {
  const { id: itemId } = item;
  const title = episodeLabel(item);
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const hiddenControlsRef = useRef<HTMLDivElement>(null);
  const pauseChoiceRef = useRef<HTMLDivElement>(null);
  const nativeFullscreen = useRef<Promise<void> | null>(null);
  const restoreControlsFocus = useRef(false);
  const handoffManifest = useRef('');
  const closeRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLDivElement>(null);
  const captionsButtonRef = useRef<HTMLDivElement>(null);
  const upNextRef = useRef<HTMLDivElement>(null);
  const optionsOrigin = useRef<'settings' | 'captions' | null>(null);
  const offset = useRef(initialPlayback?.position ?? initialPosition ?? 0);
  const failedStreams = useRef<string[]>([]);
  const firstSource = useRef(true);
  const workingQuality = useRef('');
  const qualityAttempt = useRef<{ previous: string; requested: string; position: number } | null>(null);
  const versionAttempt = useRef<{ previous: number; position: number } | null>(null);
  const quickPlayerOwner = useRef(Symbol());
  const suspended = useRef(false);
  const retainedStreamFailed = useRef(false);
  const playAfterLoad = useRef(initialPlayback?.playing ?? true);
  const currentPlayback = useRef({ time: 0, duration: 0, started: false, playing: false, ended: false });
  const timeline = useRef(Promise.resolve());
  const reportPause = useRef(() => {});
  const handoff = useRef<AbortController | null>(null);
  const switchingEpisode = useRef(false);
  const startupRetried = useRef(false);
  const trackAttempt = useRef<{ kind: 'audio' | 'subtitle'; previous: number; serverId: string; mediaIndex: number; position: number } | null>(null);
  const retryTimer = useRef<number | undefined>(undefined);
  const hadNetworkFailure = useRef(false);
  const transferred = useRef(false);
  const onPlayingRef = useRef(onPlaying);
  onPlayingRef.current = onPlaying;
  const closeViewer = useRef(close);
  closeViewer.current = close;
  const minimizedRef = useRef(minimized);
  minimizedRef.current = minimized;
  const [media, setMedia] = useState<MediaSource | null>(null);
  const [playbackServerId, setPlaybackServerId] = useState(initialPlayback?.serverId ?? '');
  const [streamIndex, setStreamIndex] = useState(0);
  const [proxyHls, setProxyHls] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [requestedQuality, setRequestedQuality] = useState(initialPlayback?.quality ?? '');
  const [mediaIndex, setMediaIndex] = useState(initialPlayback?.mediaIndex ?? 0);
  const [fullscreen, setFullscreen] = useState(initialPresentation?.fullscreen ?? !!initialPlayback);
  const [controlsHidden, setControlsHidden] = useState(initialPresentation?.controlsHidden ?? !!initialPlayback);
  const [exitPromptOpen, setExitPromptOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [position, setPosition] = useState(offset.current);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(initialPresentation?.volume ?? initialPlayback?.volume ?? initialVolume);
  const [muted, setMuted] = useState(initialPresentation?.muted ?? initialPlayback?.muted ?? false);
  const [error, setError] = useState('');
  const [optionsPage, setOptionsPage] = useState<VideoOptionPage | null>(null);
  const [changingTrack, setChangingTrack] = useState(false);
  const trackChangePending = useRef(false);
  const [optionsError, setOptionsError] = useState('');
  const [markers, setMarkers] = useState<VideoMarker[]>([]);
  const [countdown, setCountdown] = useState<number>();
  const [upNextCanceled, setUpNextCanceled] = useState(false);
  const lastInteraction = useRef(0);
  const skipMarkerRef = useRef<HTMLDivElement>(null);
  const [pipLoading, setPipLoading] = useState(false);
  const [pipError, setPipError] = useState('');
  const [qualityNotice, setQualityNotice] = useState('');
  const [retryingStart, setRetryingStart] = useState(false);
  const [videoSize, setVideoSize] = useState('');

  const stream = media?.streams?.[streamIndex];
  const sourceName = stream?.manifest ? 'hls-active' : proxyHls ? 'hls-proxy' : stream?.mode === 'direct-stream' ? 'hls-copy'
    : stream?.mode === 'audio-conversion' ? 'hls-audio' : stream?.kind || 'source';
  const mediaDuration = (media?.duration_ms || 0) / 1000;
  const episodeIndex = episodes.findIndex(episode => episode.id === itemId);
  const next = episodeIndex >= 0 ? episodes[episodeIndex + 1] : undefined;
  const selectEpisode = (id: string) => {
    if (id === itemId || switchingEpisode.current || handoff.current || !episodes.some(episode => episode.id === id)) return;
    switchingEpisode.current = true;
    if (!playEpisode(id, { volume, muted, fullscreen, controlsHidden })) switchingEpisode.current = false;
  };
  const selectEpisodeRef = useRef(selectEpisode);
  selectEpisodeRef.current = selectEpisode;

  const nextId = next?.id;
  const showUpNext = !!(autoplay && ended && nextId && !minimized && !pipLoading && !upNextCanceled && !optionsPage && !exitPromptOpen);
  useEffect(() => {
    if (!showUpNext || !nextId || transferred.current) return;
    const deadline = Date.now() + 5000;
    setCountdown(5);
    upNextRef.current?.focus({ preventScroll: true });
    const timer = window.setInterval(() => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setCountdown(seconds);
      if (!seconds) {
        window.clearInterval(timer);
        selectEpisodeRef.current(nextId);
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [showUpNext, nextId]);

  const log = useCallback((quality: string, source: string, event: string, code = '') => {
    void call('log_video_event', itemId, quality, source, event, code).catch(() => {});
  }, [itemId]);

  const reload = useCallback(() => {
    failedStreams.current = [];
    hadNetworkFailure.current = false;
    setStreamIndex(0);
    setProxyHls(false);
    setMedia(null);
    setLoading(true);
    setError('');
    setRetryCount(value => value + 1);
  }, []);

  const failPlayback = useCallback((detail: string, retryable = false, localServer = false) => {
    const version = versionAttempt.current;
    if (version) {
      versionAttempt.current = null;
      offset.current = version.position;
      setMediaIndex(version.previous);
      setQualityNotice('Could not play that version. Returning to the previous version…');
      reload();
      return;
    }
    const attempt = qualityAttempt.current;
    if (attempt?.previous) {
      qualityAttempt.current = null;
      offset.current = attempt.position;
      setRequestedQuality(attempt.previous);
      setQualityNotice('Could not use that stream quality. Returning to the previous quality…');
      log(attempt.previous, 'source', 'quality-restored', attempt.requested);
      reload();
      return;
    }
    qualityAttempt.current = null;
    const changedTrack = trackAttempt.current;
    if (retryable && !startupRetried.current && (!currentPlayback.current.started || changedTrack)
        && (localServer || initialPlayback || item.type === 'episode')) {
      startupRetried.current = true;
      setRetryingStart(true);
      log(workingQuality.current || 'auto', 'source', 'waiting',
        localServer ? 'retry-local-startup' : initialPlayback ? 'retry-resume-startup' : 'retry-episode-startup');
      retryTimer.current = window.setTimeout(reload, localServer ? 1000 : 500);
      return;
    }
    if (changedTrack) {
      trackAttempt.current = null;
      setRetryingStart(false);
      setQualityNotice('Restoring the previous track…');
      void call<[string, string, number, string, number], { error?: string }>(
        'set_video_stream', itemId, changedTrack.serverId, changedTrack.mediaIndex, changedTrack.kind, changedTrack.previous,
      ).then(result => {
        if (!viewerRef.current) return;
        if (result.error) throw new Error(result.error);
        offset.current = changedTrack.position;
        setQualityNotice('');
        setOptionsError(changedTrack.kind === 'subtitle'
          ? 'Plex could not start with those captions. The previous selection was restored.'
          : 'Plex could not start with that audio track. The previous selection was restored.');
        reload();
      }).catch(() => {
        if (!viewerRef.current) return;
        setQualityNotice('');
        setLoading(false);
        setError(detail);
      });
      return;
    }
    setRetryingStart(false);
    setLoading(false);
    setError(detail);
  }, [initialPlayback, item.type, itemId, log, reload]);

  useEffect(() => () => window.clearTimeout(retryTimer.current), []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!fullscreen || minimized || !viewer) return;
    let active = true;
    const showFullscreen = () => {
      if (!active || document.fullscreenElement === viewer || typeof viewer.showPopover !== 'function') return;
      viewer.setAttribute('popover', 'manual');
      try {
        viewer.showPopover();
        (hiddenControlsRef.current ?? closeRef.current)?.focus({ preventScroll: true });
      } catch {
        viewer.removeAttribute('popover');
      }
    };
    if (nativeFullscreen.current) void nativeFullscreen.current.then(showFullscreen, showFullscreen);
    else showFullscreen();
    return () => {
      active = false;
      if (viewer.hasAttribute('popover')) {
        if (viewer.matches(':popover-open')) viewer.hidePopover();
        viewer.removeAttribute('popover');
      }
    };
  }, [fullscreen, minimized]);

  useEffect(() => {
    closeRef.current?.focus();
    const pauseForMusic = () => videoRef.current?.pause();
    window.addEventListener('deckyplex-local-music-playing', pauseForMusic);
    return () => {
      handoff.current?.abort();
      setViewerPlayback(quickPlayerOwner.current, null);
      window.removeEventListener('deckyplex-local-music-playing', pauseForMusic);
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    let ownedFullscreen = false;
    const onFullscreenChange = () => {
      if (document.fullscreenElement === viewer) {
        ownedFullscreen = true;
      } else if (ownedFullscreen) {
        ownedFullscreen = false;
        if (minimizedRef.current) return;
        restoreControlsFocus.current = true;
        setFullscreen(false);
        setControlsHidden(false);
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (document.fullscreenElement === viewer) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (minimized) return;
    const frame = window.requestAnimationFrame(() => {
      if (exitPromptOpen) pauseChoiceRef.current?.focus({ preventScroll: true });
      else if (controlsHidden) hiddenControlsRef.current?.focus({ preventScroll: true });
      else if (restoreControlsFocus.current) {
        restoreControlsFocus.current = false;
        (playRef.current ?? fullscreenRef.current ?? closeRef.current)?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [controlsHidden, fullscreen, exitPromptOpen, minimized]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const ownerDocument = viewer?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!minimized || !viewer || !ownerDocument || !ownerWindow) return;
    let frame = 0;
    const refreshQuickPlayer = () => {
      if (ownerDocument.fullscreenElement === viewer) return;
      ownerWindow.cancelAnimationFrame(frame);
      frame = ownerWindow.requestAnimationFrame(() => refreshPausedViewer(quickPlayerOwner.current));
    };
    ownerDocument.addEventListener('fullscreenchange', refreshQuickPlayer);
    refreshQuickPlayer();
    return () => {
      ownerDocument.removeEventListener('fullscreenchange', refreshQuickPlayer);
      ownerWindow.cancelAnimationFrame(frame);
    };
  }, [minimized]);

  useEffect(() => {
    let active = true;
    let startDialog: ReturnType<typeof showPlaybackStartDialog> | undefined;
    const applySource = (result: MediaSource, startPosition?: number) => {
      const length = (result.duration_ms || 0) / 1000;
      setDuration(length);
      currentPlayback.current.duration = length;
      if (firstSource.current) {
        firstSource.current = false;
        if (!initialPlayback && initialPosition === undefined && !photo) {
          offset.current = startPosition ?? resumePosition(result.resume_ms || 0, result.duration_ms || 0);
        }
        setPosition(offset.current);
        if (!photo) setFullscreen(true);
      }
      if (result.server_id) setPlaybackServerId(result.server_id);
      setMedia(result);
    };
    setLoading(true);
    void call<[string, string, number], MediaSource>('get_media_source', itemId, requestedQuality, mediaIndex)
      .then(result => {
        if (!active) return;
        if (!result?.streams?.length) throw new Error('Plex could not prepare this item for playback.');
        const activeHls = firstSource.current ? initialPlayback?.activeHls : undefined;
        if (activeHls && result.server_id === initialPlayback?.serverId && result.quality === initialPlayback?.quality) {
          const saved = new URL(activeHls.url);
          const sameConnection = result.streams.some(candidate => {
            if (candidate.kind !== 'hls') return false;
            const fresh = new URL(candidate.url);
            return saved.origin === fresh.origin
              && saved.searchParams.get('X-Plex-Token') === fresh.searchParams.get('X-Plex-Token');
          });
          if (sameConnection) result = { ...result, streams: [{ kind: 'hls', ...activeHls }, ...result.streams] };
        }
        const episode = item.type === 'episode';
        const offerResume = firstSource.current && (item.type === 'movie' || episode) && !initialPlayback
          && !initialPresentation && initialPosition === undefined;
        const savedPosition = offerResume
          ? resumePosition(result.resume_ms ?? item.viewOffset ?? 0, result.duration_ms || item.duration || 0, 1) : 0;
        if (!savedPosition) {
          applySource(result);
          return;
        }
        log(result.quality || 'auto', 'source', 'waiting', episode ? 'episode-start-choice' : 'movie-start-choice');
        startDialog = showPlaybackStartDialog({
          title,
          actionTitle: episode ? 'Play episode' : 'Play movie',
          position: savedPosition,
          onClose: choice => {
            if (!active) return;
            if (choice) applySource(result, choice === 'resume' ? savedPosition : 0);
            else closeViewer.current();
          },
        });
      })
      .catch(() => {
        if (!active) return;
        log(requestedQuality || 'auto', 'source', 'failed', 'source-request');
        failPlayback('Plex could not prepare this item for playback.', true);
      });
    return () => {
      active = false;
      startDialog?.Close();
    };
  }, [itemId, item.type, item.duration, item.viewOffset, title, photo, retryCount, requestedQuality, mediaIndex,
    initialPlayback, initialPosition, initialPresentation, failPlayback, log]);

  useEffect(() => {
    if (photo || !playbackServerId) return;
    let active = true;
    void call<[string, string], VideoMarker[]>('get_video_skip_markers', itemId, playbackServerId).then(result => {
      if (active) setMarkers(Array.isArray(result) ? result : []);
    }).catch(() => {});
    return () => { active = false; };
  }, [itemId, playbackServerId, photo]);

  useEffect(() => {
    if (!stream || minimized) return;
    const frame = window.requestAnimationFrame(() => {
      if (document.activeElement === closeRef.current || document.activeElement === document.body) {
        playRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [stream, minimized]);

  useEffect(() => {
    if (photo || !playbackServerId) return;
    const report = (state: 'playing' | 'paused' | 'stopped') => {
      const playback = currentPlayback.current;
      if (transferred.current || !playback.started || playback.ended || playback.time < 1) return;
      const time = Math.round(playback.time * 1000);
      const length = Math.round(playback.duration * 1000);
      timeline.current = timeline.current.then(() => reportVideoProgress(itemId, playbackServerId, time, length, state)).catch(() => {});
    };
    const timer = window.setInterval(() => {
      if (currentPlayback.current.playing) report('playing');
    }, 10000);
    const video = videoRef.current;
    reportPause.current = () => report('paused');
    const onPause = () => { if (!suspended.current) report('paused'); };
    const onEnded = () => {
      currentPlayback.current.time = currentPlayback.current.duration || currentPlayback.current.time;
      report('stopped');
      currentPlayback.current.ended = true;
    };
    video?.addEventListener('pause', onPause);
    video?.addEventListener('ended', onEnded);
    return () => {
      window.clearInterval(timer);
      video?.removeEventListener('pause', onPause);
      video?.removeEventListener('ended', onEnded);
      reportPause.current = () => {};
      if (!suspended.current) report('stopped');
    };
  }, [itemId, playbackServerId, photo]);

  useEffect(() => {
    if (photo || !stream) return;
    const video = videoRef.current;
    if (!video) return;
    handoffManifest.current = '';

    let active = true;
    let succeeded = false;
    let failed = false;
    let starting = false;
    let checkedAudio = false;
    let sought = false;
    let hls: Hls | null = null;
    const initialPosition = offset.current;
    const quality = media?.quality || requestedQuality || 'auto';
    const source = sourceName;
    let startupStage = stream.kind === 'hls' ? 'manifest' : 'metadata';
    log(quality, source, 'attempt', initialPosition > 0 ? 'resume' : 'from-start');
    setLoading(true);
    setBuffering(false);
    setPlaying(false);
    setError('');
    setVideoSize('');
    const fail = (detail: string, code: string, network = false) => {
      if (!active || failed) return;
      failed = true;
      log(quality, source, 'failed', code);
      if (minimizedRef.current) {
        retainedStreamFailed.current = true;
        return;
      }
      failedStreams.current.push(detail);
      hadNetworkFailure.current ||= network;
      offset.current = succeeded ? video.currentTime || initialPosition : initialPosition;
      if (network && stream.fallback_url && !proxyHls) {
        setProxyHls(true);
      } else if (media?.streams?.[streamIndex + 1]) {
        setProxyHls(false);
        setStreamIndex(streamIndex + 1);
      } else {
        failPlayback(`Video could not play. ${[...new Set(failedStreams.current)].join(' ')}`, hadNetworkFailure.current, media?.local_connection);
      }
      video.pause();
    };
    let timeout = 0;
    const startTimer = (ms: number) => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => fail('The stream took too long to start.', `startup-timeout-${startupStage}`, true), ms);
    };
    const onError = () => fail(video.error?.code ? `Steam video error ${video.error.code}.` : 'Steam could not decode the stream.',
      `media-error-${video.error?.code || 0}`);
    const targetPosition = () => Number.isFinite(video.duration)
      ? Math.min(initialPosition, Math.max(0, video.duration - 0.1)) : initialPosition;
    const onMetadata = () => {
      startupStage = 'buffer';
      // HLS.js already seeks to its configured start position when it appends the starting fragment.
      if (!hls && initialPosition > 0) {
        sought = true;
        video.currentTime = targetPosition();
      }
    };
    const onCanPlay = async () => {
      if (!active || failed || video.seeking || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
      if (succeeded) {
        setLoading(false);
        return;
      }
      if (starting) return;
      const target = targetPosition();
      const distance = Math.abs(video.currentTime - target);
      if (target > 0 && distance > 2) {
        if (!sought && Array.from({ length: video.seekable.length }, (_, index) => index)
          .some(index => video.seekable.start(index) <= target && target < video.seekable.end(index))) {
          sought = true;
          video.currentTime = target;
          return;
        }
        // HLS can start on a nearby keyframe before the exact seek target is buffered.
        if (!hls || distance > (hls.levels[hls.currentLevel]?.details?.targetduration || 2)) return;
      }
      starting = true;
      if (playAfterLoad.current && video.paused) {
        try {
          await video.play();
        } catch (error) {
          if (!active || failed) return;
          const name = error instanceof DOMException ? error.name : 'play-failed';
          log(quality, source, 'autoplay', name);
          if (name !== 'NotAllowedError') {
            fail('Steam could not start the video.', name);
            return;
          }
        }
      }
      if (!active || failed) return;
      succeeded = true;
      window.clearTimeout(timeout);
      setLoading(false);
      if (initialPlayback) finishPausedVideoResume(initialPlayback);
      setRetryingStart(false);
      trackAttempt.current = null;
      workingQuality.current = quality;
      versionAttempt.current = null;
      log(quality, source, 'ready', video.videoWidth && video.videoHeight ? `${video.videoWidth}x${video.videoHeight}` : '');
      if (qualityAttempt.current?.requested === quality) {
        qualityAttempt.current = null;
        void call('set_settings', { video_quality: quality }).catch(() => {});
      } else {
        setQualityNotice(message => message ? 'Restored the previous stream quality.' : '');
      }
    };
    const checkAudio = () => {
      if (checkedAudio || !succeeded || stream.kind !== 'direct' || !media?.has_audio || video.muted
          || !video.volume || video.currentTime - initialPosition < 4) return;
      checkedAudio = true;
      // Chromium exposes this counter on builds that can report decoded audio.
      const bytes = (video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount;
      if (bytes === 0) fail('The original stream did not decode audio.', 'direct-no-decoded-audio');
    };
    video.addEventListener('error', onError);
    video.addEventListener('loadedmetadata', onMetadata, { once: true });
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('seeked', onCanPlay);
    video.addEventListener('timeupdate', checkAudio);

    const url = (proxyHls && stream.fallback_url) || stream.url;
    let loadStarted = false;
    const load = () => {
      if (!active || failed || loadStarted) return;
      loadStarted = true;
      startTimer(stream.kind === 'hls' ? 10000 : 15000);
      if (stream.kind === 'hls' && Hls.isSupported()) {
        const manifest = new URL(url);
        hls = new Hls({
          enableWorker: false,
          startPosition: initialPosition,
          loader: plexHlsLoader(manifest, proxyHls || stream.proxy === true, media?.local_connection === true, stream.manifest, text => {
            if (active) handoffManifest.current = text;
          }),
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!active || failed || succeeded) return;
          startupStage = 'segments';
          startTimer(stream.mode || qualityAttempt.current ? 12000 : 20000);
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          const status = data.response?.code || 0;
          const network = data.type === Hls.ErrorTypes.NETWORK_ERROR;
          fail(`Plex HLS: ${data.details}${status ? ` (HTTP ${status})` : ''}.`,
            `${data.details}${status ? `:${status}` : ''}`,
            network && (!media?.local_connection || ![401, 403, 404].includes(status)));
        });
        hls.loadSource(manifest.href);
        hls.attachMedia(video);
      } else if (stream.kind === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
        fail('HLS is unavailable in this Steam webview.', 'hls-unavailable');
      } else {
        video.src = plexMediaUrl(url, media?.local_connection);
        video.load();
      }
    };
    const resumedEpisode = item.type === 'episode' && initialPosition > 0;
    const session = (media?.local_connection || resumedEpisode || proxyHls) && !stream.manifest
      && (stream.kind === 'hls' || stream.kind === 'http')
      ? new URL(url).searchParams.get('transcodeSessionId') : null;
    if (session && media?.handoff_key) {
      // Keep playing even on older PMS versions that don't answer the decision endpoint.
      timeout = window.setTimeout(load, 2000);
      void call('prepare_video_transcode', media.handoff_key, session).then(load, load);
    } else {
      load();
    }

    return () => {
      active = false;
      window.clearTimeout(timeout);
      video.removeEventListener('error', onError);
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('seeked', onCanPlay);
      video.removeEventListener('timeupdate', checkAudio);
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [photo, media, stream, streamIndex, proxyHls, sourceName, requestedQuality, initialPlayback, item.type, log, failPlayback]);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.volume = Math.max(0, Math.min(1, volume / 100));
    videoRef.current.muted = muted;
  }, [volume, muted]);

  const capturePlayback = () => {
    const video = videoRef.current;
    if (loading || !video || handoff.current) return false;
    if (!error) playAfterLoad.current = !video.paused && !video.ended;
    offset.current = error ? offset.current : video.currentTime;
    return true;
  };

  const changeQuality = (quality: string) => {
    if (quality === (media?.quality || requestedQuality || 'auto') || !capturePlayback()) return;
    qualityAttempt.current = { previous: workingQuality.current, requested: quality, position: offset.current };
    setQualityNotice('');
    setRequestedQuality(quality);
    reload();
  };

  const changeVersion = (version: number) => {
    if (version === mediaIndex || !capturePlayback()) return;
    versionAttempt.current = { previous: mediaIndex, position: offset.current };
    setQualityNotice('');
    setMediaIndex(version);
    reload();
  };

  const changeTrack = async (kind: 'audio' | 'subtitle', track: number) => {
    if (trackChangePending.current || !media?.server_id || loading || handoff.current) return;
    trackChangePending.current = true;
    setChangingTrack(true);
    setOptionsError('');
    try {
      const result = await call<[string, string, number, string, number], { error?: string }>(
        'set_video_stream', itemId, media.server_id, mediaIndex, kind, track,
      );
      if (result.error) throw new Error(result.error);
      if (capturePlayback()) {
        const previous = kind === 'subtitle' ? media.subtitle_track ?? 0 : media.audio_track;
        if (media.local_connection && previous != null && track !== previous) {
          trackAttempt.current = { kind, previous, serverId: media.server_id, mediaIndex, position: offset.current };
          startupRetried.current = false;
        }
        setQualityNotice('');
        reload();
      }
    } catch (error) {
      setOptionsError(error instanceof Error ? error.message : 'Could not change the Plex track.');
    } finally {
      trackChangePending.current = false;
      setChangingTrack(false);
    }
  };

  const seek = (target: number) => {
    const video = videoRef.current;
    if (!video || !duration || error) return;
    const time = Math.max(0, Math.min(target, duration));
    video.currentTime = time;
    setPosition(time);
  };

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video || error) return;
    suspended.current = false;
    playAfterLoad.current = video.paused;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };

  const revealControls = () => {
    lastInteraction.current = Date.now();
    restoreControlsFocus.current = true;
    setControlsHidden(false);
  };

  const cancelUpNext = () => {
    setUpNextCanceled(true);
    revealControls();
    window.requestAnimationFrame(() => (playRef.current ?? closeRef.current)?.focus({ preventScroll: true }));
  };

  const openOptions = (page: VideoOptionPage, origin: 'settings' | 'captions') => {
    optionsOrigin.current = origin;
    setOptionsError('');
    setOptionsPage(page);
  };

  const backFromOptions = () => {
    if (trackChangePending.current) return;
    if (optionsPage !== 'main' && optionsOrigin.current === 'settings') {
      setOptionsPage('main');
      return;
    }
    const origin = optionsOrigin.current;
    optionsOrigin.current = null;
    lastInteraction.current = Date.now();
    setOptionsPage(null);
    window.requestAnimationFrame(() => (origin === 'captions' ? captionsButtonRef : settingsButtonRef).current?.focus());
  };

  const leaveFullscreen = () => {
    nativeFullscreen.current = null;
    revealControls();
    setFullscreen(false);
    const viewer = viewerRef.current;
    if (viewer && document.fullscreenElement === viewer) void document.exitFullscreen().catch(() => {});
  };

  const enterFullscreen = (fromQuickPlayer = false) => {
    const viewer = viewerRef.current;
    // Steam's side menu opens a separate focus context. The top layer takes over after it closes.
    nativeFullscreen.current = fromQuickPlayer ? null : viewer?.requestFullscreen?.() ?? null;
    setFullscreen(true);
    setControlsHidden(true);
  };

  const activeHlsStream = (): ActiveVideoHls | undefined => {
    const key = stream?.handoff_key ?? media?.handoff_key;
    const manifest = handoffManifest.current;
    if (stream?.kind !== 'hls' || !key || !manifest) return;
    return {
      url: (proxyHls && stream.fallback_url) || stream.url, manifest, handoff_key: key,
      proxy: proxyHls || stream.proxy,
      handoff_source: stream.handoff_source ?? (stream.manifest ? 'hls' : sourceName),
    };
  };

  const playOverGame = async (fromQuickPlayer = false) => {
    const video = videoRef.current;
    if (!overGamePip || !video || !media?.server_id || handoff.current || loading || error) return;
    setPipLoading(true);
    setPipError('');
    const attempt = new AbortController();
    handoff.current = attempt;
    try {
      const activeHls = activeHlsStream();
      const reuse = activeHls ? { key: activeHls.handoff_key, manifest: activeHls.manifest } : undefined;
      await startGamePip({
        item, serverId: media.server_id, quality: media.quality || 'auto',
        position: video.currentTime, volume, muted, episodes: episodeQueueReady ? episodes : undefined,
        preferredSource: activeHls?.handoff_source ?? sourceName, mediaIndex,
        reuse,
      }, attempt.signal, () => ({ position: video.currentTime, playing: !video.paused && !video.ended }));
      if (attempt.signal.aborted) return;
      transferred.current = true;
      video.pause();
      close();
    } catch (error) {
      if (!attempt.signal.aborted) {
        const message = error instanceof Error ? error.message : 'Could not open the over-game video.';
        if (fromQuickPlayer) void toaster.toast({ title: 'DeckyPlex', body: message });
        else setPipError(message);
      }
    } finally {
      handoff.current = null;
      if (!transferred.current) setPipLoading(false);
    }
  };

  const promptOnBack = fullscreen && !photo && !!stream && !loading && !error && !ended && !pipLoading;
  const pauseToQuickPlayer = () => {
    if (!suspendVideoPlayback({
      restore: resume => {
        const video = videoRef.current;
        if (!viewerRef.current || !video || video.error || !video.readyState || retainedStreamFailed.current
          || resume.item.id !== itemId || resume.mediaIndex !== mediaIndex) return false;
        if (Math.abs(video.currentTime - resume.position) > 0.1) video.currentTime = resume.position;
        suspended.current = false;
        playAfterLoad.current = resume.playing;
        currentPlayback.current.time = resume.position;
        setPosition(resume.position);
        setVolume(resume.volume);
        setMuted(resume.muted);
        setFullscreen(true);
        setControlsHidden(resume.playing);
        restoreControlsFocus.current = !resume.playing;
        onMinimizedChange(false, resume.episodes);
        if (resume.playing) void video.play().catch(revealControls);
        log(resume.quality, 'source', 'ready', 'resumed-retained-viewer');
        return true;
      },
      discard: () => {
        if (!viewerRef.current) return;
        suspended.current = false;
        closeViewer.current();
      },
    })) return;
    setExitPromptOpen(false);
    retainedStreamFailed.current = false;
    log(media?.quality || 'auto', 'source', 'ready', 'paused-in-quick-player');
    onMinimizedChange(true);
    const ownerDocument = viewerRef.current?.ownerDocument;
    if (ownerDocument && ownerDocument.fullscreenElement === viewerRef.current) void ownerDocument.exitFullscreen().catch(() => {});
  };
  const handleBack = (event: Event) => {
    if (minimized) return;
    if (!exitPromptOpen && document.activeElement?.closest('[data-video-scrubbing]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if ((event as GamepadEvent).detail?.is_repeat || (event as KeyboardEvent).repeat) return;
    if (exitPromptOpen) {
      restoreControlsFocus.current = !controlsHidden;
      setExitPromptOpen(false);
    } else if (optionsPage) backFromOptions();
    else if (showUpNext) cancelUpNext();
    else if (promptOnBack) {
      if (controlsHidden) setExitPromptOpen(true);
      else setControlsHidden(true);
    }
    else if (controlsHidden) revealControls();
    else if (fullscreen && photo) leaveFullscreen();
    else close();
  };

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && viewerRef.current?.contains(document.activeElement)) handleBack(event);
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  });

  useEffect(() => {
    if (error && controlsHidden) revealControls();
  }, [error, controlsHidden]);

  const canControl = !photo && !!stream && !loading && !error;
  const canFullscreen = !!stream && !error;
  const showControls = !controlsHidden && !exitPromptOpen;
  const activeMarker = canControl && !mediaIndex && !optionsPage
    ? markers.find(marker => position >= marker.start && position < marker.end - 0.35) : undefined;
  const sourceLabel = stream?.kind === 'direct' ? 'Direct Play'
    : stream?.mode === 'direct-stream' ? 'Direct Stream'
    : stream?.mode === 'audio-conversion' ? 'Direct video · audio conversion' : 'Video transcode';
  const playbackInfo = [
    stream && [sourceLabel, videoSize].filter(Boolean).join(' · '),
    media && [media.container?.toUpperCase(), media.video_codec?.toUpperCase(), media.audio_codec?.toUpperCase(),
      media.channels && `${media.channels} source audio channels`].filter(Boolean).join(' · '),
    media?.bitrate ? `${(media.bitrate / 1000).toFixed(1)} Mbps source bitrate` : '',
    media?.subtitle_track ? 'Captions rendered by Plex' : '',
  ].filter((line): line is string => !!line);

  useEffect(() => {
    if (!fullscreen || minimized || photo || !playing || loading || controlsHidden || optionsPage || showUpNext || pipLoading || exitPromptOpen) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    lastInteraction.current = Date.now();
    const timer = window.setInterval(() => {
      const document = viewer.ownerDocument;
      const focus = document.activeElement;
      if (!viewer.contains(focus) || focus?.closest('[data-video-scrubbing="true"]')) {
        lastInteraction.current = Date.now();
      } else if (Date.now() - lastInteraction.current >= 4000) {
        setControlsHidden(true);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [fullscreen, minimized, photo, playing, loading, controlsHidden, optionsPage, showUpNext, pipLoading, exitPromptOpen]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const onActivity = (event: Event) => {
      lastInteraction.current = Date.now();
      if (!controlsHidden || showUpNext || exitPromptOpen) return;
      const key = (event as KeyboardEvent).key;
      const gamepad = (event as GamepadEvent).detail;
      if (key === 'Escape') return;
      if (activeMarker && skipMarkerRef.current?.contains(event.target as Node | null)
          && (gamepad?.button === GamepadButton.OK || key === 'Enter' || key === ' ')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (gamepad?.is_repeat || (event as KeyboardEvent).repeat) return;
      if (promptOnBack && gamepad?.button === GamepadButton.CANCEL) setExitPromptOpen(true);
      else revealControls();
    };
    const onPointerMove = () => {
      lastInteraction.current = Date.now();
      if (controlsHidden && !showUpNext && !exitPromptOpen) revealControls();
    };
    viewer.addEventListener('vgp_onbuttondown', onActivity, true);
    viewer.addEventListener('keydown', onActivity, true);
    viewer.addEventListener('pointermove', onPointerMove);
    return () => {
      viewer.removeEventListener('vgp_onbuttondown', onActivity, true);
      viewer.removeEventListener('keydown', onActivity, true);
      viewer.removeEventListener('pointermove', onPointerMove);
    };
  }, [controlsHidden, showUpNext, activeMarker, exitPromptOpen, promptOnBack]);

  useEffect(() => {
    if (!controlsHidden || minimized || showUpNext || exitPromptOpen) return;
    const document = viewerRef.current?.ownerDocument;
    if (activeMarker && document?.activeElement === hiddenControlsRef.current) skipMarkerRef.current?.focus({ preventScroll: true });
    else if (!activeMarker && document?.activeElement === document?.body) hiddenControlsRef.current?.focus({ preventScroll: true });
  }, [activeMarker, controlsHidden, minimized, showUpNext, exitPromptOpen]);

  useEffect(() => {
    if (photo || transferred.current) return;
    if (minimized) {
      setViewerPlayback(quickPlayerOwner.current, null);
      return;
    }
    setViewerPlayback(quickPlayerOwner.current, {
      item, episodes, playing, busy: loading || buffering || pipLoading, transferring: pipLoading, ready: canControl, error, position, duration, volume,
      toggle: togglePlayback, seek,
      setVolume: value => {
        setVolume(value);
        if (value > 0) setMuted(false);
      },
      stop: () => {
        if (initialPlayback) finishPausedVideoResume(initialPlayback);
        close();
      },
      playEpisode: selectEpisode, removeEpisode,
      suspend: () => {
        if (!playbackServerId || handoff.current) return null;
        const video = videoRef.current;
        const savedPosition = video && (currentPlayback.current.started || canControl) ? video.currentTime : offset.current;
        suspended.current = true;
        currentPlayback.current.time = savedPosition;
        currentPlayback.current.playing = false;
        playAfterLoad.current = false;
        video?.pause();
        setPlaying(false);
        reportPause.current();
        return { item, episodes, serverId: playbackServerId, playing: false, position: savedPosition,
          quality: requestedQuality || media?.quality || 'auto', volume, muted, mediaIndex,
          activeHls: !loading && !error ? activeHlsStream() : undefined };
      },
      popOut: overGamePip ? () => playOverGame(true) : undefined,
      expand: !fullscreen ? () => {
        Navigation.CloseSideMenus();
        enterFullscreen(true);
      } : undefined,
    });
  });

  return (
    <Focusable ref={viewerRef} flow-children="geometric" onCancel={handleBack} inert={minimized}
      onCancelActionDescription={!controlsHidden && promptOnBack && !optionsPage && !showUpNext ? 'Hide controls' : undefined}
      style={{ ...(fullscreen
        ? { position: 'fixed', inset: 0, width: '100vw', height: '100vh', zIndex: 1000,
            margin: 0, padding: 0, border: 0, maxWidth: 'none', maxHeight: 'none' }
        : { position: 'relative', width: '100%', height: 'calc(100% - 40px)', marginTop: '40px' }),
        display: minimized ? 'none' : undefined, background: '#000', color: '#f3f6fa', overflow: 'hidden' }}>
      <style>{videoPlayerStyles}</style>
      {photo ? (stream && <img src={plexMediaUrl(stream.url, media?.local_connection)} alt={title} style={mediaStyle}
        onLoad={() => setLoading(false)} onError={() => {
          if (media?.streams?.[streamIndex + 1]) setStreamIndex(streamIndex + 1);
          else { setLoading(false); setError('Plex could not display this photo.'); }
        }} />) : (
        <video ref={videoRef} playsInline style={mediaStyle}
          onResize={({ currentTarget }) => {
            if (currentTarget.videoWidth && currentTarget.videoHeight) {
              setVideoSize(`${currentTarget.videoWidth} × ${currentTarget.videoHeight}`);
            }
          }}
          onWaiting={() => setBuffering(true)}
          onCanPlay={() => setBuffering(false)}
          onSeeked={() => setBuffering(false)}
          onPlaying={() => {
            setEnded(false);
            setUpNextCanceled(false);
            currentPlayback.current.ended = false;
            currentPlayback.current.started = true;
            currentPlayback.current.playing = true;
            setLoading(false);
            setBuffering(false);
            setPlaying(true);
            onPlayingRef.current();
          }}
          onPause={() => { currentPlayback.current.playing = false; setPlaying(false); }}
          onEnded={() => {
            handoff.current?.abort();
            currentPlayback.current.playing = false;
            setPlaying(false);
            setEnded(true);
          }}
          onTimeUpdate={event => {
            const time = event.currentTarget.currentTime;
            currentPlayback.current.time = time;
            setPosition(time);
          }}
          onDurationChange={event => {
            const length = event.currentTarget.duration;
            const total = mediaDuration || (Number.isFinite(length) && length > 0 ? length : 0);
            currentPlayback.current.duration = total;
            setDuration(total);
          }}
        />
      )}
      {showControls && <div className="deckyplex-video-heading">
        <div className="deckyplex-video-title">{title}</div>
        {subtitle && <div className="deckyplex-video-subtitle">{subtitle}</div>}
      </div>}
      {controlsHidden && !showUpNext && !exitPromptOpen && <Button ref={hiddenControlsRef} onClick={revealControls} onCancelButton={handleBack}
        aria-label="Show controls" onCancelActionDescription={promptOnBack ? 'Leave full screen' : 'Show controls'} noFocusRing
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 1, opacity: 0 }} />}
      {((showControls && error) || loading || (buffering && !error)) && (
        <div role="status" style={{ position: 'absolute', inset: '30% 1rem 32%', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: error ? 'auto' : 'none' }}>
          <div className="deckyplex-video-glass" style={{ padding: '0.8rem 1rem', maxWidth: '85%' }}>
            {error ? <Focusable flow-children="column" style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              <DialogBodyText style={{ margin: 0 }}>{error}</DialogBodyText>
              <Button onClick={reload}>Try again</Button>
            </Focusable> : <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <InlineSpinner />{qualityNotice || (retryingStart ? 'Retrying playback…'
                : buffering && !loading ? 'Buffering…' : `Loading ${photo ? 'photo' : 'video'}…`)}
            </div>}
          </div>
        </div>
      )}
      {showUpNext && next && <Focusable flow-children="column" className="deckyplex-video-glass"
        style={{ position: 'absolute', zIndex: 3, right: '1.25rem', bottom: '2rem', width: 'min(24rem, 76vw)', padding: '0.9rem' }}>
        <DialogLabel style={{ margin: '0 0 0.35rem' }}>Up next in {countdown ?? 5}s</DialogLabel>
        <DialogBodyText style={{ margin: '0 0 0.65rem', color: '#e5edf5' }}>{episodeLabel(next)}</DialogBodyText>
        <Focusable flow-children="horizontal" style={{ display: 'flex', gap: '0.5rem' }}>
          <Button ref={upNextRef} className="deckyplex-video-control" onClick={() => selectEpisode(next.id)}>Play now</Button>
          <Button className="deckyplex-video-control" onClick={cancelUpNext}>Cancel</Button>
        </Focusable>
      </Focusable>}
      {!optionsPage && !showUpNext && !exitPromptOpen && (showControls || activeMarker) && <div className="deckyplex-video-dock">
        {activeMarker && <Button ref={skipMarkerRef} className="deckyplex-video-control deckyplex-video-marker deckyplex-video-glass"
          onClick={() => seek(activeMarker.end)}>
          <FaStepForward aria-hidden="true" /><span>{activeMarker.type === 'intro' ? 'Skip intro' : 'Skip credits'}</span>
        </Button>}
        {showControls && <div className="deckyplex-video-glass deckyplex-video-transport">
          {!photo && duration > 0 && <VideoScrubber key={`${itemId}:${mediaIndex}`} overlay
            position={position} duration={duration} disabled={!canControl}
            seek={seek} previewUrl={media?.preview_url} localConnection={media?.local_connection} />}
          <Focusable flow-children="horizontal" className="deckyplex-video-buttons">
            {!photo && <>
              <Button className="deckyplex-video-control" aria-label="Back 10 seconds" onOKActionDescription="Back 10 seconds"
                disabled={!canControl || !duration} onClick={() => seek(position - 10)}><MdReplay10 aria-hidden="true" size="1.35em" /></Button>
              <Button className="deckyplex-video-control" ref={playRef} data-video-play="" aria-label={playing ? 'Pause' : 'Play'}
                onOKActionDescription={playing ? 'Pause' : 'Play'} disabled={!canControl} onClick={togglePlayback}>
                {playing ? <FaPause aria-hidden="true" /> : <FaPlay aria-hidden="true" />}
              </Button>
              <Button className="deckyplex-video-control" aria-label="Forward 10 seconds" onOKActionDescription="Forward 10 seconds"
                disabled={!canControl || !duration} onClick={() => seek(position + 10)}><MdForward10 aria-hidden="true" size="1.35em" /></Button>
              {(initialPlayback?.position ?? initialPosition ?? (media?.resume_ms || 0) / 1000) >= 30 &&
                <Button className="deckyplex-video-control" aria-label="Start over" onOKActionDescription="Start over"
                  disabled={!canControl} onClick={() => seek(0)}><FaRedo aria-hidden="true" /></Button>}
              <Button className="deckyplex-video-control" data-video-utility-start="" aria-label={muted ? 'Unmute' : 'Mute'}
                onOKActionDescription={muted ? 'Unmute' : 'Mute'} disabled={!canControl} onClick={() => setMuted(value => !value)}>
                {muted ? <FaVolumeMute aria-hidden="true" /> : <FaVolumeUp aria-hidden="true" />}
              </Button>
              {!!media?.subtitle_tracks?.length && <Button className="deckyplex-video-control" ref={captionsButtonRef}
                aria-label="Captions" aria-pressed={!!media.subtitle_track} onOKActionDescription="Captions"
                onClick={() => openOptions('subtitles', 'captions')}><FaClosedCaptioning aria-hidden="true" /></Button>}
              <Button className="deckyplex-video-control" ref={settingsButtonRef} aria-label="Playback settings"
                onOKActionDescription="Playback settings" disabled={!media} onClick={() => openOptions('main', 'settings')}>
                <FaCog aria-hidden="true" />
              </Button>
            </>}
            {(!fullscreen || photo) && <Button className="deckyplex-video-control" ref={fullscreenRef} disabled={!canFullscreen && !fullscreen}
              aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
              onOKActionDescription={fullscreen ? 'Exit full screen' : 'Full screen'}
              onClick={() => fullscreen ? leaveFullscreen() : enterFullscreen()}>
              {fullscreen ? <FaCompress aria-hidden="true" /> : <FaExpand aria-hidden="true" />}
            </Button>}
            {!photo && overGamePip && <Button className="deckyplex-video-control" ref={fullscreen ? fullscreenRef : undefined}
              aria-label={pipLoading ? 'Opening picture-in-picture' : 'Pop out'}
              onOKActionDescription="Pop out"
              disabled={!canControl || pipLoading} onClick={() => void playOverGame()}>
              {pipLoading ? <InlineSpinner /> : <MdPictureInPictureAlt aria-hidden="true" size="1.25em" />}
            </Button>}
            {fullscreen && <Button className="deckyplex-video-control" aria-label="Hide controls" onOKActionDescription="Hide controls"
              onClick={() => setControlsHidden(true)}><FaEyeSlash aria-hidden="true" /></Button>}
            {next && <Button className="deckyplex-video-control" aria-label="Next episode" onOKActionDescription="Next episode"
              onClick={() => selectEpisode(next.id)}><FaStepForward aria-hidden="true" /></Button>}
            <Button className="deckyplex-video-control" ref={closeRef} aria-label="Back to library" onOKActionDescription="Back to library"
              onClick={close}><FaArrowLeft aria-hidden="true" /></Button>
          </Focusable>
          {pipError && <p role="status" className="deckyplex-video-notice">{pipError}</p>}
          {qualityNotice && !loading && !error && <p role="status" className="deckyplex-video-notice">{qualityNotice}</p>}
        </div>}
      </div>}
      {optionsPage && !showUpNext && !exitPromptOpen && <VideoPlayerOptions page={optionsPage} onPage={setOptionsPage}
        busy={loading || pipLoading || changingTrack} error={optionsError} info={playbackInfo}
        chapters={mediaIndex === 0 ? media?.chapters ?? [] : []}
        seek={time => { seek(time); backFromOptions(); }}
        choices={{
          quality: { options: streamingQualities, selected: media?.quality || requestedQuality || 'auto', choose: changeQuality },
          audio: { options: media?.audio_tracks ?? [], selected: media?.audio_track, choose: value => void changeTrack('audio', value) },
          subtitles: { options: media?.subtitle_tracks?.length ? [{ data: 0, label: 'Captions off' }, ...media.subtitle_tracks] : [],
            selected: media?.subtitle_track ?? 0, choose: value => void changeTrack('subtitle', value) },
          versions: { options: media?.versions ?? [], selected: mediaIndex, choose: changeVersion },
        }} />}
      {exitPromptOpen && <div role="dialog" aria-modal="true" aria-label="Leave full screen"
        style={{ position: 'absolute', inset: 0, zIndex: 4, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.65)' }}>
        <Focusable onCancel={handleBack} onCancelActionDescription="Keep watching" className="deckyplex-video-glass"
          style={{ padding: '1rem' }}>
          <ChoiceDialogBody title="Leave full screen">
            <ChoiceDialogList>
              <ChoiceDialogRow title="Pause playback" detail="Resume from the Quick Player" preferredFocus rowRef={pauseChoiceRef}
                icon={<FaPause />} onChoose={pauseToQuickPlayer} />
              <ChoiceDialogRow title="Stop playback" icon={<FaStop />} destructive onChoose={close} />
            </ChoiceDialogList>
          </ChoiceDialogBody>
        </Focusable>
      </div>}
    </Focusable>
  );
}
