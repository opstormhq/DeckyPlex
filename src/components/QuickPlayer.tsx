import { plexMediaUrl } from './PlexMediaUrl';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { call, useQuickAccessVisible } from '@decky/api';
import {
  Button,
  SliderField,
  Focusable,
  GamepadButton,
  NavEntryPositionPreferences,
  type GamepadEvent,
} from '@decky/ui';
import {
  FaPlay,
  FaPause,
  FaForward,
  FaBackward,
  FaStepForward,
  FaStepBackward,
  FaStop,
  FaRandom,
  FaFilm,
  FaMusic,
  FaSignInAlt,
  FaCog,
  FaExpand,
} from 'react-icons/fa';
import { MdPictureInPictureAlt } from 'react-icons/md';
import { usePlayer } from '../context/PlayerContext';
import { InlineSpinner } from './InlineSpinner';
import { playGamePipEpisode, removeGamePipEpisode, seekGamePip, setGamePipVolume, stopGamePip, toggleGamePipPlayback, useGamePipPlayback } from './GamePip';
import { VideoScrubber } from './VideoScrubber';
import { clearPausedVideo, updatePausedVideo, usePausedVideo, useViewerPlayback } from './VideoPlayback';
import { episodeLabel } from './VideoQueue';
import { retryPlexRead } from './PlexRead';

const actionLabelStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 };
const buttonRowStyle: CSSProperties = { display: 'flex', gap: '0.4rem', minWidth: 0, alignItems: 'center' };
const wideButtonStyle: CSSProperties = { width: '100%', minHeight: '2.3rem', padding: '0.35rem 0.7rem', textAlign: 'left' };
const transportStyle: CSSProperties = { display: 'grid', placeItems: 'center', flex: '1 1 0', minWidth: 0,
  minHeight: '2.25rem', padding: '0.25rem 0', borderRadius: 6, boxSizing: 'border-box' };
const videoActionStyle: CSSProperties = { ...wideButtonStyle, flex: '1 1 0', minWidth: 0, fontSize: '0.85rem' };
const singleLine: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 };
const metadataLine: CSSProperties = { ...singleLine, color: 'inherit', opacity: 0.76, fontSize: '0.8rem', lineHeight: 1.2 };
const quickActionSelector = 'button:not(:disabled):not([aria-disabled="true"]), [role="button"]:not([aria-disabled="true"]):not([disabled])';
type QuickPlayerSettings = {
  has_plex_token?: boolean;
  local_server_enabled?: boolean;
  selected_server_id?: string;
  selected_server_url?: string;
  browse_all_media?: boolean;
  hide_quick_login?: boolean;
  quick_player_maintain_x?: boolean;
  quick_player_show_idle?: boolean;
  quick_player_native_style?: boolean;
  quick_player_compact_header?: boolean;
};
type ShuffleItem = { id: string; type: string; title?: string; grandparentTitle?: string; artist?: string;
  parentTitle?: string; duration?: number; thumb?: string };
type ShufflePage = { items?: ShuffleItem[]; error?: string };
let lastQuickSettings: QuickPlayerSettings | null = null;

