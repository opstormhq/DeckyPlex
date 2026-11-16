import { useState, useEffect, useCallback } from 'react';
import type { ReactElement } from 'react';
import {
  PanelSection,
  PanelSectionRow,
  DialogLabel,
  DialogBodyText,
  Button,
  TextField,
  Spinner,
} from '@decky/ui';
import { call } from '@decky/api';
import { FaArrowLeft, FaSearch, FaMusic, FaCompactDisc, FaUser } from 'react-icons/fa';

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

type BrowserTab = 'artists' | 'albums' | 'tracks' | 'search';
type BrowserView = 'tabs' | 'albums' | 'tracks' | 'search';

interface MusicBrowserProps {
  onBack?: () => void;
}

export function MusicBrowser({ onBack }: MusicBrowserProps) {
  const [activeTab, setActiveTab] = useState<BrowserTab>('artists');
  const [view, setView] = useState<BrowserView>('tabs');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSection, setSelectedSection] = useState<string>('');
  const [parentTitle, setParentTitle] = useState<string>('');
  const [connected, setConnected] = useState(false);

  // Check connection status periodically so it picks up after login
  useEffect(() => {
    const checkConnection = async () => {
      try {
        const result: any = await call("get_settings");
        const wasConnected = connected;
        setConnected(!!(result.plex_token && result.selected_server_id));
        // If just became connected, load sections immediately
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
        // Auto-select first music section
        if (!selectedSection) {
          setSelectedSection(result.sections[0].id);
        }
      } else if (result.error) {
        console.error("Failed to load sections:", result.error);
      }
    } catch (e) {
      console.error("Failed to load sections:", e);
    }
  }, [selectedSection]);

  // Load data for the active tab
  useEffect(() => {
    if (!connected || view !== 'tabs' || !selectedSection) return;
    loadTabData(activeTab);
  }, [activeTab, connected, view, selectedSection]);

  const loadTabData = useCallback(async (tab: BrowserTab) => {
    setLoading(true);
    setError(null);
    try {
      let typeFilter = '';
      if (tab === 'artists') typeFilter = 'artist';
      else if (tab === 'albums') typeFilter = 'album';
      else if (tab === 'tracks') typeFilter = 'track';
      const result: any = await call("get_section_contents", selectedSection, typeFilter, 50);
      if (result.items) {
        setItems(result.items);
      } else if (result.error) {
        setError(result.error);
        setItems([]);
      }
    } catch (e) {
      setError("Failed to load items.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [selectedSection]);

  const loadAlbums = useCallback(async (artistId: string) => {
    setLoading(true);
    setError(null);
    setView('albums');
    try {
      const result: any = await call("get_metadata_children", artistId);
      if (result.items) {
        setItems(result.items);
        setParentTitle(result.items[0]?.parentTitle || '');
      }
    } catch (e) {
      setError("Failed to load albums.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTracks = useCallback(async (albumId: string) => {
    setLoading(true);
    setError(null);
    setView('tracks');
    try {
      const result: any = await call("get_metadata_children", albumId);
      if (result.items) {
        setItems(result.items);
        setParentTitle(result.items[0]?.parentTitle || '');
      }
    } catch (e) {
      setError("Failed to load tracks.");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    setError(null);
    setView('search');
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
  }, [searchQuery, selectedSection]);

  const handlePlayTrack = useCallback(async (item: LibraryItem) => {
    try {
      const result: any = await call("play_track", item.id, selectedSection);
      if (result.error) {
        setError(result.error);
      }
    } catch (e) {
      setError("Failed to play track.");
    }
  }, [selectedSection]);

  const handleItemClick = useCallback((item: LibraryItem) => {
    if (item.type === 'artist') {
      loadAlbums(item.id);
    } else if (item.type === 'album') {
      loadTracks(item.id);
    } else if (item.type === 'track') {
      handlePlayTrack(item);
    }
  }, [loadAlbums, loadTracks, handlePlayTrack]);

  // For search results, any item type should be clickable
  const handleSearchItemClick = useCallback((item: LibraryItem) => {
    if (item.type === 'track') {
      handlePlayTrack(item);
    } else if (item.type === 'album') {
      loadTracks(item.id);
    } else if (item.type === 'artist') {
      loadAlbums(item.id);
    }
  }, [loadAlbums, loadTracks, handlePlayTrack]);

  const goBack = useCallback(() => {
    if (view === 'tracks' || view === 'albums') {
      setView('tabs');
      setItems([]);
      setParentTitle('');
    } else if (view === 'search') {
      setItems([]);
      setSearchQuery('');
    } else {
      onBack?.();
    }
  }, [view, onBack]);

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  if (!connected) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <DialogLabel>Music Browser</DialogLabel>
          <DialogBodyText style={{ opacity: 0.7 }}>
            Please log in to Plex in Settings to browse your music library.
          </DialogBodyText>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  // Render a single clickable item row
  const renderItemRow = (item: LibraryItem, idx: number | string, onClick: () => void) => {
    const imageUrl = item.type === 'artist' ? (item.art || item.thumb) : (item.thumb || item.art);
    return (
      <PanelSectionRow key={idx}>
        <div
          onClick={onClick}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            width: '100%',
            padding: '0.25rem 0',
          }}
        >
          {imageUrl ? (
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '4px',
                overflow: 'hidden',
                flexShrink: 0,
                backgroundColor: 'rgba(255,255,255,0.1)',
              }}
            >
              <img
                src={imageUrl}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </div>
          ) : (
            <div style={{ minWidth: '1.5rem', textAlign: 'center' }}>
              {item.type === 'track' && <FaMusic size={12} />}
              {item.type === 'album' && <FaCompactDisc size={12} />}
              {item.type === 'artist' && <FaUser size={12} />}
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
            {item.year && (
              <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                {item.year}
              </DialogBodyText>
            )}
          </div>

          {item.duration && (
            <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6, minWidth: '3rem', textAlign: 'right' }}>
              {formatDuration(item.duration)}
            </DialogBodyText>
          )}
        </div>
      </PanelSectionRow>
    );
  };

  // Tab buttons config
  const tabs: { key: BrowserTab; label: string; icon: ReactElement }[] = [
    { key: 'artists', label: 'Artists', icon: <FaUser /> },
    { key: 'albums', label: 'Albums', icon: <FaCompactDisc /> },
    { key: 'tracks', label: 'Songs', icon: <FaMusic /> },
    { key: 'search', label: 'Search', icon: <FaSearch /> },
  ];

  return (
    <PanelSection>
      {/* Header with back button */}
      <PanelSectionRow>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <Button onClick={goBack}>
            <FaArrowLeft />
          </Button>
          <DialogLabel style={{ flex: 1 }}>
            {view === 'tabs' && 'Browse Music'}
            {view === 'albums' && (parentTitle || 'Albums')}
            {view === 'tracks' && (parentTitle || 'Tracks')}
            {view === 'search' && 'Search Results'}
          </DialogLabel>
        </div>
      </PanelSectionRow>

      {/* Tab buttons — only show on tabs view */}
      {view === 'tabs' && (
        <PanelSectionRow>
          <div style={{ display: 'flex', gap: '0.5rem', width: '100%' }}>
            {tabs.map((tab) => (
              <Button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  flex: 1,
                  opacity: activeTab === tab.key ? 1 : 0.5,
                }}
              >
                {tab.icon}
                <span style={{ marginLeft: '0.25rem' }}>{tab.label}</span>
              </Button>
            ))}
          </div>
        </PanelSectionRow>
      )}

      {/* Search bar — only on search tab */}
      {view === 'tabs' && activeTab === 'search' && (
        <PanelSectionRow>
          <div style={{ display: 'flex', gap: '0.5rem', width: '100%' }}>
            <TextField
              label=""
              value={searchQuery}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
              placeholder="Search artists, albums, tracks..."
              onSubmit={handleSearch}
            />
            <Button onClick={handleSearch}>
              <FaSearch />
            </Button>
          </div>
        </PanelSectionRow>
      )}

      {/* Loading */}
      {loading && (
        <PanelSectionRow>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Spinner />
            <DialogBodyText>Loading...</DialogBodyText>
          </div>
        </PanelSectionRow>
      )}

      {/* Error */}
      {error && (
        <PanelSectionRow>
          <DialogBodyText style={{ color: '#ff6b6b' }}>{error}</DialogBodyText>
        </PanelSectionRow>
      )}

      {/* Items List */}
      {!loading && !error && items.length > 0 && (
        <>
          {items.map((item, idx) => {
            const handleClick = () => view === 'search' ? handleSearchItemClick(item) : handleItemClick(item);
            return renderItemRow(item, idx, handleClick);
          })}
        </>
      )}

      {/* Empty state */}
      {!loading && !error && items.length === 0 && view === 'tabs' && (
        <PanelSectionRow>
          <DialogBodyText style={{ opacity: 0.5 }}>
            {activeTab === 'search' ? 'Enter a search term above to find music.' : 'No items found.'}
          </DialogBodyText>
        </PanelSectionRow>
      )}
      {!loading && !error && items.length === 0 && view === 'search' && (
        <PanelSectionRow>
          <DialogBodyText style={{ opacity: 0.5 }}>
            No results found.
          </DialogBodyText>
        </PanelSectionRow>
      )}
    </PanelSection>
  );
}
