import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { call, getExternalResourceURL, toaster } from '@decky/api';
import { Button, DialogBodyText, DialogLabel, Dropdown, Focusable, Navigation, type GamepadEvent } from '@decky/ui';
import Hls, { type LoaderCallbacks, type LoaderConfiguration, type LoaderContext } from 'hls.js';
import { InlineSpinner } from './InlineSpinner';
import { showPlaybackStartDialog } from './PlaybackStartDialog';
import { startGamePip, videoProgressEvent, type VideoItem, type VideoResume } from './GamePip';
import { setViewerPlayback } from './VideoPlayback';
import { VideoScrubber } from './VideoScrubber';
import { episodeLabel, resumePosition } from './VideoQueue';

interface MediaStream {
  kind: 'direct' | 'hls' | 'http' | 'image';
  url: string;
  mode?: 'audio-conversion' | 'direct-stream';
  fallback_url?: string;
}

interface MediaSource {
  streams?: MediaStream[];
  resume_ms?: number;
  duration_ms?: number;
  server_id?: string;
  quality?: string;
  has_audio?: boolean;
  handoff_key?: string;
  error?: string;
}

interface TrackOption {
  label: string;
  data: number;
}

const mediaStyle: CSSProperties = {
  position: 'absolute', inset: 0, objectFit: 'contain', width: '100%', height: '100%',
};

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

function plexHlsLoader(manifest: URL, proxy: boolean, rememberManifest: (text: string) => void) {
  const DefaultLoader = Hls.DefaultConfig.loader;
  return class PlexLoader extends DefaultLoader {
    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
      const upstream = new URL(context.url, manifest);
      if (upstream.origin !== manifest.origin || !upstream.pathname.startsWith('/video/:/transcode/')) {
        super.load(context, config, callbacks);
        return;
      }
      for (const name of ['X-Plex-Token', 'X-Plex-Client-Identifier', 'X-Plex-Session-Identifier']) {
        const value = manifest.searchParams.get(name);
        if (value && !upstream.searchParams.has(name)) upstream.searchParams.set(name, value);
      }
      const url = upstream.toString();
      super.load({ ...context, url: proxy ? getExternalResourceURL(url) : url }, config, {
        ...callbacks,
        // hls.js resolves relative playlist and segment paths from the response URL.
        onSuccess: (response, stats, sourceContext, details) => {
          if (upstream.pathname === manifest.pathname && upstream.search === manifest.search
              && typeof response.data === 'string' && response.data.length <= 65536) {
            rememberManifest(response.data);
          }
          callbacks.onSuccess(proxy ? { ...response, url } : response, stats, proxy ? context : sourceContext, details);
        },
      });
    }
  };
}