async function shuffleRequest<T extends { error?: string }>(request: () => Promise<T>): Promise<T> {
  const result = await retryPlexRead(request);
  if (result?.error) throw new Error(result.error);
  return result;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function QuickPlayer({ onLogin, onBrowse, onSettings, onExpandPip, onResumeVideo }: {
  onLogin: () => void;
  onBrowse: () => void;
  onSettings: () => void;
  onExpandPip: () => void;
  onResumeVideo: (playing: boolean) => void;
}) {
  const quickViewVisible = useQuickAccessVisible();
  const [settings, setSettings] = useState(lastQuickSettings);
  const canBrowse = settings?.has_plex_token || settings?.local_server_enabled;
  const plexConnected = !!(canBrowse && settings?.selected_server_id && settings.selected_server_url);
  const topAction = canBrowse ? (settings?.browse_all_media ? 'all' : 'music')
    : settings && !settings.hide_quick_login ? 'login' : null;
  const maintainControlPosition = settings?.quick_player_maintain_x === true;
  const compactHeader = settings?.quick_player_compact_header !== false;
  const nativeStyle = settings?.quick_player_native_style === true;
  const [shufflingAll, setShufflingAll] = useState(false);
  const shufflePending = useRef(false);
  const [shuffleError, setShuffleError] = useState('');
  const [showQueue, setShowQueue] = useState(false);
  const [focusedSkip, setFocusedSkip] = useState<'previous' | 'next' | null>(null);
  const [failedMusicArt, setFailedMusicArt] = useState('');
  const [failedVideoArt, setFailedVideoArt] = useState('');
  const [relayedMusicArt, setRelayedMusicArt] = useState({ key: '', src: '' });
  const queueContainerRef = useRef<HTMLDivElement | null>(null);
  const queueToggleRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const playPauseRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const pendingQueueFocusId = useRef<string | null>(null);
  const {
    playbackState,
    playbackPending: musicPending,
    track,
    volume: musicVolume,
    localVolume,
    volumeSliderRevision,
    error,
    progress: musicProgress,
    duration: musicDuration,
    remoteMode,
    remoteQueueEditable,
    canLoadMoreQueue,
    loadMusicArtwork,
    companionMode,
    remotePlayerName,
    playTrack,
    playRemoteQueue,
    readMusicPlaybackTarget,
    beginPlaybackRequest,
    play,
    pause,
    stop,
    skipNext,
    skipPrevious,
    setVolume,
    setLocalVolume,
    seek,
    queue,
    queueIndex,
    playQueueIndex,
    removeFromQueue,
  } = usePlayer();
  const pip = useGamePipPlayback();
  const activeViewer = useViewerPlayback();
  const pausedVideo = usePausedVideo();
  const viewer = activeViewer ?? (pausedVideo ? {
    item: pausedVideo.resume.item, episodes: pausedVideo.resume.episodes ?? [],
    playing: false, ready: true, position: pausedVideo.resume.position, duration: pausedVideo.duration,
    volume: localVolume, busy: false, transferring: false, error: undefined, popOut: undefined,
    toggle: () => onResumeVideo(true), expand: () => onResumeVideo(false), stop: clearPausedVideo,
    seek: (position: number) => updatePausedVideo(resume => ({ ...resume, position })),
    setVolume: (volume: number) => updatePausedVideo(resume => ({ ...resume, volume, muted: volume > 0 ? false : resume.muted })),
    playEpisode: (id: string) => {
      const item = pausedVideo.resume.episodes?.find(episode => episode.id === id);
      if (!item) return;
      updatePausedVideo(resume => ({ ...resume, item, position: 0 }));
      onResumeVideo(true);
    },
    removeEpisode: (id: string) => updatePausedVideo(resume => ({ ...resume, episodes: resume.episodes?.filter(episode => episode.id !== id) })),
  } : null);
  const video = pip?.item ?? viewer?.item;
  const videoActive = !!video;
  const episodes = pip?.episodes ?? viewer?.episodes ?? [];
  const episodeIndex = episodes.findIndex(episode => episode.id === video?.id);
  const previousEpisode = episodeIndex > 0 ? episodes[episodeIndex - 1] : undefined;
  const nextEpisode = episodeIndex >= 0 ? episodes[episodeIndex + 1] : undefined;
  const nextEpisodeCountdown = pip?.nextEpisodeAt && nextEpisode
    ? Math.max(0, Math.ceil((pip.nextEpisodeAt - Date.now()) / 1000)) : undefined;
  const playEpisode = pip ? playGamePipEpisode : viewer?.playEpisode;
  const canSelectEpisode = !!playEpisode && (pip ? !pip.busy : !viewer?.transferring);
  const progress = pip ? pip.playback?.position || 0 : viewer?.position ?? musicProgress;
  const duration = pip ? pip.playback?.duration || 0 : viewer?.duration ?? musicDuration;
  const volume = pip?.volume ?? viewer?.volume ?? (remoteMode ? musicVolume : localVolume);
  const volumeSource = pip ? 'pip' : viewer ? 'video' : remoteMode ? 'remote' : 'local';
  const playbackPending = pip?.busy ?? viewer?.busy ?? (musicPending || playbackState === 'starting');
  const seekPlayback = pip ? seekGamePip : viewer?.seek ?? seek;
  const activeQueue: { id: string; title: string; artist: string; playQueueItemID?: string }[] = videoActive
    ? episodes.map(episode => ({ id: episode.id, title: episodeLabel(episode), artist: episode.grandparentTitle || '' }))
    : queue;
  const activeQueueIndex = videoActive ? episodeIndex : queueIndex;

  useEffect(() => {
    if (!pausedVideo || !settings) return;
    if (!plexConnected || settings.selected_server_id !== pausedVideo.resume.serverId) clearPausedVideo();
  }, [settings, pausedVideo, plexConnected]);

  const playQueueEntry = (index: number) => {
    if (videoActive) {
      const episode = episodes[index];
      if (episode && canSelectEpisode) void playEpisode?.(episode.id);
    } else playQueueIndex(index);
  };

  useEffect(() => {
    setShowQueue(false);
  }, [videoActive]);

  useEffect(() => {
    if (!activeQueue.length) {
      pendingQueueFocusId.current = null;
      setShowQueue(false);
    }
  }, [activeQueue.length]);

  useEffect(() => {
    if (!showQueue || !pendingQueueFocusId.current) return;
    const nextId = pendingQueueFocusId.current;
    pendingQueueFocusId.current = null;
    const rows = Array.from(queueContainerRef.current?.querySelectorAll<HTMLElement>('[data-queue-track-id]') || []);
    rows.find(row => row.dataset.queueTrackId === nextId)?.focus();
  }, [queue, pip?.episodes, viewer?.episodes, showQueue]);

  const handleRemoveQueueTrack = (index: number) => {
    const nextTrack = queue[index + 1] || queue[index - 1];
    pendingQueueFocusId.current = nextTrack?.id || null;
    removeFromQueue(index);
    if (queue.length <= 1) {
      setShowQueue(false);
      restoreControls();
    }
  };

  const removeQueueEntry = (id: string, index: number) => {
    if (!videoActive) {
      handleRemoveQueueTrack(index);
      return;
    }
    const episode = episodes[index];
    if (!episode || episode.id !== id || id === video?.id || !canSelectEpisode) return;
    pendingQueueFocusId.current = (episodes[index + 1] || episodes[index - 1])?.id || null;
    if (pip) removeGamePipEpisode(episode.id);
    else viewer?.removeEpisode(episode.id);
  };

  useEffect(() => {
    let mounted = true;
    let requestId = 0;
    const refreshConnection = async (validate = false) => {
      const id = ++requestId;
      const apply = (value: QuickPlayerSettings) => {
        if (!mounted || id !== requestId || !value) return;
        lastQuickSettings = value;
        setSettings(value);
      };
      try {
        apply(await call<[], QuickPlayerSettings>('get_settings'));
        if (validate) apply(await call<[], QuickPlayerSettings>('get_quick_player_settings'));
      } catch {}
    };
    const refreshSaved = () => void refreshConnection();
    void refreshConnection(true);
    const timer = setInterval(() => void refreshConnection(true), 10000);
    window.addEventListener('deckyplex-settings-change', refreshSaved);
    return () => {
      mounted = false;
      clearInterval(timer);
      window.removeEventListener('deckyplex-settings-change', refreshSaved);
    };
  }, []);

  const isPlaying = pip ? pip.playback?.status === 'playing' : viewer?.playing ?? (playbackState === 'playing');
  const isPaused = videoActive ? !isPlaying : playbackState === 'paused';
  const isStopped = playbackState === 'stopped';

  const musicArtKey = track ? `${track.sourceServerId || ''}:${track.id}:${track.thumb}` : '';
  const needsArtworkRelay = !videoActive && !!musicArtKey && (!track?.thumb || failedMusicArt === musicArtKey);
  const videoArtwork = video?.poster || video?.thumb;
  const resolvedMusicArt = needsArtworkRelay && relayedMusicArt.key === musicArtKey ? relayedMusicArt.src : '';
  const rawArtwork = video ? (videoArtwork !== failedVideoArt ? videoArtwork : undefined)
    : needsArtworkRelay ? resolvedMusicArt : track?.thumb;
  const artwork = rawArtwork && plexMediaUrl(rawArtwork, settings?.local_server_enabled && !companionMode && !remoteMode);
  const artistOrShow = video ? video.grandparentTitle || video.parentTitle : track?.artist;
  const album = video ? undefined : track?.album;

  useEffect(() => {
    if (!needsArtworkRelay || !track?.id) return;
    let active = true;
    void loadMusicArtwork(track.id, track.sourceServerId).then(src => {
      if (active) setRelayedMusicArt({ key: musicArtKey, src });
    });
    return () => { active = false; };
  }, [needsArtworkRelay, musicArtKey, track?.id, track?.sourceServerId, loadMusicArtwork]);

  const showPlayerTop = useCallback(() => {
    const heading = headingRef.current;
    heading?.ownerDocument.defaultView?.requestAnimationFrame(() => {
      if (heading.isConnected) heading.scrollIntoView({ block: 'start', inline: 'nearest' });
    });
  }, []);

  const restoreControls = useCallback(() => {
    const playPause = playPauseRef.current;
    const target = playPause?.matches(quickActionSelector) ? playPause
      : controlsRef.current?.querySelector<HTMLElement>(quickActionSelector)
        ?? playerRef.current?.querySelector<HTMLElement>(quickActionSelector);
    target?.focus({ preventScroll: true });
    showPlayerTop();
  }, [showPlayerTop]);

  const collapseQueue = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    setShowQueue(false);
    if (activeQueue.length) {
      window.requestAnimationFrame(() => queueToggleRef.current?.focus());
    } else {
      restoreControls();
    }
  };

  const shuffleAllSongs = async () => {
    if (shufflePending.current) return;
    shufflePending.current = true;
    setShufflingAll(true);
    setShuffleError('');
    try {
      const playerId = await readMusicPlaybackTarget();
      const playbackToken = playerId ? undefined : beginPlaybackRequest();
      const sectionsResult = await shuffleRequest(() => call<[], { sections?: { id: string }[]; error?: string }>('get_library_sections'));
      const section = sectionsResult?.sections?.[0];
      if (!section) throw new Error('No Plex music library was found.');
      const fetchPage = () => shuffleRequest(() => call<[string, number, number, boolean], ShufflePage>('get_track_page', section.id, 0, 25, true));
      const firstPage = await fetchPage();
      const toTrack = (item: ShuffleItem) => ({
        id: String(item.id),
        sectionId: String(section.id),
        title: item.title || 'Unknown',
        artist: item.grandparentTitle || item.artist || '',
        album: item.parentTitle || '',
        duration: item.duration || 0,
        thumb: item.thumb || '',
      });
      const queue = (firstPage.items || []).filter(item => item.type === 'track').map(toTrack);
      if (!queue.length) throw new Error('No songs were found in your music library.');

      if (playerId) {
        const result = await playRemoteQueue(playerId, queue, queue[0]?.id);
        if (!result.success) throw new Error(result.error || 'Could not start shuffled playback.');
      } else {
        const seenIds = new Set(queue.map(item => item.id));
        const loadMore = async () => {
          const page = await fetchPage();
          const tracks = (page.items || []).filter(item => item.type === 'track')
            .map(toTrack).filter(item => !seenIds.has(item.id));
          for (const item of tracks) seenIds.add(item.id);
          for (let i = tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
          }
          return tracks;
        };
        for (let i = queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [queue[i], queue[j]] = [queue[j], queue[i]];
        }
        const stream = await shuffleRequest(() => call<[string, string], { success?: boolean; stream_url?: string;
          fallback_stream_url?: string; local_connection?: boolean; error?: string }>('play_track', queue[0].id, section.id));
        if (!stream?.success || !stream.stream_url) {
          throw new Error(stream?.error || 'Plex did not return a playable audio stream.');
        }
        playTrack(stream.stream_url, queue[0], queue, stream.fallback_stream_url || '', loadMore, playbackToken, stream.local_connection);
      }
    } catch (e: any) {
      setShuffleError(e?.message || 'Could not shuffle the music library.');
    } finally {
      shufflePending.current = false;
      setShufflingAll(false);
    }
  };

  // Status: green=playing, orange=paused, blue=ready (default), red=error
  const hasTrack = !!(video || track);
  const canPlay = videoActive ? (pip ? !pip.busy && !pip.nextEpisodeAt : !!viewer?.ready)
    : remoteMode ? hasTrack && !isStopped && !playbackPending : hasTrack || queue.length > 0;
  const canStop = videoActive || (hasTrack && !isStopped && (!remoteMode || !musicPending));
  const canSeek = videoActive ? canPlay && duration > 0 : hasTrack && duration > 0 && !musicPending;
  const canSkipPrevious = videoActive ? canSelectEpisode && !!previousEpisode
    : hasTrack && !musicPending && (remoteMode || queueIndex > 0 || progress > 3);
  const canSkipNext = videoActive ? canSelectEpisode && !!nextEpisode
    : hasTrack && !musicPending && (remoteMode || queueIndex + 1 < queue.length || canLoadMoreQueue);
  const showIdlePlayer = !hasTrack && !playbackPending && settings?.quick_player_show_idle !== false;
  const showPlayer = hasTrack || canPlay || playbackPending || showIdlePlayer;
  const hasUsableTransport = canPlay || canStop || canSeek || canSkipPrevious || canSkipNext;
  const showActions = videoActive ? !!(pip || viewer?.expand || viewer?.popOut) : plexConnected || shufflingAll;
  const trackInfoFocusable = hasTrack && !topAction;
  const TrackInfo = trackInfoFocusable ? Focusable : 'div';
  const videoError = !pip && !!viewer?.error;
  const statusColor = videoActive ? (videoError ? '#ff4444' : isPaused ? '#ffaa00' : '#44ff44') : error ? '#ff4444' : companionMode ? (isPlaying ? '#44ff44' : isPaused ? '#ffaa00' : '#4488ff') : !plexConnected ? '#777777' : isPlaying ? '#44ff44' : isPaused ? '#ffaa00' : '#4488ff';
  const statusText = videoActive ? `${pip ? 'PiP' : 'Video'} · ${playbackPending ? 'Loading…' : videoError ? 'Playback error' : isPaused ? 'Paused' : 'Playing'}`
    : playbackPending ? 'Loading playback…' : error ? 'Error' : companionMode ? 'Remote play' : !plexConnected ? 'Not connected to Plex' : isPlaying ? 'Playing' : isPaused ? 'Paused' : 'Ready';
  const showStatus = !!settings || hasTrack || playbackPending || !!error || companionMode;

  useEffect(() => {
    const player = playerRef.current;
    const previous = previousFocus.current;
    if (!quickViewVisible || !player || !previous || (previous.isConnected && !previous.matches(':disabled'))) return;
    previousFocus.current = null;
    const { activeElement, body } = player.ownerDocument;
    if (activeElement && activeElement !== body && activeElement !== previous) return;
    restoreControls();
  }, [quickViewVisible, showPlayer, showActions, activeQueue.length, topAction, restoreControls,
    canPlay, canStop, canSeek, canSkipPrevious, canSkipNext]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onButtonDown = (input: Event) => {
      const event = input as GamepadEvent;
      const active = event.target as HTMLElement | null;
      if (!active || !player.contains(active)) return;
      previousFocus.current = active;
      const atControls = controlsRef.current?.contains(active);
      if (event.detail?.button !== GamepadButton.CANCEL) return;
      if (active.closest('[data-video-scrubbing]')) return;
      if (!showQueue && (atControls || !hasUsableTransport)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.detail.is_repeat) return;
      if (showQueue) {
        collapseQueue(event);
      } else {
        restoreControls();
      }
    };
    player.addEventListener('vgp_onbuttondown', onButtonDown, true);
    return () => player.removeEventListener('vgp_onbuttondown', onButtonDown, true);
  });

  const quickButtonProps = { className: 'deckyplex-quick-button', noFocusRing: !nativeStyle || undefined };
  const transport = (enabled: boolean, label: string, icon: React.ReactNode, action: () => void,
    primary = false, skip?: 'previous' | 'next') => (
    enabled || (skip && focusedSkip === skip && (hasTrack || playbackPending))
      ? <Button {...quickButtonProps} aria-label={label} aria-disabled={!enabled || undefined} onOKActionDescription={enabled ? label : undefined}
      ref={primary ? playPauseRef : undefined} preferredFocus={primary && !maintainControlPosition}
      data-quick-primary={primary || undefined} data-quick-skip={skip}
      onClick={enabled ? action : undefined} style={transportStyle}>{icon}</Button>
      : <span aria-hidden="true" style={{ ...transportStyle, color: '#8394a9', background: '#212d3c' }}>{icon}</span>
  );
  const status = <div role="status" className="deckyplex-quick-status" style={{ ...metadataLine, marginInlineStart: 'auto' }}>
    <span style={singleLine}>{statusText}</span>
    {playbackPending ? <InlineSpinner /> : <span aria-hidden="true"
      style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />}
  </div>;
  const portrait = !!video && (video.type === 'movie' || !!video.poster);
  const wideArt = !!video && !portrait;
  const videoActions = videoActive && showActions;

  return (
    <div ref={playerRef} data-deckyplex-quick-player="" data-steam-style={nativeStyle || undefined}
      onFocusCapture={event => {
        previousFocus.current = event.target;
        const skip = event.target.closest<HTMLElement>('[data-quick-skip]')?.dataset.quickSkip;
        setFocusedSkip(skip === 'next' || skip === 'previous' ? skip : null);
      }}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedSkip(null);
      }}>
      <style>{`
        [data-deckyplex-quick-player] {
          display: grid; gap: 0.65rem; padding: 0.65rem 0.85rem 0.85rem;
          color: #edf3fd; min-width: 0;
        }
        [data-deckyplex-quick-player] .deckyplex-quick-button,
        [data-deckyplex-quick-player] .deckyplex-quick-button::before,
        [data-deckyplex-quick-player] .deckyplex-quick-button::after {
          box-shadow: none !important; text-shadow: none !important; filter: none !important;
        }
        [data-deckyplex-quick-player]:not([data-steam-style]) .deckyplex-quick-button {
          background: #28374a !important; color: #edf3fd !important;
          border-radius: 6px; box-sizing: border-box;
        }
        [data-deckyplex-quick-player]:not([data-steam-style]) .deckyplex-quick-button[data-quick-primary] {
          background: #3b5674 !important;
        }
        [data-deckyplex-quick-player]:not([data-steam-style]) .deckyplex-quick-button:not(:disabled):is(:focus-visible, .gpfocus, :active) {
          background: #cadff5 !important; color: #172536 !important;
        }
        [data-deckyplex-quick-player] .deckyplex-quick-button[aria-disabled="true"] svg { opacity: 0.55; }
        .deckyplex-quick-status { display: flex; align-items: center; justify-content: end; gap: 0.4rem; min-width: 0; }
        [data-deckyplex-quick-player] .deckyplex-quick-button {
          appearance: none; border: 0 !important; margin: 0 !important;
        }
        [data-deckyplex-quick-player]:not([data-steam-style]) .deckyplex-quick-button::before,
        [data-deckyplex-quick-player]:not([data-steam-style]) .deckyplex-quick-button::after {
          content: none !important;
        }
      `}</style>
      <div ref={headingRef} data-quick-heading="" onFocusCapture={showPlayerTop} style={{
        display: 'grid', gridTemplateColumns: compactHeader && topAction ? 'max-content minmax(0, 1fr)' : undefined,
        alignItems: 'center', gap: '0.4rem', minHeight: compactHeader ? '2.3rem' : undefined,
        scrollMarginTop: 'max(56px, 3.5rem)',
      }}>
        {topAction && <Button {...quickButtonProps} data-quick-heading-action=""
          style={compactHeader ? { ...wideButtonStyle, width: 'auto', paddingInline: '0.55rem', fontSize: '0.86rem' } : wideButtonStyle}
          onClick={topAction === 'login' ? onLogin : onBrowse}>
          <span style={compactHeader ? { ...actionLabelStyle, gap: '0.4rem', whiteSpace: 'nowrap' } : actionLabelStyle}>
            {topAction === 'all' ? <FaFilm aria-hidden="true" /> : topAction === 'music' ? <FaMusic aria-hidden="true" /> : <FaSignInAlt aria-hidden="true" />}
            {topAction === 'all' ? 'Browse Media' : topAction === 'music' ? 'Browse Music' : 'Log in'}
          </span>
        </Button>}
        <div style={{ display: 'flex', alignItems: compactHeader ? 'stretch' : 'center',
          flexDirection: compactHeader ? 'column' : 'row', gap: compactHeader ? '0.1rem' : '0.5rem',
          minHeight: '1.15rem', minWidth: 0, gridRow: compactHeader ? undefined : 1 }}>
          {!compactHeader && !videoActive && remoteMode && <div style={{ ...metadataLine, color: '#b8dcff', minWidth: 0 }}
            title={`Controlling ${remotePlayerName || 'remote Plex player'}`}>
            Controlling {remotePlayerName || 'remote Plex player'}
          </div>}
          {showStatus && status}
          {compactHeader && !videoActive && remoteMode && <div style={{ ...metadataLine, color: '#b8dcff', textAlign: 'right' }}
            title={`Controlling ${remotePlayerName || 'remote Plex player'}`}>
            Controlling {remotePlayerName || 'remote Plex player'}
          </div>}
        </div>
      </div>

      {showPlayer && <div data-deckyplex-playback-card="" style={{
        background: nativeStyle ? 'rgba(255,255,255,0.05)' : '#182433',
        border: nativeStyle ? '1px solid rgba(255,255,255,0.15)' : '1px solid #304158', borderRadius: 9,
        padding: '0.7rem', display: 'grid', gap: '0.7rem', minWidth: 0 }}>
        <TrackInfo tabIndex={trackInfoFocusable ? 0 : undefined}
          onFocus={trackInfoFocusable ? showPlayerTop : undefined}
          style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', minWidth: 0, minHeight: videoActive ? 81 : 60 }}>
          <span style={{ width: portrait ? 54 : wideArt ? 79 : 60, height: portrait ? 81 : wideArt ? 46 : 60,
            display: 'grid', placeItems: 'center', overflow: 'hidden', flexShrink: 0, borderRadius: 6,
            background: '#26374c', color: '#aec9e4' }}>
            {artwork ? <img key={artwork} src={artwork} alt="" onError={() => {
              if (videoActive) setFailedVideoArt(artwork);
              else if (needsArtworkRelay) setRelayedMusicArt({ key: musicArtKey, src: '' });
              else setFailedMusicArt(musicArtKey);
            }} style={{ width: '100%', height: '100%', objectFit: 'cover', minHeight: 0 }} />
              : videoActive ? <FaFilm aria-hidden="true" /> : <FaMusic aria-hidden="true" />}
          </span>
          <div style={{ display: 'grid', flex: 1, alignContent: 'center', gap: '0.2rem', minWidth: 0, minHeight: '3.5rem' }}>
            <div style={{ ...singleLine, fontWeight: 650, fontSize: '1rem', lineHeight: 1.2 }}>
              {video ? episodeLabel(video) : track?.title || (playbackPending ? 'Starting playback…' : 'Nothing playing')}
            </div>
            {artistOrShow && <div style={metadataLine} title={artistOrShow}>{artistOrShow}</div>}
            {album && <div style={metadataLine} title={album}>{album}</div>}
          </div>
        </TrackInfo>

        {nextEpisodeCountdown !== undefined && nextEpisode && <Focusable flow-children="horizontal" style={buttonRowStyle}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={metadataLine}>Up next in {nextEpisodeCountdown}s</div>
            <div style={singleLine}>{episodeLabel(nextEpisode)}</div>
          </div>
          <Button {...quickButtonProps} onClick={stopGamePip} onOKActionDescription="Cancel autoplay">Cancel</Button>
        </Focusable>}

        {videoActive ? <VideoScrubber key={video?.id} compact steamStyle={nativeStyle}
          position={progress} duration={duration} disabled={!canSeek} seek={seekPlayback} /> : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', fontSize: '0.74rem',
              fontVariantNumeric: 'tabular-nums', color: '#b9cbe0', paddingBlock: '0.15rem' }}>
              <span>{formatTime(progress)}</span>
              <div style={{ flex: 1, height: 4, background: '#53657a', borderRadius: 3, cursor: canSeek ? 'pointer' : 'default' }}
                onClick={event => {
                  if (!canSeek) return;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  if (bounds.width) seekPlayback(duration * Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)));
                }}>
                <div style={{ width: `${duration > 0 ? Math.min(100, Math.max(0, (progress / duration) * 100)) : 0}%`,
                  height: '100%', background: '#9acfff', borderRadius: 3 }} />
              </div>
              <span>{formatTime(duration)}</span>
            </div>
          )}

        <Focusable ref={controlsRef} flow-children="horizontal" {...{ focusable: false }}
          navEntryPreferPosition={maintainControlPosition ? NavEntryPositionPreferences.MAINTAIN_X : NavEntryPositionPreferences.PREFERRED_CHILD}
          style={buttonRowStyle}>
          {transport(canSkipPrevious, videoActive ? 'Previous episode' : 'Previous track', <FaStepBackward />,
            () => previousEpisode ? void playEpisode?.(previousEpisode.id) : skipPrevious(), false, 'previous')}
          {transport(canSeek, 'Back 10 seconds', <FaBackward />, () => seekPlayback(Math.max(0, progress - 10)))}
          {transport(canPlay, isPlaying ? 'Pause' : 'Play', isPlaying ? <FaPause /> : <FaPlay />, () => {
            if (pip) toggleGamePipPlayback();
            else if (viewer) viewer.toggle();
            else if (isPlaying) pause();
            else if (hasTrack || remoteMode) play();
            else if (queue.length) playQueueIndex(Math.max(0, queueIndex));
          }, true)}
          {transport(canSeek, 'Forward 10 seconds', <FaForward />, () => seekPlayback(Math.min(duration, progress + 10)))}
          {transport(canSkipNext, videoActive ? 'Next episode' : 'Next track', <FaStepForward />,
            () => nextEpisode ? void playEpisode?.(nextEpisode.id) : skipNext(), false, 'next')}
          {transport(canStop, 'Stop', <FaStop />, pip ? stopGamePip : viewer?.stop ?? stop)}
        </Focusable>

        {videoActions && <Focusable flow-children="horizontal" style={{ ...buttonRowStyle, borderTop: '1px solid #304158',
          marginTop: '0.15rem', paddingTop: '0.65rem' }}>
          {(pip || viewer?.expand) && <Button {...quickButtonProps} onClick={pip ? onExpandPip : viewer?.expand}
            focusable={!playbackPending} disabled={playbackPending} style={videoActionStyle}>
            <span style={actionLabelStyle}><FaExpand aria-hidden="true" />Full screen</span>
          </Button>}
          {!pip && viewer?.popOut && <Button {...quickButtonProps} onClick={viewer.popOut}
            focusable={!playbackPending && viewer.ready} disabled={playbackPending || !viewer.ready} style={videoActionStyle}>
            <span style={actionLabelStyle}><MdPictureInPictureAlt aria-hidden="true" size="1.25em" />Pop out</span>
          </Button>}
        </Focusable>}
      </div>}

      {!videoActive && (error || shuffleError) && <div role="status" style={{ color: '#ffc1c1', fontSize: '0.82rem' }}>
        {shuffleError || error}
      </div>}

      {!videoActive && showActions && <Button {...quickButtonProps} style={wideButtonStyle} onClick={shuffleAllSongs}
        focusable={plexConnected} disabled={!plexConnected} aria-busy={shufflingAll}>
        <span style={actionLabelStyle}>
          {shufflingAll ? <InlineSpinner /> : <FaRandom aria-hidden="true" />}
          {shufflingAll ? 'Starting shuffle…' : 'Shuffle all songs'}
        </span>
      </Button>}

      {activeQueue.length > 0 && <Button ref={queueToggleRef} {...quickButtonProps}
        onClick={() => setShowQueue(value => !value)} onCancelButton={showQueue ? collapseQueue : undefined} style={wideButtonStyle}>
        {showQueue ? 'Hide queue' : `Queue · ${activeQueueIndex < 0 ? `${activeQueue.length} queued` : `${activeQueueIndex + 1}/${activeQueue.length}`}`}
      </Button>}
      {showQueue && !!activeQueue.length && <div ref={queueContainerRef}
        style={{ minWidth: 0, maxHeight: 'min(390px, 42vh)', overflowY: 'auto', overscrollBehavior: 'contain' }}>
        <Focusable flow-children="column" onCancel={collapseQueue} style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          {activeQueue.slice(Math.max(0, activeQueueIndex)).map((queuedTrack, index) => {
            const actualIndex = Math.max(0, activeQueueIndex) + index;
            const current = actualIndex === activeQueueIndex;
            const canEdit = videoActive ? !current && canSelectEpisode
              : remoteMode ? remoteQueueEditable && !musicPending && !current && !!queuedTrack.playQueueItemID : true;
            const canPlayEntry = videoActive ? canSelectEpisode && !current : !remoteMode;
            const queueKey = videoActive ? queuedTrack.id
              : remoteMode && queuedTrack.playQueueItemID ? queuedTrack.playQueueItemID : `${queuedTrack.id}-${actualIndex}`;
            return <Button {...quickButtonProps} key={queueKey} ref={(element: HTMLDivElement | null) => { if (element) element.dataset.queueTrackId = queuedTrack.id; }}
              disabled={!canPlayEntry && !canEdit} focusable={canPlayEntry || canEdit} onClick={canPlayEntry ? () => playQueueEntry(actualIndex) : undefined}
              onSecondaryActionDescription={canEdit ? 'Remove from queue' : undefined}
              onSecondaryButton={!canEdit ? undefined : event => {
                event.preventDefault();
                event.stopPropagation();
                removeQueueEntry(queuedTrack.id, actualIndex);
              }}
              style={{ width: '100%', minWidth: 0, minHeight: 0, height: '24px', padding: '0 0.35rem', fontSize: '0.8rem', lineHeight: 1.15, justifyContent: 'flex-start', overflow: 'hidden', boxSizing: 'border-box', opacity: current ? 1 : 0.75 }}>
              <span style={{ display: 'block', width: '100%', maxWidth: '100%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{current ? '▶ ' : ''}{queuedTrack.title} {queuedTrack.artist && <span style={{ opacity: 0.65 }}>— {queuedTrack.artist}</span>}</span>
            </Button>;
          })}
        </Focusable>
      </div>}
      <SliderField key={`${volumeSource}:${volumeSliderRevision}`} label="Volume" layout="inline"
        childrenContainerWidth="max" bottomSeparator="none" min={0} max={100} value={volume}
        onChange={value => {
          if (!videoActive) {
            setVolume(value);
            return;
          }
          setLocalVolume(value);
          if (pip) setGamePipVolume(value);
          else viewer?.setVolume(value);
        }} />
      <Button {...quickButtonProps} style={wideButtonStyle} onClick={onSettings}>
        <span style={actionLabelStyle}><FaCog aria-hidden="true" />Settings</span>
      </Button>
    </div>
  );
}
