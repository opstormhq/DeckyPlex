import { useState, useEffect, useCallback, useRef } from 'react';
import {
  PanelSection,
  PanelSectionRow,
  DialogBodyText,
  ButtonItem,
  Button,
  Focusable,
  TextField,
  Spinner,
  SidebarNavigation,
  Navigation,
} from '@decky/ui';
import { call } from '@decky/api';
import { FaSearch, FaMusic, FaCompactDisc, FaUser, FaHistory, FaListUl } from 'react-icons/fa';
import { usePlayer } from '../context/PlayerContext';

interface LibraryItem {
  id: string;
  key: string;
  title: string;
  type: string;
  thumb?: string;
  art?: string;
  summary?: string;
  year?: number;
  index?: number;
  parentTitle?: string;
  grandparentTitle?: string;
  leafCount?: number;
  viewCount?: number;
  duration?: number;
}

type BrowserTab = 'artists' | 'albums' | 'tracks' | 'recent' | 'playlists' | 'search';
type BrowserSubView = { type: 'albums' | 'tracks' | 'search'; title: string } | null;
interface BrowserHistoryEntry {
  items: LibraryItem[];
  subView: BrowserSubView;
  searchQuery: string;
}

export function BrowserPage() {
  const { playTrack } = usePlayer();
  const [activeTab, setActiveTab] = useState<BrowserTab>('artists');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSection, setSelectedSection] = useState<string>('');
  const [connected, setConnected] = useState(false);
  const [subView, setSubView] = useState<BrowserSubView>(null);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);

  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  useEffect(() => {
    setHistory([]);
    setSubView(null);
  }, [activeTab]);

  const goBack = useCallback(() => {
    const previous = history[history.length - 1];
    if (previous) {
      setHistory(history.slice(0, -1));
      setItems(previous.items);
      setSubView(previous.subView);
      setSearchQuery(previous.searchQuery);
    } else {
      Navigation.NavigateBack();
    }
  }, [history]);

  useEffect(() => {
    const onBackKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && history.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        goBack();
      }
    };
    window.addEventListener('keydown', onBackKey, true);
    return () => window.removeEventListener('keydown', onBackKey, true);
  }, [history, goBack]);

  // Check connection status periodically
  useEffect(() => {
    const checkConnection = async () => {
      try {
        const result: any = await call("get_settings");
        const wasConnected = connected;
        setConnected(!!(result.plex_token && result.selected_server_id));
        if (!wasConnected && result.plex_token && result.selected_server_id) {
          loadSections();
        }
      } catch (e) {
        setConnected(false);
      }
    };
    checkConnection();
    const interval = setInterval(checkConnection, 15000);
    return () => clearInterval(interval);
  }, [connected]);

  const loadSections = useCallback(async () => {
    try {
      const result: any = await call("get_library_sections");
      if (result.sections && result.sections.length > 0) {
        if (!selectedSection) {
          setSelectedSection(result.sections[0].id);
        }
      }
    } catch (e) {
      console.error("Failed to load sections:", e);
    }
  }, [selectedSection]);

  // Load data when tab changes
  useEffect(() => {
    if (!connected || !selectedSection || subView) return;
    if (activeTab === 'search') { setItems([]); return; }
    loadTabData(activeTab);
  }, [activeTab, connected, selectedSection, subView]);

  const loadTabData = useCallback(async (tab: BrowserTab) => {
    setLoading(true);
    setError(null);
    try {
      let result: any;
      if (tab === 'recent') {
        result = await call('get_recently_played', selectedSection, 100);
      } else if (tab === 'playlists') {
        result = await call('get_audio_playlists', 100);
      } else {
        const typeFilter = tab === 'artists' ? 'artist' : tab === 'albums' ? 'album' : 'track';
        result = await call("get_section_contents", selectedSection, typeFilter, 100);
      }
      if (result.items) {
        setItems(result.items);
      } else if (result.error) {
        setError(result.error);
        setItems([]);
      } else {
        setItems([]);
      }
    } catch (e) {
      setError("Failed to load items.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [selectedSection]);

  const loadAlbums = useCallback(async (artistId: string, artistName?: string) => {
    setHistory(previous => [...previous, { items, subView, searchQuery }]);
    setLoading(true);
    setError(null);
    setSubView({ type: 'albums', title: artistName || 'Albums' });
    try {
      const result: any = await call("get_metadata_children", artistId);
      if (result.items) {
        setItems(result.items);
      } else {
        setItems([]);
      }
    } catch (e) {
      setError("Failed to load albums.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [items, subView, searchQuery]);

  const loadPlaylistTracks = useCallback(async (playlistId: string, playlistName: string) => {
    setHistory(previous => [...previous, { items, subView, searchQuery }]);
    setLoading(true);
    setError(null);
    setSubView({ type: 'tracks', title: playlistName || 'Playlist' });
    try {
      const result: any = await call('get_playlist_tracks', playlistId, 200);
      if (result.items) setItems(result.items);
      else { setItems([]); if (result.error) setError(result.error); }
    } catch {
      setError('Failed to load playlist tracks.');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [items, subView, searchQuery]);

  const loadTracks = useCallback(async (albumId: string, albumName?: string) => {
    setHistory(previous => [...previous, { items, subView, searchQuery }]);
    setLoading(true);
    setError(null);
    setSubView({ type: 'tracks', title: albumName || 'Tracks' });
    try {
      const result: any = await call("get_metadata_children", albumId);
      if (result.items) {
        setItems(result.items);
      } else {
        setItems([]);
      }
    } catch (e) {
      setError("Failed to load tracks.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [items, subView, searchQuery]);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setHistory(previous => [...previous, { items, subView, searchQuery }]);
    setLoading(true);
    setError(null);
    setSubView({ type: 'search', title: 'Search Results' });
    try {
      const result: any = await call("search_library", searchQuery, selectedSection, 30);
      if (result.items) {
        setItems(result.items);
      }
    } catch (e) {
      setError("Search failed.");
    } finally {
      setLoading(false);
    }
  }, [searchQuery, selectedSection, items, subView]);

  const handlePlayTrack = useCallback(async (item: LibraryItem) => {
    try {
      console.log(`[DeckyPlex] Playing track: ${item.title} (id: ${item.id})`);
      const trackQueue = items.filter(entry => entry.type === 'track').map(entry => ({
        id: entry.id,
        sectionId: selectedSection,
        title: entry.title || 'Unknown',
        artist: entry.grandparentTitle || '',
        album: entry.parentTitle || '',
        duration: entry.duration || 0,
        thumb: entry.thumb || '',
      }));
      const trackInfo = {
        id: item.id,
        sectionId: selectedSection,
        title: item.title || 'Unknown',
        artist: item.grandparentTitle || '',
        album: item.parentTitle || '',
        duration: item.duration || 0,
        thumb: item.thumb || '',
      };
      // Get stream URL first, then play — playTrack must be called with a valid URL
      // so audio.play() can start immediately from this call stack.
      const result: any = await call("play_track", item.id, selectedSection);
      console.log(`[DeckyPlex] play_track result:`, result);
      if (!result?.success) {
        const message = result?.error || "Plex did not return a playable audio stream.";
        setError(message);
        console.error(`[DeckyPlex] play_track error:`, message);
        return;
      }
      if (result.stream_url) {
        console.log(`[DeckyPlex] Got stream URL, starting playback`);
        playTrack(result.stream_url, trackInfo, trackQueue);
      } else {
        setError("Plex returned no audio stream URL.");
      }
    } catch (e) {
      console.error(`[DeckyPlex] play_track exception:`, e);
      setError("Failed to play track.");
    }
  }, [selectedSection, playTrack, items]);

  const handleItemClick = useCallback((item: LibraryItem) => {
    if (item.type === 'artist') {
      loadAlbums(item.id, item.title);
    } else if (item.type === 'album') {
      loadTracks(item.id, item.title);
    } else if (item.type === 'playlist') {
      loadPlaylistTracks(item.id, item.title);
    } else if (item.type === 'track') {
      handlePlayTrack(item);
    }
  }, [loadAlbums, loadTracks, loadPlaylistTracks, handlePlayTrack]);

  const handleSearchItemClick = useCallback((item: LibraryItem) => {
    if (item.type === 'track') {
      handlePlayTrack(item);
    } else if (item.type === 'album') {
      loadTracks(item.id, item.title);
    } else if (item.type === 'artist') {
      loadAlbums(item.id, item.title);
    }
  }, [loadAlbums, loadTracks, handlePlayTrack]);

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const renderItemRow = (item: LibraryItem, idx: number | string, onClick: () => void) => {
    const imageUrl = item.type === 'artist' ? (item.art || item.thumb) : (item.thumb || item.art);
    return (
      <Focusable
        key={idx}
        flow-children="horizontal"
        onActivate={onClick}
        onClick={onClick}
        style={{
          display: 'flex', alignItems: 'center', width: '100%', gap: '0.75rem',
          padding: '0.45rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            width: '100%',
          }}>
            {imageUrl ? (
              <div style={{
                width: '40px',
                height: '40px',
                borderRadius: '4px',
                overflow: 'hidden',
                flexShrink: 0,
                backgroundColor: 'rgba(255,255,255,0.1)',
              }}>
                <img src={imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
            ) : (
              <div style={{ minWidth: '1.5rem', textAlign: 'center' }}>
                {item.type === 'track' && <FaMusic size={12} />}
                {item.type === 'album' && <FaCompactDisc size={12} />}
                {item.type === 'artist' && <FaUser size={12} />}
                {item.type === 'playlist' && <FaListUl size={12} />}
              </div>
            )}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <DialogBodyText style={{ fontWeight: 500 }}>
                {item.title || '(unknown)'}
              </DialogBodyText>
              {item.type === 'track' && item.parentTitle && (
                <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                  {item.parentTitle}
                </DialogBodyText>
              )}
              {item.type === 'album' && item.grandparentTitle && (
                <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                  {item.grandparentTitle}
                </DialogBodyText>
              )}
              {item.type === 'album' && item.leafCount != null && item.leafCount > 0 && (
                <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                  {item.leafCount} track{item.leafCount === 1 ? '' : 's'}
                  {item.year ? ` • ${item.year}` : ''}
                </DialogBodyText>
              )}
              {item.type === 'playlist' && item.leafCount != null && (
                <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                  {item.leafCount} track{item.leafCount === 1 ? '' : 's'}
                </DialogBodyText>
              )}
              {item.type !== 'album' && item.year && (
                <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                  {item.year}
                </DialogBodyText>
              )}
            </div>
            {item.type === 'track' && item.duration && (
              <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6, minWidth: '3rem', textAlign: 'right' }}>
                {formatDuration(item.duration)}
              </DialogBodyText>
            )}
          </div>
      </Focusable>
    );
  };

  const renderContent = () => {
    if (!connected) {
      return (
        <PanelSection>
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.7 }}>
              Please log in to Plex in Settings to browse your music library.
            </DialogBodyText>
          </PanelSectionRow>
        </PanelSection>
      );
    }

    return (
      <PanelSection>
        {subView && (
          <PanelSectionRow>
            <ButtonItem onClick={goBack}>← Back</ButtonItem>
            <DialogBodyText style={{ flex: 1, fontWeight: 500 }}>
              {subView.title}
            </DialogBodyText>
          </PanelSectionRow>
        )}

        {!subView && activeTab === 'search' && (
          <PanelSectionRow>
            <Focusable flow-children="horizontal" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', minWidth: 0 }}>
              <TextField
                label=""
                style={{ flex: '1 1 0', minWidth: '240px', width: '100%', boxSizing: 'border-box' }}
                value={searchQuery}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                placeholder="Search artists, albums, tracks..."
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSearch();
                  }
                }}
              />
              <Button onClick={handleSearch}>
                <FaSearch />
              </Button>
            </Focusable>
          </PanelSectionRow>
        )}

        {loading && (
          <PanelSectionRow>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Spinner />
              <DialogBodyText>Loading...</DialogBodyText>
            </div>
          </PanelSectionRow>
        )}

        {error && (
          <PanelSectionRow>
            <DialogBodyText style={{ color: '#ff6b6b' }}>{error}</DialogBodyText>
          </PanelSectionRow>
        )}

        {!loading && !error && items.length > 0 && (
          <PanelSectionRow>
            <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
            {items.map((item, idx) => {
              const handleClick = () => subView?.type === 'search' ? handleSearchItemClick(item) : handleItemClick(item);
              return renderItemRow(item, idx, handleClick);
            })}
            </div>
          </PanelSectionRow>
        )}

        {!loading && !error && items.length === 0 && !subView && (
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>
              {activeTab === 'search' ? 'Enter a search term above to find music.' : 'No items found.'}
            </DialogBodyText>
          </PanelSectionRow>
        )}
        {!loading && !error && items.length === 0 && subView?.type === 'search' && (
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>No results found.</DialogBodyText>
          </PanelSectionRow>
        )}
      </PanelSection>
    );
  };

  // SidebarNavigation pages - each tab triggers setActiveTab via effect
  const tabKeys: BrowserTab[] = ['artists', 'albums', 'tracks', 'recent', 'playlists', 'search'];
  const tabConfig = [
    { title: 'Artists', icon: <FaUser /> },
    { title: 'Albums', icon: <FaCompactDisc /> },
    { title: 'Songs', icon: <FaMusic /> },
    { title: 'Recently Played', icon: <FaHistory /> },
    { title: 'Playlists', icon: <FaListUl /> },
    { title: 'Search', icon: <FaSearch /> },
  ];

  const pages = tabConfig.map((config, idx) => ({
    title: config.title,
    icon: config.icon,
    content: (
      <TabActivator tab={tabKeys[idx]} onActivate={setActiveTab}>
        {renderContent()}
      </TabActivator>
    ),
  }));

  return (
    <div style={{ marginTop: '40px', height: 'calc(100% - 40px)' }}>
      <SidebarNavigation
        title="DeckyPlex"
        showTitle
        pages={pages}
      />
    </div>
  );
}

function TabActivator({ tab, onActivate, children }: { tab: BrowserTab; onActivate: (t: BrowserTab) => void; children: React.ReactNode }) {
  useEffect(() => {
    onActivate(tab);
  }, [tab, onActivate]);
  return <>{children}</>;
}
