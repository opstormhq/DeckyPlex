import { useEffect, useState } from 'react';
import { call } from '@decky/api';
import {
  Button,
  SliderField,
  PanelSection,
  PanelSectionRow,
  DialogLabel,
  DialogBodyText,
} from '@decky/ui';
import {
  FaPlay,
  FaPause,
  FaForward,
  FaBackward,
} from 'react-icons/fa';
import { usePlayer } from '../context/PlayerContext';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function QuickPlayer() {
  const [plexConnected, setPlexConnected] = useState(false);
  const {
    playbackState,
    track,
    volume,
    error,
    progress,
    duration,
    play,
    pause,
    skipNext,
    skipPrevious,
    setVolume,
    seek,
  } = usePlayer();

  useEffect(() => {
    let mounted = true;
    const refreshConnection = async () => {
      try {
        const settings: any = await call('get_settings');
        if (mounted) {
          setPlexConnected(Boolean(settings?.plex_token && settings?.selected_server_id && settings?.selected_server_url));
        }
      } catch {
        if (mounted) setPlexConnected(false);
      }
    };
    refreshConnection();
    const timer = setInterval(refreshConnection, 10000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  const isPlaying = playbackState === 'playing';
  const isPaused = playbackState === 'paused';
  const isStopped = playbackState === 'stopped';

  const albumArtUrl = track?.thumb || null;

  // Status: green=playing, orange=paused, blue=ready (default), red=error
  const hasTrack = !!track;
  const statusColor = !plexConnected ? '#777777' : isPlaying ? '#44ff44' : isPaused ? '#ffaa00' : error ? '#ff4444' : '#4488ff';
  const statusText = !plexConnected ? 'Not connected to Plex' : isPlaying ? 'Playing' : isPaused ? 'Paused' : error ? error : 'Ready';

  return (
    <PanelSection title="Quick Player">
      {/* Status Indicator */}
      <PanelSectionRow>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: statusColor,
            }}
          />
          <DialogBodyText>
            {statusText}
          </DialogBodyText>
        </div>
      </PanelSectionRow>

      {/* Error Message */}
      {error && (
        <PanelSectionRow>
          <DialogBodyText style={{ color: '#ff6b6b' }}>
            {error}
          </DialogBodyText>
        </PanelSectionRow>
      )}

      {/* Track Info */}
      <PanelSectionRow>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          {/* Album Art */}
          <div
            style={{
              width: '80px',
              height: '80px',
              borderRadius: '4px',
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {albumArtUrl ? (
              <img
                src={albumArtUrl}
                alt="Album art"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <DialogBodyText style={{ opacity: 0.3 }}>♪</DialogBodyText>
            )}
          </div>

          {/* Track Details */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 0 }}>
            <DialogLabel
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {track?.title || 'No track selected'}
            </DialogLabel>
            {track?.artist && (
              <DialogBodyText
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {track.artist}
              </DialogBodyText>
            )}
            {track?.album && (
              <DialogBodyText
                style={{
                  opacity: 0.5,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {track.album}
              </DialogBodyText>
            )}
          </div>
        </div>
      </PanelSectionRow>

      {/* Progress Bar */}
      {hasTrack && (
        <PanelSectionRow>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <DialogBodyText style={{ fontSize: '0.7rem', opacity: 0.6, minWidth: '2.5rem' }}>
              {formatTime(progress)}
            </DialogBodyText>
            <div
              style={{
                flex: 1,
                height: '4px',
                backgroundColor: 'rgba(255,255,255,0.1)',
                borderRadius: '2px',
                cursor: 'pointer',
                position: 'relative',
              }}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const pct = x / rect.width;
                seek(pct * (duration || 0));
              }}
            >
              <div
                style={{
                  width: `${duration ? (progress / duration) * 100 : 0}%`,
                  height: '100%',
                  backgroundColor: '#4a9eff',
                  borderRadius: '2px',
                  transition: 'width 0.1s linear',
                }}
              />
            </div>
            <DialogBodyText style={{ fontSize: '0.7rem', opacity: 0.6, minWidth: '2.5rem' }}>
              {formatTime(duration)}
            </DialogBodyText>
          </div>
        </PanelSectionRow>
      )}

      {/* Playback Controls */}
      <PanelSectionRow>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
          <Button onClick={() => skipPrevious()} disabled={!hasTrack}>
            <FaBackward />
          </Button>
          <Button onClick={() => isPlaying ? pause() : play()} disabled={!hasTrack}>
            {isPlaying ? <FaPause /> : <FaPlay />}
          </Button>
          <Button onClick={() => skipNext()} disabled={!hasTrack}>
            <FaForward />
          </Button>
        </div>
      </PanelSectionRow>

      {/* Volume Control */}
      <PanelSectionRow>
        {SliderField ? (
          <SliderField
            label="Volume"
            min={0}
            max={100}
            value={volume}
            onChange={(value: number) => setVolume(value)}
          />
        ) : (
          <DialogBodyText style={{ opacity: 0.5 }}>
            Volume: {volume}%
          </DialogBodyText>
        )}
      </PanelSectionRow>

      {/* Instructions */}
      {isStopped && !hasTrack && (
        <PanelSectionRow>
          <DialogBodyText
            style={{
              opacity: 0.5,
              fontStyle: 'italic',
              textAlign: 'center',
            }}
          >
            Browse music and select a track to play.
          </DialogBodyText>
        </PanelSectionRow>
      )}
    </PanelSection>
  );
}