export function MediaViewer({
  item, subtitle, photo, initialVolume, initialPlayback, initialPosition, initialPresentation, close, episodes, episodeQueueReady,
  playEpisode, removeEpisode, onPlaying,
  overGamePip,
}: {
  item: VideoItem;
  subtitle?: string;
  photo: boolean;
  initialVolume: number;
  initialPlayback?: VideoResume | null;
  initialPosition?: number;
  initialPresentation?: VideoPresentation | null;
  close: () => void;
  episodes: VideoItem[];
  episodeQueueReady: boolean;
  playEpisode: (itemId: string, presentation: VideoPresentation) => boolean;
  removeEpisode: (itemId: string) => void;
  onPlaying: () => void;
  overGamePip: boolean;
}) {
  const { id: itemId } = item;
  const title = episodeLabel(item);
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const hiddenControlsRef = useRef<HTMLDivElement>(null);
  const nativeFullscreen = useRef<Promise<void> | null>(null);
  const restoreControlsFocus = useRef(false);
  const hlsRef = useRef<Hls | null>(null);
  const handoffManifest = useRef('');
  const closeRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<HTMLDivElement>(null);
  const offset = useRef(initialPlayback?.position ?? initialPosition ?? 0);
  const failedStreams = useRef<string[]>([]);
  const firstSource = useRef(true);
  const workingQuality = useRef('');
  const qualityAttempt = useRef<{ previous: string; requested: string; position: number } | null>(null);
  const quickPlayerOwner = useRef(Symbol());
  const playAfterLoad = useRef(initialPlayback?.playing ?? true);
  const currentPlayback = useRef({ time: 0, duration: 0, started: false, playing: false, ended: false });
  const timeline = useRef(Promise.resolve());
  const handoff = useRef<AbortController | null>(null);
  const switchingEpisode = useRef(false);
  const retryEpisodeStartup = useRef(item.type === 'episode' && !!initialPresentation);
  const retryTimer = useRef<number | undefined>(undefined);
  const hadNetworkFailure = useRef(false);
  const transferred = useRef(false);
  const onPlayingRef = useRef(onPlaying);
  onPlayingRef.current = onPlaying;
  const closeViewer = useRef(close);
  closeViewer.current = close;
  const [media, setMedia] = useState<MediaSource | null>(null);
  const [streamIndex, setStreamIndex] = useState(0);
  const [proxyHls, setProxyHls] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [requestedQuality, setRequestedQuality] = useState(initialPlayback?.quality ?? '');
  const [fullscreen, setFullscreen] = useState(initialPresentation?.fullscreen ?? !!initialPlayback);
  const [controlsHidden, setControlsHidden] = useState(initialPresentation?.controlsHidden ?? !!initialPlayback);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [position, setPosition] = useState(offset.current);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(initialPresentation?.volume ?? initialPlayback?.volume ?? initialVolume);
  const [muted, setMuted] = useState(initialPresentation?.muted ?? initialPlayback?.muted ?? false);
  const [error, setError] = useState('');
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<TrackOption[]>([]);
  const [audioTrack, setAudioTrack] = useState(-1);
  const [subtitleTrack, setSubtitleTrack] = useState(-1);
  const [pipLoading, setPipLoading] = useState(false);
  const [pipError, setPipError] = useState('');
  const [qualityNotice, setQualityNotice] = useState('');
  const [retryingEpisode, setRetryingEpisode] = useState(false);
  const [videoSize, setVideoSize] = useState('');

  const stream = media?.streams?.[streamIndex];
  const sourceName = proxyHls ? 'hls-proxy' : stream?.mode === 'direct-stream' ? 'hls-copy'
    : stream?.mode === 'audio-conversion' ? 'hls-audio' : stream?.kind || 'source';
  const mediaDuration = (media?.duration_ms || 0) / 1000;
  const episodeIndex = episodes.findIndex(episode => episode.id === itemId);
  const next = episodeIndex >= 0 ? episodes[episodeIndex + 1] : undefined;
  const selectEpisode = (id: string) => {
    if (id === itemId || switchingEpisode.current || handoff.current || !episodes.some(episode => episode.id === id)) return;
    switchingEpisode.current = true;
    if (!playEpisode(id, { volume, muted, fullscreen, controlsHidden })) switchingEpisode.current = false;
  };

  useEffect(() => {
    if (ended && next && !transferred.current && !pipLoading) selectEpisode(next.id);
  }, [ended, next, pipLoading]);

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

  const failPlayback = useCallback((detail: string, retryable = false) => {
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
    if (retryable && retryEpisodeStartup.current && !currentPlayback.current.started) {
      retryEpisodeStartup.current = false;
      setRetryingEpisode(true);
      log(workingQuality.current || 'auto', 'source', 'waiting', 'retry-episode-startup');
      retryTimer.current = window.setTimeout(reload, 500);
      return;
    }
    setRetryingEpisode(false);
    setLoading(false);
    setError(detail);
  }, [log, reload]);

  useEffect(() => () => window.clearTimeout(retryTimer.current), []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!fullscreen || !viewer) return;
    let active = true;
    const showFullscreen = () => {
      if (!active || document.fullscreenElement === viewer || typeof viewer.showPopover !== 'function') return;
      viewer.setAttribute('popover', 'manual');
      try {
        viewer.showPopover();
        hiddenControlsRef.current?.focus({ preventScroll: true });
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
  }, [fullscreen]);

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
    const frame = window.requestAnimationFrame(() => {
      if (controlsHidden) hiddenControlsRef.current?.focus({ preventScroll: true });
      else if (restoreControlsFocus.current) {
        restoreControlsFocus.current = false;
        (fullscreenRef.current ?? closeRef.current)?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [controlsHidden, fullscreen]);

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
      }
      setMedia(result);
    };
    setLoading(true);
    void call<[string, string], MediaSource>('get_media_source', itemId, requestedQuality)
      .then(result => {
        if (!active) return;
        if (!result?.streams?.length) throw new Error('Plex could not prepare this item for playback.');
        const offerMovieResume = firstSource.current && item.type === 'movie' && !initialPlayback
          && initialPosition === undefined;
        const savedPosition = offerMovieResume ? resumePosition(result.resume_ms || 0, result.duration_ms || 0) : 0;
        if (!savedPosition) {
          applySource(result);
          return;
        }
        startDialog = showPlaybackStartDialog({
          title,
          actionTitle: 'Play movie',
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
  }, [itemId, item.type, title, photo, retryCount, requestedQuality, initialPlayback, initialPosition, failPlayback, log]);

  useEffect(() => {
    if (!stream) return;
    const frame = window.requestAnimationFrame(() => {
      if (document.activeElement === closeRef.current || document.activeElement === document.body) {
        playRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [stream]);

  useEffect(() => {
    if (photo || !media?.server_id) return;
    const serverId = media.server_id;
    const report = (state: 'playing' | 'paused' | 'stopped') => {
      const playback = currentPlayback.current;
      if (transferred.current || !playback.started || playback.ended || playback.time < 1) return;
      const time = Math.round(playback.time * 1000);
      const length = Math.round(playback.duration * 1000);
      timeline.current = timeline.current.then(() => call(
        'report_video_progress', itemId, serverId, time, length, state,
      )).then(() => {
        if (state === 'stopped') window.dispatchEvent(new Event(videoProgressEvent));
      }).catch(() => {});
    };
    const timer = window.setInterval(() => {
      if (currentPlayback.current.playing) report('playing');
    }, 10000);
    const video = videoRef.current;
    const onPause = () => report('paused');
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
      report('stopped');
    };
  }, [itemId, media?.server_id, photo]);

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
    setPlaying(false);
    setError('');
    setVideoSize('');
    setAudioTracks([]);
    setSubtitleTracks([]);
    setAudioTrack(-1);
    setSubtitleTrack(-1);
    const fail = (detail: string, code: string, network = false) => {
      if (!active || failed) return;
      failed = true;
      log(quality, source, 'failed', code);
      failedStreams.current.push(detail);
      hadNetworkFailure.current ||= network;
      offset.current = succeeded ? video.currentTime || initialPosition : initialPosition;
      if (network && stream.fallback_url && !proxyHls) {
        setProxyHls(true);
      } else if (media?.streams?.[streamIndex + 1]) {
        setProxyHls(false);
        setStreamIndex(streamIndex + 1);
      } else {
        failPlayback(`Video could not play. ${[...new Set(failedStreams.current)].join(' ')}`, hadNetworkFailure.current);
      }
      video.pause();
    };
    let timeout = 0;
    const startTimer = (ms: number) => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => fail('The stream took too long to start.', `startup-timeout-${startupStage}`, true), ms);
    };
    startTimer(stream.kind === 'hls' ? 10000 : 15000);
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
      setRetryingEpisode(false);
      workingQuality.current = quality;
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

    if (stream.kind === 'hls' && Hls.isSupported()) {
      const manifest = new URL((proxyHls && stream.fallback_url) || stream.url);
      hls = new Hls({
        enableWorker: false,
        startPosition: initialPosition,
        loader: plexHlsLoader(manifest, proxyHls, text => { if (active) handoffManifest.current = text; }),
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!active || failed || succeeded) return;
        startupStage = 'segments';
        startTimer(stream.mode || qualityAttempt.current ? 12000 : 20000);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) fail(`Plex HLS: ${data.details}${data.response?.code ? ` (HTTP ${data.response.code})` : ''}.`,
          `${data.details}${data.response?.code ? `:${data.response.code}` : ''}`,
          data.type === Hls.ErrorTypes.NETWORK_ERROR);
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event, data) => {
        setAudioTracks(data.audioTracks.map((track, index) => ({ label: track.name || track.lang || `Audio ${index + 1}`, data: index })));
      });
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, data) => setAudioTrack(data.id));
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event, data) => {
        setSubtitleTracks(data.subtitleTracks.map((track, index) => ({ label: track.name || track.lang || `Subtitles ${index + 1}`, data: index })));
      });
      hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_event, data) => setSubtitleTrack(data.id));
      hls.loadSource(manifest.href);
      hls.attachMedia(video);
    } else if (stream.kind === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
      fail('HLS is unavailable in this Steam webview.', 'hls-unavailable');
    } else {
      video.src = stream.url;
      video.load();
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
      hlsRef.current = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [photo, media, stream, streamIndex, proxyHls, sourceName, requestedQuality, log, failPlayback]);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.volume = Math.max(0, Math.min(1, volume / 100));
    videoRef.current.muted = muted;
  }, [volume, muted]);

  const changeQuality = (quality: string) => {
    if (quality === (media?.quality || requestedQuality || 'auto')) return;
    const video = videoRef.current;
    if (loading || !video) return;
    if (!error) playAfterLoad.current = !video.paused && !video.ended;
    offset.current = error ? offset.current : video.currentTime;
    qualityAttempt.current = { previous: workingQuality.current, requested: quality, position: offset.current };
    setQualityNotice('');
    setRequestedQuality(quality);
    reload();
  };

  const seek = (target: number) => {
    if (!videoRef.current || !duration || error) return;
    videoRef.current.currentTime = Math.max(0, Math.min(target, duration));
  };

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video || error) return;
    playAfterLoad.current = video.paused;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };

  const revealControls = () => {
    restoreControlsFocus.current = true;
    setControlsHidden(false);
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

  const playOverGame = async (fromQuickPlayer = false) => {
    const video = videoRef.current;
    if (!overGamePip || !video || !media?.server_id || handoff.current || loading || error) return;
    setPipLoading(true);
    setPipError('');
    const attempt = new AbortController();
    handoff.current = attempt;
    try {
      const reuse = stream?.kind === 'hls' && media.handoff_key && handoffManifest.current
        ? { key: media.handoff_key, manifest: handoffManifest.current } : undefined;
      await startGamePip({
        item, serverId: media.server_id, quality: media.quality || 'auto',
        position: video.currentTime, volume, muted, episodes: episodeQueueReady ? episodes : undefined,
        preferredSource: sourceName,
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

  const handleBack = (event: Event) => {
    if (document.activeElement?.closest('[data-video-scrubbing]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if ((event as GamepadEvent).detail?.is_repeat || (event as KeyboardEvent).repeat) return;
    if (controlsHidden) revealControls();
    else if (fullscreen) leaveFullscreen();
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
  const showControls = !controlsHidden;

  useEffect(() => {
    if (photo || transferred.current) return;
    setViewerPlayback(quickPlayerOwner.current, {
      item, episodes, playing, busy: loading || pipLoading, transferring: pipLoading, ready: canControl, error, position, duration, volume,
      toggle: togglePlayback, seek,
      setVolume: value => {
        setVolume(value);
        if (value > 0) setMuted(false);
      },
      stop: close, playEpisode: selectEpisode, removeEpisode,
      popOut: overGamePip ? () => playOverGame(true) : undefined,
      expand: !fullscreen ? () => {
        Navigation.CloseSideMenus();
        enterFullscreen(true);
      } : undefined,
    });
  });

  return (
    <Focusable ref={viewerRef} flow-children="geometric" onCancel={handleBack}
      style={{ ...(fullscreen
        ? { position: 'fixed', inset: 0, width: '100vw', height: '100vh', zIndex: 1000,
            margin: 0, padding: 0, border: 0, maxWidth: 'none', maxHeight: 'none' }
        : { position: 'relative', width: '100%', height: 'calc(100% - 40px)', marginTop: '40px' }),
        background: '#000', overflow: 'hidden' }}>
      {photo ? (stream && <img src={stream.url} alt={title} style={mediaStyle}
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
          onWaiting={() => setLoading(true)}
          onPlaying={() => {
            setEnded(false);
            currentPlayback.current.ended = false;
            currentPlayback.current.started = true;
            currentPlayback.current.playing = true;
            setLoading(false);
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
      {showControls && <div style={{ position: 'absolute', inset: '0 0 auto', padding: '0.9rem 1.25rem', background: 'linear-gradient(#0a0d11, transparent)' }}>
        <DialogLabel style={{ margin: 0 }}>{title}</DialogLabel>
        {subtitle && <DialogBodyText style={{ margin: '0.2rem 0 0', opacity: 0.75 }}>{subtitle}</DialogBodyText>}
      </div>}
      {controlsHidden && <Button ref={hiddenControlsRef} onClick={revealControls} onCancelButton={handleBack}
        aria-label="Show controls" onCancelActionDescription="Show controls" noFocusRing
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 1, opacity: 0 }} />}
      {((showControls && error) || loading) && (
        <div role="status" style={{ position: 'absolute', inset: '30% 1rem 32%', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: error ? 'auto' : 'none' }}>
          <div style={{ borderRadius: '6px', padding: '0.8rem 1rem', background: 'rgba(10,13,17,0.9)', maxWidth: '85%' }}>
            {error ? <Focusable flow-children="column" style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              <DialogBodyText style={{ margin: 0 }}>{error}</DialogBodyText>
              <Button onClick={reload}>Try again</Button>
            </Focusable> : <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <InlineSpinner />{qualityNotice || (retryingEpisode ? 'Retrying this episode…' : `Loading ${photo ? 'photo' : 'video'}…`)}
            </div>}
          </div>
        </div>
      )}
      {showControls && <div style={{ position: 'absolute', inset: 'auto 0 0', padding: '1rem 1.25rem 1.65rem', background: 'linear-gradient(transparent, #0a0d11 35%)' }}>
        {!photo && duration > 0 && <VideoScrubber key={itemId} position={position} duration={duration} disabled={!canControl} seek={seek} />}
        <Focusable flow-children="horizontal" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          {!photo && <>
            <Button disabled={!canControl || !duration} onClick={() => seek(position - 10)}>−10s</Button>
            <Button ref={playRef} disabled={!canControl} onClick={togglePlayback}>{playing ? 'Pause' : 'Play'}</Button>
            <Button disabled={!canControl || !duration} onClick={() => seek(position + 10)}>+10s</Button>
            {(initialPlayback?.position ?? initialPosition ?? (media?.resume_ms || 0) / 1000) >= 30 &&
              <Button disabled={!canControl} onClick={() => seek(0)}>Start over</Button>}
            <Button disabled={!canControl} onClick={() => setMuted(value => !value)}>{muted ? 'Unmute' : 'Mute'}</Button>
          </>}
          {(!fullscreen || photo) && <Button ref={fullscreenRef} disabled={!canFullscreen && !fullscreen}
            onClick={() => fullscreen ? leaveFullscreen() : enterFullscreen()}>
            {fullscreen ? 'Exit full screen' : 'Full screen'}
          </Button>}
          {!photo && overGamePip && <Button ref={fullscreen ? fullscreenRef : undefined}
            disabled={!canControl || pipLoading} onClick={() => void playOverGame()}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              {pipLoading && <InlineSpinner />}{pipLoading ? 'Opening picture-in-picture…' : 'Pop out'}
            </span>
          </Button>}
          {fullscreen && <Button onClick={() => setControlsHidden(true)}>Hide controls</Button>}
          {next && <Button onClick={() => selectEpisode(next.id)}>Next episode</Button>}
          <Button ref={closeRef} onClick={close}>Back to library</Button>
        </Focusable>
        {pipError && <div role="status"><DialogBodyText style={{ margin: '0.4rem 0 0' }}>{pipError}</DialogBodyText></div>}
        {qualityNotice && !loading && !error && <div role="status"><DialogBodyText style={{ margin: '0.4rem 0 0' }}>{qualityNotice}</DialogBodyText></div>}
        {!photo && (
          <Focusable flow-children="horizontal" style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginTop: '0.5rem' }}>
            <span style={{ fontSize: '0.85rem' }}>Stream quality</span>
            <Dropdown rgOptions={streamingQualities} selectedOption={media?.quality || requestedQuality || 'auto'} disabled={loading || pipLoading}
              onChange={(option: { data: string }) => changeQuality(option.data)} />
            {canControl && <span style={{ fontSize: '0.85rem', opacity: 0.75 }}>
              {stream?.kind === 'direct' ? 'Direct play' : stream?.mode ? 'Plex stream' : 'Transcoding'}
              {videoSize && ` · ${videoSize}`}
            </span>}
            {audioTracks.length > 1 && <Dropdown strDefaultLabel="Audio track" rgOptions={audioTracks} selectedOption={audioTrack}
              onChange={(option: TrackOption) => { if (hlsRef.current) hlsRef.current.audioTrack = option.data; }} />}
            {subtitleTracks.length > 0 && <Dropdown strDefaultLabel="Subtitles" rgOptions={[{ label: 'Subtitles off', data: -1 }, ...subtitleTracks]} selectedOption={subtitleTrack}
              onChange={(option: TrackOption) => { if (hlsRef.current) hlsRef.current.subtitleTrack = option.data; }} />}
          </Focusable>
        )}
      </div>}
    </Focusable>
  );
}
