import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserPage } from '../../src/components/BrowserPage';
import { QuickPlayer } from '../../src/components/QuickPlayer';
import { VideoScrubber } from '../../src/components/VideoScrubber';
import { resumePausedVideoEvent, setViewerPlayback } from '../../src/components/VideoPlayback';
import { GamepadButton, HostContext } from './decky-host';

const params = new URLSearchParams(location.search);
const screen = params.get('screen');
const actions = [];
const record = name => (...args) => actions.push([name, ...args]);
const settings = {
  has_plex_token: params.get('account') !== 'signed-out', selected_server_id: 'fixture',
  selected_server_url: 'https://media.example.invalid', browse_all_media: true, library_selection_ids: ['1', '2'],
  grid_columns: 6, interface_theme: params.get('theme') || 'dark', quick_player_show_idle: true,
};
const libraries = [{ id: '1', type: 'artist', name: 'Music' }, { id: '2', type: 'movie', name: 'Movies' }];
const art = [
  ['#183153', '#ed9a4c'], ['#3c1852', '#d199c4'], ['#073935', '#75d4c0'],
  ['#28264e', '#547fe4'], ['#4c2320', '#ec7570'], ['#344211', '#e5bb61'],
];

function cover(index) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 288;
  const context = canvas.getContext('2d');
  const [background, color] = art[index % art.length];
  const gradient = context.createLinearGradient(0, 288, 288, 0);
  gradient.addColorStop(0, background);
  gradient.addColorStop(1, color);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 288, 288);
  context.translate(144, 144);
  context.rotate(index * Math.PI / 10);
  context.lineWidth = 1.6;
  for (let ring = 0; ring < 18; ring++) {
    context.strokeStyle = ring % 2 ? '#ffffff55' : '#0f172c55';
    context.beginPath();
    context.ellipse(0, 0, 12 + ring * 6.5, 10 + ring * 5.5, 0, 0, Math.PI * 2);
    context.stroke();
  }
  context.fillStyle = '#fff9';
  context.fillRect(-2, -2, 4, 4);
  return canvas.toDataURL('image/jpeg', 0.9);
}

const artwork = art.map((_, index) => cover(index));
const media = (id, title, type, index, sectionId = '1') => ({
  id, title, type, key: `/library/metadata/${id}`, thumb: artwork[index % artwork.length], sectionId,
});
const artists = [
  'Afterlight', 'Blue Atlas', 'Cloud Harbor', 'Deep Signal', 'Evening Standard', 'Field Notes',
  'Glass Avenue', 'Harbor Lights', 'Indigo Drift', 'Juniper Coast', 'Kite Lines', 'Low Current',
].map((title, index) => media(`artist-${index}`, title, 'artist', index));
const albums = ['Signals', 'The Long Way Home', 'Late Transit', 'Northern Lines', 'Paper Satellites', 'Quiet Hours']
  .map((title, index) => ({ ...media(`album-${index}`, title, 'album', index), artist: 'Afterlight' }));
const movies = ['Amber Sky', 'Blue Hour', 'Coastline'].map((title, index) => media(`movie-${index}`, title, 'movie', index, '2'));
const nextArtists = [media('artist-12', 'Moon Harbor', 'artist', 0)];
const paginate = params.get('pagination') === 'delayed';
let resolveNextPage;
const nextPage = new Promise(resolve => { resolveNextPage = resolve; });
const tracks = [
  { ...media('track-1', 'Soft Signal', 'track', 0), artist: 'Afterlight', album: 'Signals', duration: 240 },
  { ...media('track-2', 'Evening Current', 'track', 1), artist: 'Afterlight', album: 'Signals', duration: 180 },
];

window.fixture = {
  actions,
  finishPage: () => resolveNextPage({ items: nextArtists, has_more: false }),
  async rpc(method, ...args) {
    actions.push([method, ...args]);
    switch (method) {
      case 'get_settings':
      case 'get_quick_player_settings': return { ...settings };
      case 'get_library_sections': return { sections: libraries };
      case 'get_metadata_children': return { items: args[0]?.startsWith('artist-') ? albums : tracks };
      case 'get_section_contents':
        if (args[0] === '2') return { items: movies };
        if (!paginate) return { items: artists };
        return args[3] === 0 ? { items: artists, has_more: true, next_offset: artists.length } : nextPage;
      case 'search_library': return { items: artists.filter(artist => artist.title.toLowerCase().includes(args[0].toLowerCase())) };
      default: throw new Error(`Unexpected fixture RPC: ${method}`);
    }
  },
  press(button, repeat = false) {
    return document.activeElement.dispatchEvent(new CustomEvent('vgp_onbuttondown', {
      bubbles: true, cancelable: true, detail: { button: GamepadButton[button], is_repeat: repeat },
    }));
  },
};

const idle = screen === 'idle';
const album = tracks[0];
const owner = Symbol();
const sampleFilm = { id: 'test-film', type: 'movie', title: 'Amber Sky', poster: artwork[2] };
const video = {
  item: sampleFilm, episodes: [], duration: 600, position: 100, playing: true, ready: true,
  seek: record('seek video'), stop: record('stop video'), toggle: record('toggle video'),
  expand: () => actions.push(['fullscreen']), popOut: () => actions.push(['pop out']),
};
if (screen === 'video') setViewerPlayback(owner, video);

function App() {
  const [volume, setVolume] = useState(64);
  const [muted, setMuted] = useState(false);
  const [queue, setQueue] = useState(idle ? [] : tracks);
  const [position, setPosition] = useState(100);
  const player = {
    playbackState: idle ? 'stopped' : 'playing', track: idle ? undefined : album,
    duration: idle ? 0 : 240, progress: idle ? 0 : 84, queueIndex: idle ? -1 : 0, queue,
    volume, localVolume: volume, localMuted: muted, volumeSliderRevision: 0,
    setVolume, setLocalVolume: setVolume, setLocalMuted: setMuted,
    play: record('play'), pause: record('pause'), stop: record('stop'), seek: record('seek music'),
    skipPrevious: record('previous'), skipNext: record('next'), playQueueIndex: record('queue selection'),
    removeFromQueue: index => setQueue(list => list.filter((_, i) => index !== i)),
    loadMusicArtwork: async () => '',
  };
  return <HostContext.Provider value={player}>
    {screen === 'browser' ? <BrowserPage /> : screen === 'scrubber' ? (
      <main className="fixture-scrubber">
        <VideoScrubber position={position} duration={600} seek={value => { actions.push(['seek', value]); setPosition(value); }} />
        <button>Next control</button>
      </main>
    ) : (
      <div className="fixture-tray">
        <header>DeckyPlex</header>
        <QuickPlayer onBrowse={record('browse')} onLogin={record('login')} onSettings={record('settings')}
          onExpandPip={record('fullscreen')} onResumeVideo={() => window.dispatchEvent(new Event(resumePausedVideoEvent))} />
      </div>
    )}
  </HostContext.Provider>;
}

createRoot(document.getElementById('app')).render(<App />);
