import { plexMediaUrl } from './PlexMediaUrl';
import { Fragment, memo, useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from 'react';
import {
  PanelSection,
  PanelSectionRow,
  DialogBodyText,
  DialogLabel,
  Button,
  Focusable,
  TextField,
  Spinner,
  ModalRoot,
  Navigation,
  GamepadButton,
  showModal,
  type GamepadEvent,
} from '@decky/ui';
import { call, toaster } from '@decky/api';
import {
  FaSearch, FaMusic, FaCompactDisc, FaUser, FaHistory, FaListUl, FaPlay, FaFilm, FaImage, FaHome, FaBars,
  FaStepForward, FaListOl, FaPlus, FaMinus, FaBookmark,
  FaSortAlphaDown, FaSortAlphaUp, FaClock, FaCalendarAlt, FaTrash, FaArrowLeft, FaRegClone,
} from 'react-icons/fa';
import { usePlayer } from '../context/PlayerContext';
import { InlineSpinner } from './InlineSpinner';
import { gamePipFullscreenEvent, getEpisodeQueue, queueGamePipEpisodeNext, stopGamePip, takeGamePipFullscreen,
  useGamePipEpisodeQueue, videoProgressEvent, type VideoItem, type VideoProgressUpdate, type VideoResume } from './GamePip';
import { MediaViewer, type VideoPresentation } from './MediaViewer';
import { showPlaybackStartDialog } from './PlaybackStartDialog';
import { ChoiceDialogBody, ChoiceDialogList, ChoiceDialogRow } from './ChoiceDialog';
import { FocusOutlineStyles, focusOutlineProps } from './FocusOutline';
import { collectionResumes, episodeLabel, insertNextEpisode, queueFromEpisode, resumeEpisode, resumePosition } from './VideoQueue';
import { musicBrowserCategories, videoCategories, visibleCategories,
  type BrowserLayouts, type MusicTab, type VideoTab } from './BrowserCategories';
import { VideoOptionsDialog, type VideoAction, type VideoActionResult } from './VideoOptionsDialog';
import { VideoWatchIndicator } from './VideoWatchIndicator';
import { clearPausedVideo, requestPausedVideo, resumePausedVideoEvent, takePausedVideo, updatePausedVideo, usePausedVideo } from './VideoPlayback';
import { playNavigationSound, selectWithSound } from './GamepadSounds';
import { retryPlexRead } from './PlexRead';

interface LibraryItem {
  id: string;
  key: string;
  title: string;
  titleSort?: string;
  type: string;
  thumb?: string;
  poster?: string;
  gridThumb?: string;
  gridPoster?: string;
  art?: string;
  summary?: string;
  artist?: string;
  year?: number;
  index?: number;
  parentIndex?: number;
  parentTitle?: string;
  grandparentTitle?: string;
  leafCount?: number;
  viewedLeafCount?: number | null;
  viewCount?: number;
  viewOffset?: number;
  userRating?: number | null;
  parentId?: string;
  grandparentId?: string;
  duration?: number;
  sectionId?: string;
}

type BrowserTab = MusicTab | VideoTab | 'search';
type BrowserSubView = { type: 'albums' | 'tracks' | 'search' | 'media'; title: string; id?: string; queueLabel?: string; mediaType?: string } | null;
interface LibrarySection { id: string; name: string; type: string; }
interface ItemCacheEntry { expiresAt: number; items: LibraryItem[]; hasMore?: boolean; nextOffset?: number; recentOffsets?: HomeRecentOffsets; }

const musicCategoryIcons = {
  artists: <FaUser />, albums: <FaCompactDisc />, tracks: <FaMusic />, recent: <FaHistory />,
  recentlyAdded: <FaCompactDisc />, playlists: <FaListUl />,
};

function sectionForTab(tab: BrowserTab) {
  return tab.startsWith('library:') ? tab.slice('library:'.length) : '';
}

interface BrowserHistoryEntry {
  items: LibraryItem[];
  subView: BrowserSubView;
  focusedItemId?: string;
  homeRow?: VideoHomeRow;
  scrollTop: number;
  hasMore: boolean;
}
interface TabFocusPosition { itemId: string; scrollTop: number; homeRow?: VideoHomeRow; }

const browserHeaderStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '0.5rem', height: '2.65rem',
  paddingInline: '0.35rem', marginBottom: '0.5rem', boxSizing: 'border-box',
};
const browserHeaderScrollMargin = `calc(${browserHeaderStyle.height} + ${browserHeaderStyle.marginBottom} + 0.5rem)`;
const DEFAULT_GRID_COLUMNS = 6;
const BROWSER_FOOTER_CLEARANCE = 150;
const BROWSER_SIDEBAR_FOOTER_CLEARANCE = 110;
const BROWSER_FOCUS_EDGE_PADDING = 28;
const ALPHABET_HOLD_DELAY = 450;
const PAGE_SIZE = 36;
const LIBRARY_CACHE_TTL = 600000;
const videoWatchlistEvent = 'deckyplex-video-watchlist-change';
const watchlistTabCache = 'video-watchlist';
const VIDEO_HOME_ROWS = [
  { id: 'continue', title: 'Continue Watching', ttl: 15000 },
  { id: 'next', title: 'Watch Next', ttl: 15000 },
  { id: 'movies', title: 'Recently Added Movies', ttl: 60000 },
  { id: 'shows', title: 'Recently Added TV', ttl: 60000 },
  { id: 'watchlist', title: 'Watchlist', ttl: 60000 },
] as const;
const VIDEO_SORTS = [
  { id: 'titleSort:asc', title: 'Title A–Z', Icon: FaSortAlphaDown },
  { id: 'titleSort:desc', title: 'Title Z–A', Icon: FaSortAlphaUp },
  { id: 'addedAt:desc', title: 'Recently added', Icon: FaClock },
  { id: 'originallyAvailableAt:desc', title: 'Newest release', Icon: FaCalendarAlt },
];

function alphabetGroup(title: string) {
  const initial = title.trimStart().normalize('NFD').replace(/^\p{M}+/u, '').charAt(0).toUpperCase();
  return /^[A-Z]$/.test(initial) ? initial : '#';
}
type VideoHomeRow = typeof VIDEO_HOME_ROWS[number]['id'];
type HomeRecentOffsets = Record<string, number | null>;
type VideoHomeShelf = { items: LibraryItem[]; error?: string; recentOffsets?: HomeRecentOffsets; paging?: boolean; pageError?: boolean };
type VideoHomeData = Partial<Record<VideoHomeRow, VideoHomeShelf>>;

const recentShelfHasMore = (shelf?: VideoHomeShelf) =>
  shelf?.recentOffsets && Object.values(shelf.recentOffsets).some(offset => offset !== null);

function keepHomeCardVisible(card: HTMLElement) {
  const shelf = card.closest<HTMLElement>('[data-home-shelf]');
  if (!shelf?.offsetWidth) return;
  const viewport = shelf.getBoundingClientRect();
  const bounds = card.getBoundingClientRect();
  const scale = viewport.width / shelf.offsetWidth;
  if (!scale) return;
  if (bounds.left < viewport.left) shelf.scrollLeft += (bounds.left - viewport.left) / scale;
  else if (bounds.right > viewport.right) shelf.scrollLeft += (bounds.right - viewport.right) / scale;
}

function focusForDirection(target: HTMLElement, event: Event) {
  target.focus({ preventScroll: true });
  // Manually handled moves don't pass through Steam's gamepad focus sound.
  playNavigationSound(event);
}

export function BrowserPage() {
  const { playTrack, readMusicPlaybackTarget, playRemoteQueue, beginPlaybackRequest, remoteMode, remoteTargetSelected, remotePlayerName,
    addToQueue, playbackState, pause, localVolume } = usePlayer();
  return <LibraryBrowser {...{ playTrack, readMusicPlaybackTarget, playRemoteQueue, beginPlaybackRequest, remoteTargetSelected, remotePlayerName,
    addToQueue, pause, localVolume }} localMusicPlaying={!remoteMode && playbackState === 'playing'} />;
}

type BrowserPlayback = Pick<ReturnType<typeof usePlayer>, 'playTrack' | 'readMusicPlaybackTarget' | 'playRemoteQueue' | 'beginPlaybackRequest'
  | 'remoteTargetSelected' | 'remotePlayerName' | 'addToQueue' | 'pause' | 'localVolume'> & { localMusicPlaying: boolean };
const LibraryBrowser = memo(function LibraryBrowser({
  playTrack, readMusicPlaybackTarget, playRemoteQueue, beginPlaybackRequest, remoteTargetSelected, remotePlayerName, addToQueue, localMusicPlaying, pause, localVolume,
}: BrowserPlayback) {
  const pipEpisodeQueue = useGamePipEpisodeQueue();
  const [activeTab, setActiveTab] = useState<BrowserTab>('artists');
  const activeTabRef = useRef<BrowserTab>(activeTab);
  activeTabRef.current = activeTab;
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [playbackRequests, setPlaybackRequests] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState('');
  const [tabHasMore, setTabHasMore] = useState(false);
  const [focusTreeVersion, setFocusTreeVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSection, setSelectedSection] = useState<string>('');
  const [libraries, setLibraries] = useState<LibrarySection[]>([]);
  const [homeData, setHomeData] = useState<VideoHomeData>({});
  const loadMoreHome = useRef<(row: VideoHomeRow, retry?: boolean) => void>(() => {});
  const homeShelfFocus = useRef(new Map<VideoHomeRow, string>());
  const [pendingContinueRemovals, setPendingContinueRemovals] = useState<ReadonlySet<string>>(() => new Set());
  const [videoSorts, setVideoSorts] = useState<Record<string, string>>({});
  const [loadingLibraries, setLoadingLibraries] = useState(false);
  const [showAllMedia, setShowAllMedia] = useState(false);
  const [overGamePip, setOverGamePip] = useState(false);
  const [videoAutoplay, setVideoAutoplay] = useState(true);
  const [librarySelectionKey, setLibrarySelectionKey] = useState('');
  const [serverId, setServerId] = useState('');
  const [serverAddress, setServerAddress] = useState('');
  const [hasPlexAccount, setHasPlexAccount] = useState(false);
  const [browserLayouts, setBrowserLayouts] = useState<BrowserLayouts>({});
  const browserLayoutsRef = useRef(browserLayouts);
  const layoutSnapshot = useRef('{}');
  const visibleMusic = useMemo(() => visibleCategories(
    selectedSection || !libraries.length ? musicBrowserCategories(hasPlexAccount) : [], browserLayouts.music,
  ), [selectedSection, libraries.length, browserLayouts.music, hasPlexAccount]);
  const visibleVideo = useMemo(() => visibleCategories(
    videoCategories(libraries, hasPlexAccount), browserLayouts[`video:${serverId}`],
  ), [libraries, serverId, hasPlexAccount, browserLayouts]);
  const tabs = useMemo((): { key: BrowserTab; title: string; icon: React.ReactNode }[] => [
    ...visibleMusic.map(category => ({ ...category, icon: musicCategoryIcons[category.key] })),
    ...visibleVideo.map(category => ({ ...category,
      icon: category.type === 'home' ? <FaHome /> : category.type === 'watchlist' ? <FaBookmark />
        : category.type === 'photo' ? <FaImage /> : <FaFilm /> })),
    { key: 'search', title: 'Search', icon: <FaSearch /> },
  ], [visibleMusic, visibleVideo]);
  const [checkingConnection, setCheckingConnection] = useState(true);
  const connected = !!serverId;
  const [subView, setSubView] = useState<BrowserSubView>(null);
  const subViewRef = useRef(subView);
  subViewRef.current = subView;
  const collectionRequest = useRef<{ key: string; episodes: Promise<VideoItem[]> } | null>(null);
  const [viewerItem, setViewerItem] = useState<LibraryItem | null>(null);
  const pausedVideo = usePausedVideo();
  const [viewerMinimized, setViewerMinimized] = useState(false);
  const [viewerSession, setViewerSession] = useState(0);
  const [viewerResume, setViewerResume] = useState<VideoResume | null>(null);
  const [viewerPresentation, setViewerPresentation] = useState<VideoPresentation | null>(null);
  const [viewerStartPosition, setViewerStartPosition] = useState<number | undefined>();
  const [viewerQueue, setViewerQueueState] = useState<VideoItem[] | null>(null);
  const latestViewerQueue = useRef<VideoItem[] | null>(null);
  const setViewerQueue = useCallback((value: React.SetStateAction<VideoItem[] | null>) => {
    const queue = typeof value === 'function' ? value(latestViewerQueue.current) : value;
    latestViewerQueue.current = queue;
    setViewerQueueState(queue);
  }, []);
  const viewerExpanded = !!viewerItem && !viewerMinimized;
  const combinedArtists = libraries.filter(library => library.type === 'artist').length > 1;
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);
  const [gridColumns, setGridColumns] = useState(DEFAULT_GRID_COLUMNS);
  const [gridPreferenceSet, setGridPreferenceSet] = useState(false);
  const [neverWrapCategories, setNeverWrapCategories] = useState(false);
  const [restoreFocusTick, setRestoreFocusTick] = useState(0);
  const itemCache = useRef(new Map<string, ItemCacheEntry>());
  const pendingItems = useRef(new Map<string, Promise<any>>());
  const pendingVideoActions = useRef(new Set<string>());
  const watchlistMembership = useRef(new Map<string, boolean>());
  const firstItemRef = useRef<HTMLDivElement | null>(null);
  const sortButtonRef = useRef<HTMLDivElement | null>(null);
  const playCollectionRef = useRef<HTMLDivElement | null>(null);
  const lastCollectionItem = useRef<HTMLElement | null>(null);
  const gridDialogRef = useRef<{ Close: () => void } | null>(null);
  const gridPromptShown = useRef(false);
  const actionDialogRef = useRef<{ Close: () => void } | null>(null);
  const focusZone = useRef<'sidebar' | 'content'>('sidebar');
  const browserRef = useRef<HTMLDivElement | null>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const moreItemsRef = useRef<HTMLDivElement | null>(null);
  const focusScrollFrame = useRef(0);
  const scrollHomeCard = useRef<(target: HTMLElement, previous: HTMLElement) => void>(() => {});
  const fastVerticalNavigation = useRef(false);
  const contentScrollAnimation = useRef<{ top: number; frame: number } | null>(null);
  const alphabetOverlayRef = useRef<HTMLDivElement | null>(null);
  const alphabetHold = useRef<{ button: GamepadButton; item: HTMLElement; timer: number | null } | null>(null);
  const searchFormRef = useRef<HTMLDivElement | null>(null);
  const focusedItemId = useRef<string | undefined>(undefined);
  const focusedHomeRow = useRef<VideoHomeRow | undefined>(undefined);
  const pendingFocusId = useRef<string | undefined>(undefined);
  const pendingHomeRow = useRef<VideoHomeRow | undefined>(undefined);
  const pendingSortFocus = useRef<{ tab: BrowserTab; sort: string; ready: boolean } | null>(null);
  const pendingScrollTop = useRef<number | undefined>(undefined);
  const tabFocusPositions = useRef(new Map<BrowserTab, TabFocusPosition>());
  const pendingSearchFocus = useRef(false);
  const pendingSearchInputFocus = useRef(false);
  const loadingMoreRef = useRef(false);
  const tabLoadRequestId = useRef(0);
  const restoringHistoryRef = useRef(false);
  const enterContentPending = useRef(false);
  const viewerOrigin = useRef<{ itemId?: string; scrollTop: number; homeRow?: VideoHomeRow }>({ scrollTop: 0 });

  const cancelContentScroll = useCallback(() => {
    if (contentScrollAnimation.current) window.cancelAnimationFrame(contentScrollAnimation.current.frame);
    contentScrollAnimation.current = null;
  }, []);

  const hideAlphabetOverlay = useCallback(() => {
    const hold = alphabetHold.current;
    if (hold?.timer != null) window.clearTimeout(hold.timer);
    alphabetHold.current = null;
    const overlay = alphabetOverlayRef.current;
    if (overlay && !overlay.hidden) overlay.hidden = true;
  }, []);

  const updateAlphabetOverlay = useCallback((item: HTMLElement) => {
    const hold = alphabetHold.current;
    if (!hold) return;
    const overlay = alphabetOverlayRef.current;
    const title = item.dataset.browserSortTitle;
    if (!title || !contentRef.current?.contains(item)) {
      hideAlphabetOverlay();
      return;
    }
    hold.item = item;
    if (!overlay || hold.timer != null) return;
    const label = alphabetGroup(title);
    if (overlay.textContent !== label) overlay.textContent = label;
    overlay.hidden = false;
  }, [hideAlphabetOverlay]);

  const invalidateTabLoad = useCallback(() => {
    cancelContentScroll();
    hideAlphabetOverlay();
    loadingMoreRef.current = false;
    lastCollectionItem.current = null;
    setLoadingMore(false);
    setPaginationError('');
    return ++tabLoadRequestId.current;
  }, [cancelContentScroll, hideAlphabetOverlay]);

  const selectTab = useCallback((tab: BrowserTab) => {
    if (tab === activeTabRef.current) return;
    activeTabRef.current = tab;
    // Invalidate outstanding root and pagination requests synchronously when
    // focus moves between categories. The effect below then loads only the new tab.
    invalidateTabLoad();
    pendingSortFocus.current = null;
    pendingFocusId.current = undefined;
    pendingHomeRow.current = undefined;
    pendingScrollTop.current = undefined;
    enterContentPending.current = false;
    pendingSearchFocus.current = false;
    pendingSearchInputFocus.current = false;
    setItems([]);
    setTabHasMore(false);
    setError(null);
    setLoading(tab !== 'search');
    setActiveTab(tab);
  }, [invalidateTabLoad]);

  const openSearch = useCallback(() => {
    if (activeTabRef.current !== 'search') {
      selectTab('search');
    } else if (subView && subView.type !== 'search') {
      invalidateTabLoad();
      setSubView(null);
      setHistory([]);
      setError(null);
    }
    restoringHistoryRef.current = false;
    pendingFocusId.current = undefined;
    pendingScrollTop.current = undefined;
    pendingSearchFocus.current = false;
    enterContentPending.current = false;
    pendingSearchInputFocus.current = true;
    setRestoreFocusTick(value => value + 1);
  }, [selectTab, subView, invalidateTabLoad]);

  const keepFocusedElementVisible = (element: HTMLElement, sidebar = false) => {
    cancelContentScroll();
    hideAlphabetOverlay();
    window.cancelAnimationFrame(focusScrollFrame.current);
    focusScrollFrame.current = window.requestAnimationFrame(() => {
      const viewport = sidebar ? sidebarRef.current : contentRef.current;
      if (!viewport || !viewport.contains(element) || element !== document.activeElement) return;
      const itemRect = element.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      // Steam overlays a footer on the bottom of routed plugin views. Keep a
      // safe area for the sidebar and header controls.
      const visibleBottom = Math.min(viewportRect.bottom, window.innerHeight - (sidebar ? BROWSER_SIDEBAR_FOOTER_CLEARANCE : BROWSER_FOOTER_CLEARANCE));
      const edgePadding = BROWSER_FOCUS_EDGE_PADDING;
      const bottomOverflow = itemRect.bottom - (visibleBottom - edgePadding);
      const topOverflow = viewportRect.top + edgePadding - itemRect.top;
      const offset = bottomOverflow > 0 ? bottomOverflow : -Math.max(0, topOverflow);
      if (offset === 0) return;
      if (sidebar) viewport.scrollTop += offset;
      else viewport.scrollBy({ top: offset, behavior: 'smooth' });
    });
  };

  useEffect(() => () => {
    window.cancelAnimationFrame(focusScrollFrame.current);
    cancelContentScroll();
  }, [cancelContentScroll]);

  const cachedItems = useCallback(async (key: string, ttlMs: number, request: () => Promise<any>) => {
    const cache = itemCache.current;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return { items: cached.items, has_more: cached.hasMore,
      next_offset: cached.nextOffset, recent_offsets: cached.recentOffsets };
    const pending = pendingItems.current;
    const existing = pending.get(key);
    if (existing) return existing;
    const load = retryPlexRead(request).then(result => {
      if (cache === itemCache.current && Array.isArray(result?.items) && !result?.error) {
        cache.set(key, { items: result.items, hasMore: result.has_more,
          nextOffset: result.next_offset, recentOffsets: result.recent_offsets, expiresAt: Date.now() + ttlMs });
      }
      return result;
    }).finally(() => pending.delete(key));
    pending.set(key, load);
    return load;
  }, []);

  useEffect(() => {
    if (viewerExpanded || pendingSortFocus.current || pendingSearchInputFocus.current
        || pendingFocusId.current || pendingScrollTop.current != null) return;
    const frame = window.requestAnimationFrame(() => {
      const sidebar = sidebarRef.current;
      const focused = document.activeElement;
      if (!sidebar || sidebar.contains(focused) || contentRef.current?.contains(focused)) return;
      const target = sidebar.querySelector<HTMLElement>(`[data-browser-tab="${activeTabRef.current}"]`)
        ?? sidebar.querySelector<HTMLElement>('[data-browser-tab]');
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, connected, loadingLibraries, viewerExpanded]);

  useEffect(() => {
    invalidateTabLoad();
    setHistory([]);
    setSubView(null);
  }, [activeTab, invalidateTabLoad]);

  const goBack = useCallback(() => {
    const previous = history[history.length - 1];
    if (previous) {
      invalidateTabLoad();
      enterContentPending.current = false;
      pendingSearchFocus.current = false;
      setLoading(false);
      setError(null);
      restoringHistoryRef.current = previous.subView === null;
      setHistory(history.slice(0, -1));
      setItems(previous.items);
      setTabHasMore(previous.hasMore);
      setSubView(previous.subView);
      focusedItemId.current = previous.focusedItemId;
      // Returning from a search result should restore the search form itself.
      // Search inputs don't have a browser item id, so generic history focus
      // restoration otherwise leaves focus nowhere and the next B exits.
      pendingSearchInputFocus.current = activeTab === 'search' && previous.subView === null;
      pendingFocusId.current = pendingSearchInputFocus.current ? undefined : previous.focusedItemId;
      pendingHomeRow.current = previous.homeRow;
      pendingScrollTop.current = previous.scrollTop;
      setRestoreFocusTick(value => value + 1);
    } else {
      Navigation.NavigateBack();
    }
  }, [history, activeTab, invalidateTabLoad]);

  const focusBrowserTab = (scrollTop?: number) => {
    window.requestAnimationFrame(() => {
      if (scrollTop != null && contentRef.current) contentRef.current.scrollTop = scrollTop;
      sidebarRef.current?.querySelector<HTMLElement>(`[data-browser-tab="${activeTabRef.current}"]`)?.focus();
    });
  };

  const restoreBrowserFocus = () => {
    const { itemId, scrollTop, homeRow } = viewerOrigin.current;
    pendingFocusId.current = itemId;
    pendingHomeRow.current = homeRow;
    pendingScrollTop.current = itemId ? scrollTop : undefined;
    if (itemId) setRestoreFocusTick(value => value + 1);
    else focusBrowserTab(scrollTop);
  };

  const closeMedia = () => {
    setViewerItem(null);
    setViewerMinimized(false);
    setViewerQueue(null);
    setViewerResume(null);
    setViewerPresentation(null);
    setViewerStartPosition(undefined);
    restoreBrowserFocus();
  };

  const handleCancel = useCallback((event: Event) => {
    if (history.length === 0 && focusZone.current === 'content') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      window.setTimeout(() => {
        Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('[data-browser-tab]') || [])
          .find(tab => tab.dataset.browserTab === activeTab)?.focus();
      }, 0);
      return;
    }
    if (history.length === 0 && focusZone.current === 'sidebar') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      Navigation.NavigateBack();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (history.length > 0) goBack();
  }, [history.length, goBack, activeTab]);

  useEffect(() => {
    const onBackKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !viewerExpanded && !gridDialogRef.current && !actionDialogRef.current) handleCancel(event);
    };
    window.addEventListener('keydown', onBackKey, true);
    return () => window.removeEventListener('keydown', onBackKey, true);
  }, [handleCancel, viewerExpanded]);

  // Check connection status periodically
  useEffect(() => {
    let active = true;
    let requestId = 0;
    const checkConnection = async () => {
      const id = ++requestId;
      try {
        const result: any = await call("get_settings");
        if (!active || id !== requestId) return;
        setNeverWrapCategories(result.browser_never_wrap_categories === true);
        const savedColumns = Number(result.grid_columns);
        const validColumns = Number.isInteger(savedColumns) && savedColumns >= 3 && savedColumns <= 9;
        setGridPreferenceSet(validColumns);
        if (!gridDialogRef.current) {
          setGridColumns(validColumns ? savedColumns : DEFAULT_GRID_COLUMNS);
        }
        setShowAllMedia(Boolean(result.browse_all_media));
        setOverGamePip(result.over_game_pip === true);
        setVideoAutoplay(result.video_autoplay !== false);
        const layouts: BrowserLayouts = result.browser_layouts ?? {};
        const snapshot = JSON.stringify(layouts);
        if (snapshot !== layoutSnapshot.current) {
          layoutSnapshot.current = snapshot;
          browserLayoutsRef.current = layouts;
          setBrowserLayouts(layouts);
        }
        setLibrarySelectionKey((result.library_selection_ids || []).join(','));
        setHasPlexAccount(result.has_plex_token === true);
        setServerAddress(result.selected_server_url || '');
        setServerId(result.has_plex_token || result.local_server_enabled ? result.selected_server_id || '' : '');
      } catch {
        // Keep the current server while a settings read is temporarily unavailable.
      } finally {
        if (active && id === requestId) setCheckingConnection(false);
      }
    };
    checkConnection();
    const interval = setInterval(checkConnection, 15000);
    window.addEventListener('deckyplex-settings-change', checkConnection);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener('deckyplex-settings-change', checkConnection);
    };
  }, []);

  const shelf = sectionForTab(activeTab);
  const sorting = videoSorts[shelf] || VIDEO_SORTS[0].id;
  const sortable = !subView && libraries.some(library => library.id === shelf
    && (library.type === 'movie' || library.type === 'show'));

  useEffect(() => {
    if (viewerExpanded || ((loading || loadingLibraries) && !pendingSearchInputFocus.current)
      || (!pendingSortFocus.current && focusZone.current === 'sidebar' && !enterContentPending.current
      && !pendingSearchFocus.current && !pendingSearchInputFocus.current && pendingScrollTop.current == null)) return;
    let secondFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const sortFocus = pendingSortFocus.current;
        if (sortFocus) {
          // Wait for the chosen sort's data after Steam restores focus from the modal.
          const sortedPage = itemCache.current.get(`tab:${shelf}:${activeTab}:${sorting}`);
          if (!sortFocus.ready || sortFocus.tab !== activeTab || sortFocus.sort !== sorting || actionDialogRef.current
              || (sortedPage?.items !== items && !error)) return;
          const target = firstItemRef.current ?? sortButtonRef.current;
          if (!target) return;
          pendingSortFocus.current = null;
          if (contentRef.current) contentRef.current.scrollTop = 0;
          target.focus({ preventScroll: true });
          return;
        }
        if (pendingSearchInputFocus.current) {
          const input = searchFormRef.current?.querySelector('input');
          if (!input) return;
          pendingSearchInputFocus.current = false;
          pendingScrollTop.current = undefined;
          if (contentRef.current) contentRef.current.scrollTop = 0;
          input.focus({ preventScroll: true });
          return;
        }
        if (pendingFocusId.current) {
          const cards = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-browser-item-id]') || [])
            .filter(element => element.dataset.browserItemId === pendingFocusId.current);
          const wantedRow = pendingHomeRow.current;
          const target = cards.find(card => card.dataset.browserHomeRow === wantedRow)
            ?? (wantedRow && !homeData[wantedRow] ? null : cards[0]);
          if (target) {
            if (pendingScrollTop.current != null && contentRef.current) {
              contentRef.current.scrollTop = pendingScrollTop.current;
              pendingScrollTop.current = undefined;
            }
            keepHomeCardVisible(target);
            target.focus({ preventScroll: true });
            pendingFocusId.current = undefined;
            pendingHomeRow.current = undefined;
            return;
          }
          if (wantedRow && !subView && activeTab === 'videoHome' && !homeData[wantedRow]) return;
          pendingFocusId.current = undefined;
          pendingHomeRow.current = undefined;
          pendingScrollTop.current = undefined;
          enterContentPending.current = true;
        }
        if (pendingSearchFocus.current) {
          pendingSearchFocus.current = false;
          const target = firstItemRef.current ?? searchFormRef.current?.querySelector('input');
          target?.focus();
          return;
        }
        if (enterContentPending.current) {
          if (activeTab === 'videoHome' && !subView && !firstItemRef.current) return;
          if (contentRef.current) contentRef.current.scrollTop = 0;
          enterContentPending.current = false;
          if (!subView && activeTab === 'search') contentRef.current?.querySelector<HTMLElement>('input,button,[tabindex]')?.focus();
          else firstItemRef.current?.focus({ preventScroll: true });
          return;
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [loading, loadingLibraries, items, subView, activeTab, restoreFocusTick, viewerExpanded, shelf, sorting, error,
    checkingConnection, connected, homeData]);

  const saveGridColumns = useCallback(async (columns: number) => {
    const result: any = await call('set_settings', { grid_columns: columns });
    if (result?.error) throw new Error(result.error);
    setGridColumns(columns);
    setGridPreferenceSet(true);
  }, []);

  const openGridColumnsDialog = useCallback(() => {
    if (gridDialogRef.current) return;
    gridPromptShown.current = true;
    const clearDialog = () => {
      if (gridDialogRef.current === dialog) gridDialogRef.current = null;
    };
    const close = () => { clearDialog(); dialog.Close(); };
    const dialog = showModal(<GridColumnsDialog initialColumns={gridColumns}
      onPreview={setGridColumns} onConfirm={saveGridColumns} onClose={close} />,
      window, { strTitle: 'Browser layout', bNeverPopOut: true, fnOnClose: clearDialog });
    gridDialogRef.current = dialog;
    void dialog.ClosedPromise?.then(clearDialog, clearDialog);
  }, [gridColumns, saveGridColumns]);

  const openTrackOptions = useCallback((track: {
    id: string; sectionId: string; title: string; artist: string; album: string; duration: number; thumb: string;
  }, playlistId?: string) => {
    const clearDialog = () => {
      if (actionDialogRef.current === dialog) actionDialogRef.current = null;
    };
    const close = () => { clearDialog(); dialog.Close(); };
    const dialog = showModal(<TrackOptionsDialog track={{ ...track, sourceServerId: serverId }}
      playlistId={playlistId} allowPlaylists={hasPlexAccount} addToQueue={addToQueue} onClose={close} />,
      window, { strTitle: track.title, bNeverPopOut: true, fnOnClose: clearDialog });
    actionDialogRef.current = dialog;
    void dialog.ClosedPromise?.then(clearDialog, clearDialog);
  }, [addToQueue, serverId, hasPlexAccount]);

  const openPlaylistOptions = useCallback((playlist: LibraryItem) => {
    const clearDialog = () => {
      if (actionDialogRef.current === dialog) actionDialogRef.current = null;
    };
    const close = () => { clearDialog(); dialog.Close(); };
    const handleDeleted = (playlistId: string) => {
      itemCache.current.delete(`tab:${selectedSection}:playlists`);
      itemCache.current.delete(`playlist:${playlistId}`);
      setItems(current => current.filter(item => item.id !== playlistId));
      window.dispatchEvent(new CustomEvent('deckyplex-playlists-change', { detail: { playlistId } }));
      close();
    };
    const dialog = showModal(<PlaylistOptionsDialog playlist={playlist} onDeleted={handleDeleted} onClose={close} />,
      window, { strTitle: playlist.title, bNeverPopOut: true, fnOnClose: clearDialog });
    actionDialogRef.current = dialog;
    void dialog.ClosedPromise?.then(clearDialog, clearDialog);
  }, [selectedSection]);

  useEffect(() => {
    if (!connected || gridPreferenceSet || gridPromptShown.current) return;
    const timer = window.setTimeout(openGridColumnsDialog, 300);
    return () => window.clearTimeout(timer);
  }, [connected, gridPreferenceSet, openGridColumnsDialog]);

  useEffect(() => {
    setViewerItem(null);
    setViewerMinimized(false);
    setViewerQueue(null);
    setViewerResume(null);
    setViewerPresentation(null);
    setViewerStartPosition(undefined);
    if (!serverId) {
      setSelectedSection('');
      setLibraries([]);
      setLoadingLibraries(false);
      return;
    }
    let active = true;
    invalidateTabLoad();
    setSelectedSection('');
    setLibraries([]);
    setHomeData({});
    setPendingContinueRemovals(new Set());
    setVideoSorts({});
    setItems([]);
    setSubView(null);
    setHistory([]);
    itemCache.current = new Map();
    pendingItems.current = new Map();
    pendingVideoActions.current = new Set();
    watchlistMembership.current = new Map();
    tabFocusPositions.current.clear();
    homeShelfFocus.current.clear();
    pendingHomeRow.current = undefined;
    restoringHistoryRef.current = false;
    const initialTab = visibleCategories(musicBrowserCategories(hasPlexAccount), browserLayoutsRef.current.music)[0]?.key ?? 'search';
    selectTab(initialTab);
    setLoadingLibraries(true);
    setError(null);
    void retryPlexRead(() => call<[boolean], { sections?: LibrarySection[]; error?: string }>('get_library_sections', showAllMedia))
      .then(result => {
        if (!active) return;
        if (result?.error) throw new Error(result.error);
        if (!result?.sections?.length) throw new Error('No selected Plex libraries were found. Check Settings › Server.');
        setSelectedSection(result.sections.find(section => section.type === 'artist')?.id || '');
        setLibraries(result.sections);
        if (activeTabRef.current === initialTab && focusZone.current === 'sidebar' && !pendingSearchInputFocus.current) {
          const layouts = browserLayoutsRef.current;
          const music = result.sections.some(section => section.type === 'artist') ? musicBrowserCategories(hasPlexAccount) : [];
          const tab: BrowserTab = visibleCategories(music, layouts.music)[0]?.key
            ?? visibleCategories(videoCategories(result.sections, hasPlexAccount), layouts[`video:${serverId}`])[0]?.key ?? 'search';
          selectTab(tab);
          window.requestAnimationFrame(() => {
            if (active && focusZone.current === 'sidebar' && activeTabRef.current === tab && !pendingSearchInputFocus.current) {
              sidebarRef.current?.querySelector<HTMLElement>(`[data-browser-tab="${tab}"]`)?.focus();
            }
          });
        }
      })
      .catch(error => {
        if (!active) return;
        setLoading(false);
        setError(error instanceof Error ? error.message : 'Could not load Plex libraries.');
      })
      .finally(() => { if (active) setLoadingLibraries(false); });
    return () => { active = false; };
  }, [serverId, serverAddress, hasPlexAccount, showAllMedia, librarySelectionKey, invalidateTabLoad, selectTab]);

  useEffect(() => {
    if (!connected || loadingLibraries || !libraries.length || viewerExpanded || activeTab !== activeTabRef.current
        || tabs.some(tab => tab.key === activeTab)) return;
    const nextTab = tabs[0].key;
    setHistory([]);
    setSubView(null);
    restoringHistoryRef.current = false;
    pendingFocusId.current = undefined;
    pendingScrollTop.current = undefined;
    selectTab(nextTab);
    focusZone.current = 'sidebar';
    window.requestAnimationFrame(() => {
      if (activeTabRef.current === nextTab && focusZone.current === 'sidebar') {
        sidebarRef.current?.querySelector<HTMLElement>(`[data-browser-tab="${nextTab}"]`)?.focus();
      }
    });
  }, [activeTab, connected, libraries.length, loadingLibraries, selectTab, tabs, viewerExpanded]);

  useEffect(() => {
    if (!serverId) return;
    const restoreVideo = () => {
      const resume = takeGamePipFullscreen(serverId) ?? takePausedVideo(serverId);
      if (!resume) return;
      setViewerMinimized(false);
      setViewerSession(session => session + 1);
      viewerOrigin.current = { scrollTop: contentRef.current?.scrollTop || 0 };
      setViewerQueue(resume.episodes?.length ? resume.episodes : null);
      setViewerResume(resume);
      setViewerPresentation({ fullscreen: true, controlsHidden: resume.playing, volume: resume.volume, muted: resume.muted });
      setViewerStartPosition(undefined);
      setViewerItem(resume.item);
    };
    window.addEventListener(gamePipFullscreenEvent, restoreVideo);
    window.addEventListener(resumePausedVideoEvent, restoreVideo);
    restoreVideo();
    return () => {
      window.removeEventListener(gamePipFullscreenEvent, restoreVideo);
      window.removeEventListener(resumePausedVideoEvent, restoreVideo);
    };
  }, [serverId]);

  useEffect(() => {
    if (viewerItem?.type !== 'episode' || !serverId) return;
    if (viewerQueue) return;
    let active = true;
    void getEpisodeQueue(viewerItem.id, serverId).then(episodes => {
      if (active && episodes?.length) {
        const upcoming = queueFromEpisode(episodes, viewerItem.id);
        if (!upcoming.length) return;
        setViewerQueue(previous => previous ?? upcoming);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [viewerItem, viewerQueue, serverId]);

  const openSortMenu = useCallback(() => {
    if (!sortable || gridDialogRef.current || actionDialogRef.current) return;
    const clearDialog = () => {
      if (actionDialogRef.current === dialog) actionDialogRef.current = null;
    };
    const close = (sort?: string) => {
      if (actionDialogRef.current !== dialog) return;
      actionDialogRef.current = null;
      dialog.Close();
      if (!sort || activeTabRef.current !== activeTab) return;
      tabFocusPositions.current.delete(activeTab);
      pendingFocusId.current = undefined;
      pendingScrollTop.current = undefined;
      enterContentPending.current = false;
      pendingSortFocus.current = { tab: activeTab, sort, ready: sort === sorting };
      if (sort !== sorting) {
        invalidateTabLoad();
        setVideoSorts(current => ({ ...current, [shelf]: sort }));
      }
      setRestoreFocusTick(value => value + 1);
    };
    const dialog = showModal(
      <ModalRoot closeModal={() => close()} onCancel={() => close()} onOK={() => {}}>
        <ChoiceDialogBody title="Sort by">
          <ChoiceDialogList>
            {VIDEO_SORTS.map(({ id, title, Icon }) => (
              <ChoiceDialogRow key={id} title={title} icon={<Icon />} preferredFocus={id === sorting}
                selected={id === sorting} badge={id === sorting ? 'Selected' : undefined} onChoose={() => close(id)} />
            ))}
          </ChoiceDialogList>
        </ChoiceDialogBody>
      </ModalRoot>, window, { strTitle: 'Sort library', bNeverPopOut: true, fnOnClose: clearDialog },
    );
    actionDialogRef.current = dialog;
    void dialog.ClosedPromise?.then(clearDialog, clearDialog);
  }, [activeTab, invalidateTabLoad, shelf, sortable, sorting]);

  useEffect(() => {
    if (!connected || loadingLibraries || subView || activeTab !== 'videoHome') return;
    let active = true;
    const rows: VideoHomeData = {};
    const hasMovies = libraries.some(library => library.type === 'movie');
    const hasTV = libraries.some(library => library.type === 'show');
    if (!hasMovies) rows.movies = { items: [] };
    if (!hasTV) rows.shows = { items: [] };
    if (!hasPlexAccount) {
      rows.watchlist = { items: [] };
      rows.continue = { items: [] };
      rows.next = { items: [] };
    }
    setLoading(false);
    const loadRow = (row: typeof VIDEO_HOME_ROWS[number]) => {
      void cachedItems(`video-home:${row.id}`, row.ttl,
        () => row.id === 'movies' || row.id === 'shows' ? call('get_video_home', row.id, false, {})
          : call('get_video_home', row.id, row.id === 'watchlist')).then(result => {
        if (!active) return;
        const items: LibraryItem[] = result?.items || [];
        if (row.id === 'continue') {
          const next = (item: LibraryItem) => item.type === 'episode' && !item.viewOffset;
          rows.next = { items: items.filter(next) };
          rows.continue = { items: items.filter(item => !next(item)), error: result?.error };
        } else rows[row.id] = { items, error: result?.error, recentOffsets: result?.recent_offsets };
      }).catch(() => {
        if (active) rows[row.id] = { items: [], error: 'Could not load this section.' };
        if (active && row.id === 'continue') rows.next = { items: [] };
      }).finally(() => {
        if (!active) return;
        setHomeData(current => row.id === 'continue'
          ? { ...current, continue: rows.continue, next: rows.next }
          : { ...current, [row.id]: rows[row.id] });
        setItems(VIDEO_HOME_ROWS.flatMap(entry => rows[entry.id]?.items || []));
      });
    };
    setHomeData({ ...rows });
    for (const row of VIDEO_HOME_ROWS) {
      if (row.id !== 'next' && !rows[row.id]) loadRow(row);
    }
    loadMoreHome.current = (id, retry) => {
      const current = rows[id];
      if (!current || !recentShelfHasMore(current) || current.paging || (current.pageError && !retry)) return;
      const updatePage = (page: VideoHomeShelf) => {
        rows[id] = page;
        setHomeData(data => ({ ...data, [id]: page }));
      };
      updatePage({ ...current, paging: true, pageError: false });
      void call<[VideoHomeRow, boolean, HomeRecentOffsets], {
        items?: LibraryItem[]; recent_offsets?: HomeRecentOffsets; error?: string;
      }>('get_video_home', id, false, current.recentOffsets!).then(result => {
        if (!active) return;
        if (result.error || !result.items || !result.recent_offsets) throw new Error('Could not load this section.');
        const existing = new Set(current.items.map(item => item.id));
        const items = [...current.items, ...result.items.filter(item => !existing.has(item.id))];
        const row = VIDEO_HOME_ROWS.find(row => row.id === id)!;
        itemCache.current.set(`video-home:${id}`, { items, recentOffsets: result.recent_offsets, expiresAt: Date.now() + row.ttl });
        updatePage({ items, recentOffsets: result.recent_offsets });
        setItems(VIDEO_HOME_ROWS.flatMap(entry => rows[entry.id]?.items || []));
      }).catch(() => {
        if (active) updatePage({ ...current, pageError: true });
      });
    };
    const refreshHomeRow = (row: typeof VIDEO_HOME_ROWS[number]) => {
      const key = `video-home:${row.id}`;
      const refresh = () => {
        if (!active) return;
        itemCache.current.delete(key);
        loadRow(row);
      };
      const pending = pendingItems.current.get(key);
      if (pending) void pending.then(refresh, refresh);
      else refresh();
    };
    const refreshContinueWatching = () => refreshHomeRow(VIDEO_HOME_ROWS[0]);
    const refreshWatchlist = () => refreshHomeRow(VIDEO_HOME_ROWS[4]);
    if (hasPlexAccount) {
      window.addEventListener(videoProgressEvent, refreshContinueWatching);
      window.addEventListener(videoWatchlistEvent, refreshWatchlist);
    }
    return () => {
      active = false;
      loadMoreHome.current = () => {};
      window.removeEventListener(videoProgressEvent, refreshContinueWatching);
      window.removeEventListener(videoWatchlistEvent, refreshWatchlist);
    };
  }, [activeTab, connected, libraries, loadingLibraries, subView, cachedItems, hasPlexAccount]);

  // Load data when tab changes
  useEffect(() => {
    if (!connected || loadingLibraries || subView) return;
    if (restoringHistoryRef.current) {
      restoringHistoryRef.current = false;
      return;
    }
    if (activeTab === 'videoHome') return;
    if (activeTab === 'search') {
      invalidateTabLoad();
      setLoading(false);
      setTabHasMore(false);
      setItems([]);
      return;
    }
    const libraryId = sectionForTab(activeTab);
    if (activeTab === 'videoWatchlist'
        || (libraryId ? libraries.some(library => library.id === libraryId) : selectedSection)) loadTabData(activeTab);
  }, [activeTab, connected, selectedSection, libraries, loadingLibraries, subView, sorting, invalidateTabLoad]);

  const loadTabData = useCallback(async (tab: BrowserTab) => {
    const requestId = invalidateTabLoad();
    setError(null);
    const libraryId = sectionForTab(tab);
    const cacheKey = tab === 'videoWatchlist' ? watchlistTabCache
      : `tab:${libraryId || selectedSection}:${tab}${libraryId ? `:${sorting}` : ''}`;
    const finishSortFocus = () => {
      const focus = pendingSortFocus.current;
      if (focus?.tab === tab && focus.sort === sorting && !focus.ready) {
        focus.ready = true;
        setRestoreFocusTick(value => value + 1);
      }
    };
    const cached = itemCache.current.get(cacheKey);
    const expectedTypes: Partial<Record<BrowserTab, string[]>> = {
      artists: ['artist'], albums: ['album'], tracks: ['track'], recent: ['track'],
      recentlyAdded: ['album'], playlists: ['playlist'], videoWatchlist: ['movie', 'show'],
    };
    const cachedTabItems = cached && expectedTypes[tab]
      ? cached.items.filter(item => expectedTypes[tab]?.includes(item.type))
      : cached?.items;
    const cacheIsFresh = !!cached && cached.expiresAt > Date.now();
    const ttl = tab === 'recent' ? 15000 : tab === 'playlists' || tab === 'videoWatchlist' ? 60000 : LIBRARY_CACHE_TTL;
    if (cached) {
      setItems(cachedTabItems || []);
      setTabHasMore(Boolean(cached.hasMore));
    } else {
      setItems([]);
      setTabHasMore(false);
    }
    setLoading(!cached);
    if (cacheIsFresh) {
      finishSortFocus();
      return;
    }
    try {
      let result: any;
      if (libraryId) {
        result = await cachedItems(cacheKey, ttl, () => call('get_section_contents', libraryId, '', PAGE_SIZE, 0, sorting));
      } else if (tab === 'videoWatchlist') {
        result = await cachedItems(cacheKey, ttl, () => call('get_video_home', 'watchlist', true));
      } else if (tab === 'artists' && combinedArtists) {
        result = await cachedItems(cacheKey, ttl, () => call('get_music_artists', PAGE_SIZE, 0));
      } else if (tab === 'recent') {
        result = await cachedItems(cacheKey, ttl, () => call('get_recently_played', selectedSection, 100));
      } else if (tab === 'recentlyAdded') {
        result = await cachedItems(cacheKey, ttl, () => call('get_recently_added', selectedSection, 100));
      } else if (tab === 'playlists') {
        result = await cachedItems(cacheKey, ttl, () => call('get_audio_playlists', 100));
      } else {
        const typeFilter = tab === 'artists' ? 'artist' : tab === 'albums' ? 'album' : 'track';
        result = await cachedItems(cacheKey, ttl, () => call("get_section_contents", selectedSection, typeFilter, PAGE_SIZE, 0));
      }
      if (requestId !== tabLoadRequestId.current) return;
      if (libraryId || tab === 'artists' || tab === 'albums' || tab === 'tracks') setTabHasMore(Boolean(result.has_more));
      if (result.error) {
        if (!cached) {
          setError(result.error);
          setItems([]);
        }
      } else if (Array.isArray(result.items)) {
        if (requestId !== tabLoadRequestId.current) return;
        const tabItems = expectedTypes[tab]
          ? result.items.filter((item: LibraryItem) => expectedTypes[tab]?.includes(item.type))
          : result.items;
        const ids = new Set(tabItems.map((item: LibraryItem) => item.id));
        const keepMusicPages = cached && !libraryId && cached.hasMore && (cachedTabItems?.length || 0) > tabItems.length;
        const displayedItems = keepMusicPages
          ? [...tabItems, ...(cachedTabItems || []).filter(item => !ids.has(item.id))]
          : tabItems;
        setItems(displayedItems);
        itemCache.current.set(cacheKey, {
          items: displayedItems,
          hasMore: Boolean(result.has_more),
          nextOffset: keepMusicPages ? cached.nextOffset ?? displayedItems.length : result.next_offset ?? result.items.length,
          expiresAt: Date.now() + ttl,
        });
      } else {
        setItems([]);
      }
    } catch (e) {
      if (requestId !== tabLoadRequestId.current) return;
      if (!cached) {
        setError("Failed to load items.");
        setItems([]);
      }
    } finally {
      if (requestId === tabLoadRequestId.current) {
        setLoading(false);
        finishSortFocus();
      }
    }
  }, [selectedSection, combinedArtists, sorting, cachedItems]);

  useEffect(() => {
    const refreshPlaylists = () => {
      itemCache.current.delete(`tab:${selectedSection}:playlists`);
      if (activeTab === 'playlists' && !subView) void loadTabData('playlists');
    };
    window.addEventListener('deckyplex-playlists-change', refreshPlaylists);
    return () => window.removeEventListener('deckyplex-playlists-change', refreshPlaylists);
  }, [selectedSection, activeTab, subView, loadTabData]);

  const loadMoreTabPage = useCallback(async () => {
    const mediaLibrary = sectionForTab(activeTab);
    const section = mediaLibrary || selectedSection;
    if (!tabHasMore || loadingMoreRef.current || !section || subView
      || (!mediaLibrary && !['artists', 'albums', 'tracks'].includes(activeTab))) return;
    const requestId = tabLoadRequestId.current;
    const requestedTab = activeTab;
    loadingMoreRef.current = true;
    setPaginationError('');
    setLoadingMore(true);
    try {
      const typeFilter = mediaLibrary ? '' : activeTab === 'artists' ? 'artist' : activeTab === 'albums' ? 'album' : 'track';
      const baseKey = `tab:${section}:${activeTab}${mediaLibrary ? `:${sorting}` : ''}`;
      const offset = itemCache.current.get(baseKey)?.nextOffset ?? items.length;
      const cacheKey = `${baseKey}:${offset}`;
      const result: any = await cachedItems(cacheKey, LIBRARY_CACHE_TTL,
        () => activeTab === 'artists' && combinedArtists
          ? call('get_music_artists', PAGE_SIZE, offset)
          : call('get_section_contents', section, typeFilter, PAGE_SIZE, offset, sorting));
      if (requestId !== tabLoadRequestId.current || requestedTab !== activeTab) return;
      if (result.error) {
        setPaginationError('Could not load more library items.');
        return;
      }
      const nextPage: LibraryItem[] = Array.isArray(result.items) ? result.items : [];
      const existing = new Set(items.map(item => item.id));
      const mergedItems = [...items, ...nextPage.filter(item => !existing.has(item.id))];
      const nextOffset = result.next_offset ?? offset + nextPage.length;
      const hasMore = Boolean(result.has_more) && nextOffset > offset;
      setItems(mergedItems);
      setTabHasMore(hasMore);
      itemCache.current.set(baseKey, {
        items: mergedItems,
        hasMore,
        nextOffset,
        expiresAt: Date.now() + LIBRARY_CACHE_TTL,
      });
    } catch (e) {
      if (requestId === tabLoadRequestId.current && requestedTab === activeTab) setPaginationError('Could not load more library items.');
    } finally {
      if (requestId === tabLoadRequestId.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [tabHasMore, selectedSection, combinedArtists, subView, activeTab, items.length, sorting, cachedItems]);

  // Keep the current page boundary available without restarting the held-input
  // listener when pagination appends rows.
  const nextPageAtBoundary = useRef<{ itemCount: number; load: typeof loadMoreTabPage } | null>(null);
  nextPageAtBoundary.current = !subView && tabHasMore && !paginationError
    ? { itemCount: items.length, load: loadMoreTabPage } : null;

  useEffect(() => {
    const viewport = contentRef.current;
    const target = moreItemsRef.current;
    if (!viewport || !target || !tabHasMore || loading || loadingMore || paginationError || viewerExpanded) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMoreTabPage();
    }, { root: viewport, rootMargin: '0px 0px 160px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [tabHasMore, loading, loadingMore, paginationError, loadMoreTabPage, viewerExpanded]);

  const loadAlbums = useCallback(async (artistId: string, artistName?: string) => {
    const requestId = invalidateTabLoad();
    setHistory(previous => [...previous, { items, subView, focusedItemId: focusedItemId.current, hasMore: tabHasMore, scrollTop: contentRef.current?.scrollTop || 0 }]);
    setFocusTreeVersion(version => version + 1);
    enterContentPending.current = true;
    setLoading(true);
    setError(null);
    setSubView({ type: 'albums', title: artistName || 'Albums', id: artistId });
    try {
      const result: any = await cachedItems(`children:${artistId}`, 300000, () => call("get_metadata_children", artistId));
      if (requestId !== tabLoadRequestId.current) return;
      if (Array.isArray(result.items)) {
        setItems(result.items);
      } else {
        setItems([]);
      }
    } catch (e) {
      if (requestId !== tabLoadRequestId.current) return;
      setError("Failed to load albums.");
      setItems([]);
    } finally {
      if (requestId === tabLoadRequestId.current) setLoading(false);
    }
  }, [items, subView, tabHasMore, cachedItems, invalidateTabLoad]);

  const loadPlaylistTracks = useCallback(async (playlistId: string, playlistName: string) => {
    const requestId = invalidateTabLoad();
    setHistory(previous => [...previous, { items, subView, focusedItemId: focusedItemId.current, hasMore: tabHasMore, scrollTop: contentRef.current?.scrollTop || 0 }]);
    setFocusTreeVersion(version => version + 1);
    enterContentPending.current = true;
    setLoading(true);
    setError(null);
    setSubView({ type: 'tracks', title: playlistName || 'Playlist', id: playlistId, queueLabel: 'Play Playlist' });
    try {
      const result: any = await cachedItems(`playlist:${playlistId}`, 60000, () => call('get_playlist_tracks', playlistId, 200));
      if (requestId !== tabLoadRequestId.current) return;
      if (Array.isArray(result.items)) setItems(result.items);
      else { setItems([]); if (result.error) setError(result.error); }
    } catch {
      if (requestId !== tabLoadRequestId.current) return;
      setError('Failed to load playlist tracks.');
      setItems([]);
    } finally {
      if (requestId === tabLoadRequestId.current) setLoading(false);
    }
  }, [items, subView, tabHasMore, cachedItems, invalidateTabLoad]);

  useEffect(() => {
    const refreshVisiblePlaylist = (event: Event) => {
      const playlistId = (event as CustomEvent<{ playlistId?: string }>).detail?.playlistId;
      if (!playlistId) return;
      itemCache.current.delete(`playlist:${playlistId}`);
      if (subView?.type !== 'tracks' || subView.queueLabel !== 'Play Playlist' || subView.id !== playlistId) return;
      const requestId = invalidateTabLoad();
      pendingFocusId.current = focusedItemId.current;
      pendingScrollTop.current = contentRef.current?.scrollTop;
      setLoading(true);
      setError(null);
      call('get_playlist_tracks', playlistId, 200).then((result: any) => {
        if (requestId !== tabLoadRequestId.current) return;
        if (result?.error) throw new Error(result.error);
        setItems(Array.isArray(result?.items) ? result.items : []);
        itemCache.current.set(`playlist:${playlistId}`, {
          items: Array.isArray(result?.items) ? result.items : [], expiresAt: Date.now() + 60000,
        });
      }).catch((error: any) => {
        if (requestId === tabLoadRequestId.current) setError(error?.message || 'Could not refresh playlist tracks.');
      }).finally(() => {
        if (requestId === tabLoadRequestId.current) setLoading(false);
      });
    };
    window.addEventListener('deckyplex-playlists-change', refreshVisiblePlaylist);
    return () => window.removeEventListener('deckyplex-playlists-change', refreshVisiblePlaylist);
  }, [subView, invalidateTabLoad]);

  const loadTracks = useCallback(async (albumId: string, albumName?: string) => {
    const requestId = invalidateTabLoad();
    setHistory(previous => [...previous, { items, subView, focusedItemId: focusedItemId.current, hasMore: tabHasMore, scrollTop: contentRef.current?.scrollTop || 0 }]);
    setFocusTreeVersion(version => version + 1);
    enterContentPending.current = true;
    setLoading(true);
    setError(null);
    setSubView({ type: 'tracks', title: albumName || 'Tracks', id: albumId, queueLabel: 'Play Album' });
    try {
      const result: any = await cachedItems(`children:${albumId}`, 300000, () => call("get_metadata_children", albumId));
      if (requestId !== tabLoadRequestId.current) return;
      if (Array.isArray(result.items)) {
        setItems(result.items);
      } else {
        setItems([]);
      }
    } catch (e) {
      if (requestId !== tabLoadRequestId.current) return;
      setError("Failed to load tracks.");
      setItems([]);
    } finally {
      if (requestId === tabLoadRequestId.current) setLoading(false);
    }
  }, [items, subView, tabHasMore, cachedItems, invalidateTabLoad]);

  const handleSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (!query) return;
    const requestId = invalidateTabLoad();
    if (subView?.type !== 'search') {
      setHistory(previous => [...previous, { items, subView, focusedItemId: focusedItemId.current, hasMore: tabHasMore, scrollTop: contentRef.current?.scrollTop || 0 }]);
    }
    pendingSearchFocus.current = true;
    setItems([]);
    setLoading(true);
    setError(null);
    setSubView({ type: 'search', title: 'Search Results' });
    try {
      const section = showAllMedia || libraries.length > 1 ? '' : selectedSection;
      const cacheKey = `search:${showAllMedia ? 'all' : section}:${query.toLowerCase()}`;
      const result: any = await cachedItems(cacheKey, 30000, () => call("search_library", query, section, 30, showAllMedia));
      if (requestId !== tabLoadRequestId.current) return;
      if (result?.error) throw new Error(result.error);
      setItems(Array.isArray(result?.items) ? result.items : []);
    } catch (e) {
      if (requestId !== tabLoadRequestId.current) return;
      setError("Search failed.");
    } finally {
      if (requestId === tabLoadRequestId.current) setLoading(false);
    }
  }, [searchQuery, selectedSection, items, subView, tabHasMore, showAllMedia, libraries.length, cachedItems, invalidateTabLoad]);

  const startTrackQueue = useCallback(async (sourceItems: LibraryItem[], startId?: string, requestedTrack?: LibraryItem) => {
    setPlaybackRequests(count => count + 1);
    try {
      const fullTrackQueue = sourceItems.filter(entry => entry.type === 'track').map(entry => ({
        id: entry.id,
        sectionId: entry.sectionId || selectedSection,
        title: entry.title || 'Unknown',
        artist: entry.grandparentTitle || entry.artist || '',
        album: entry.parentTitle || '',
        duration: entry.duration || 0,
        thumb: entry.thumb || '',
      }));
      if (!fullTrackQueue.length) throw new Error('No tracks found to play.');
      let selectedIndex = startId == null ? 0 : fullTrackQueue.findIndex(track => String(track.id) === String(startId));
      if (startId != null && selectedIndex < 0 && requestedTrack) {
        // A click can race a paginated list refresh. Preserve the clicked song
        // as the queue head instead of silently starting at item one.
        const clickedTrack = {
          id: String(requestedTrack.id), sectionId: requestedTrack.sectionId || selectedSection,
          title: requestedTrack.title || 'Unknown',
          artist: requestedTrack.grandparentTitle || requestedTrack.artist || '',
          album: requestedTrack.parentTitle || '', duration: requestedTrack.duration || 0,
          thumb: requestedTrack.thumb || '',
        };
        fullTrackQueue.unshift(clickedTrack);
        selectedIndex = 0;
      }
      const startIndex = selectedIndex >= 0 ? selectedIndex : 0;
      const trackInfo = fullTrackQueue[startIndex];
      const trackQueue = fullTrackQueue.slice(startIndex);
      console.info(`[DeckyPlex] starting queue at ${trackInfo.title} (${startIndex + 1}/${fullTrackQueue.length})`);
      itemCache.current.delete(`tab:${selectedSection}:recent`);
      const playerId = await readMusicPlaybackTarget();
      if (playerId) {
        const result = await playRemoteQueue(playerId, fullTrackQueue, trackInfo.id);
        if (!result.success) setError(result.error || 'Could not start playback on the selected remote player.');
        return;
      }
      const playbackToken = beginPlaybackRequest();
      // Get stream URL first, then play — playTrack must be called with a valid URL
      // so audio.play() can start immediately from this call stack.
      const result: any = await call("play_track", trackInfo.id, trackInfo.sectionId);
      if (!result?.success) {
        const message = result?.error || "Plex did not return a playable audio stream.";
        setError(message);
        console.error(`[DeckyPlex] play_track error:`, message);
        return;
      }
      if (result.stream_url) {
        console.log(`[DeckyPlex] Got stream URL, starting playback`);
        playTrack(result.stream_url, trackInfo, trackQueue, result.fallback_stream_url || '', undefined, playbackToken, result.local_connection);
      } else {
        setError("Plex returned no audio stream URL.");
      }
    } catch (e) {
      console.error(`[DeckyPlex] play_track exception:`, e);
      setError("Failed to play track.");
    } finally {
      setPlaybackRequests(count => count - 1);
    }
  }, [selectedSection, playTrack, readMusicPlaybackTarget, playRemoteQueue, beginPlaybackRequest]);

  const handlePlayTrack = useCallback((item: LibraryItem) => {
    void startTrackQueue(items, item.id, item);
  }, [items, startTrackQueue]);

  const handlePlayCollection = useCallback(async () => {
    if (!subView || playbackRequests) return;
    if (subView.type === 'albums' && subView.id) {
      setPlaybackRequests(count => count + 1);
      setError(null);
      try {
        const result: any = await cachedItems(`artistTracks:${subView.id}`, 300000,
          () => call('get_artist_tracks', subView.id));
        if (result.error) throw new Error(result.error);
        await startTrackQueue(result.items || []);
      } catch (e: any) {
        setError(e?.message || 'Failed to load artist tracks.');
      } finally {
        setPlaybackRequests(count => count - 1);
      }
    } else {
      await startTrackQueue(items);
    }
  }, [subView, playbackRequests, cachedItems, startTrackQueue, items]);

  const loadMediaCollection = useCallback(async (item: LibraryItem) => {
    const requestId = invalidateTabLoad();
    setHistory(previous => [...previous, { items, subView, focusedItemId: item.id,
      homeRow: !subView && activeTabRef.current === 'videoHome' ? focusedHomeRow.current : undefined,
      hasMore: tabHasMore, scrollTop: contentRef.current?.scrollTop || 0 }]);
    enterContentPending.current = true;
    setSubView({ type: 'media', id: item.id, title: item.title, mediaType: item.type });
    setItems([]);
    setTabHasMore(false);
    setLoading(true);
    setError(null);
    try {
      const result = await cachedItems(`children:${item.id}`, 60000, () => call('get_metadata_children', item.id));
      if (requestId !== tabLoadRequestId.current) return;
      if (result?.error) throw new Error(result.error);
      setItems(result?.items || []);
    } catch (error) {
      if (requestId === tabLoadRequestId.current) {
        setError(error instanceof Error ? error.message : 'Could not load this Plex collection.');
      }
    } finally {
      if (requestId === tabLoadRequestId.current) setLoading(false);
    }
  }, [items, subView, tabHasMore, cachedItems, invalidateTabLoad]);

  const openMedia = useCallback((item: LibraryItem, collectionQueue?: VideoItem[], startPosition?: number) => {
    if (item.type === 'movie' && pausedVideo?.resume.serverId === serverId && pausedVideo.resume.item.id === item.id) {
      const openPausedMovie = (position: number) => {
        updatePausedVideo(resume => ({ ...resume, position }));
        if (requestPausedVideo(true)) window.dispatchEvent(new Event(resumePausedVideoEvent));
      };
      const position = resumePosition(pausedVideo.resume.position * 1000, pausedVideo.duration * 1000, 1);
      if (startPosition !== undefined || !position) {
        openPausedMovie(startPosition ?? 0);
      } else if (!actionDialogRef.current) {
        actionDialogRef.current = showPlaybackStartDialog({
          title: item.title,
          actionTitle: 'Play movie',
          position,
          onClose: choice => {
            actionDialogRef.current = null;
            if (choice) openPausedMovie(choice === 'resume' ? position : 0);
          },
        });
      }
      return;
    }
    if (item.type !== 'photo') {
      clearPausedVideo();
      stopGamePip();
    }
    setViewerMinimized(false);
    setViewerSession(session => session + 1);
    setViewerResume(null);
    setViewerPresentation(null);
    setViewerStartPosition(startPosition);
    const queue = collectionQueue ?? (item.type === 'episode' && subView?.mediaType === 'season'
      ? queueFromEpisode(items.filter(entry => entry.type === 'episode'), item.id) : undefined);
    setViewerQueue(queue?.length ? queue : null);
    viewerOrigin.current = { itemId: collectionQueue ? focusedItemId.current : item.id, scrollTop: contentRef.current?.scrollTop || 0,
      homeRow: !subView && activeTabRef.current === 'videoHome' ? focusedHomeRow.current : undefined };
    setViewerItem(item);
  }, [items, pausedVideo, serverId, subView?.mediaType]);

  const patchVideoCards = useCallback((patch: (card: LibraryItem) => LibraryItem) => {
    const update = (cards: LibraryItem[]) => {
      const next = cards.map(patch);
      return next.some((card, index) => card !== cards[index]) ? next : cards;
    };
    setItems(update);
    setHistory(current => current.map(entry => ({ ...entry, items: update(entry.items) })));
    setHomeData(current => {
      const next = { ...current };
      for (const { id } of VIDEO_HOME_ROWS) {
        const row = current[id];
        if (row) next[id] = { ...row, items: update(row.items) };
      }
      return next;
    });
    for (const [key, page] of itemCache.current) {
      const cards = update(page.items);
      if (cards !== page.items) itemCache.current.set(key, { ...page, items: cards });
    }
  }, []);

  useEffect(() => {
    const applyProgress = (event: Event) => {
      const update = (event as CustomEvent<VideoProgressUpdate>).detail;
      if (!update || update.serverId !== serverId || update.view_count === undefined
          || pendingVideoActions.current.has(update.itemId)) return;
      patchVideoCards(card => {
        if (card.id === update.itemId && (card.type === 'movie' || card.type === 'episode')) {
          return { ...card, viewCount: update.view_count, viewOffset: update.view_offset };
        }
        const count = update.collections?.[card.id];
        return count != null && (card.type === 'show' || card.type === 'season')
          ? { ...card, viewedLeafCount: count } : card;
      });
    };
    window.addEventListener(videoProgressEvent, applyProgress);
    return () => window.removeEventListener(videoProgressEvent, applyProgress);
  }, [patchVideoCards, serverId]);

  const openVideoOptions = (item: LibraryItem, index: number, homeRow?: VideoHomeRow, queueNext?: () => void) => {
    const pending = pendingVideoActions.current;
    if (actionDialogRef.current || !serverId || pending.has(item.id)) return;
    const fromWatchlist = homeRow === 'watchlist' || (!subView && activeTab === 'videoWatchlist');
    const onWatchlist = fromWatchlist || !!(watchlistMembership.current.get(item.id)
      ?? (homeData.watchlist?.items.some(card => card.id === item.id)
        || itemCache.current.get(watchlistTabCache)?.items.some(card => card.id === item.id)));
    const clearDialog = () => {
      if (actionDialogRef.current === dialog) actionDialogRef.current = null;
    };
    const close = () => { clearDialog(); dialog.Close(); };
    const restoreAfterRemoval = () => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const content = contentRef.current;
        if (!content || activeTabRef.current !== activeTab || content.contains(content.ownerDocument.activeElement)
            || focusZone.current !== 'content' || actionDialogRef.current || subViewRef.current) return;
        const cards = content.querySelectorAll<HTMLElement>('[data-browser-item-id]');
        (cards[Math.min(index, cards.length - 1)] ?? sidebarRef.current?.querySelector<HTMLElement>(`[data-browser-tab="${activeTab}"]`))
          ?.focus({ preventScroll: true });
      }));
    };
    const apply = async (action: VideoAction, rating?: number | null) => {
      if (pending.has(item.id)) return;
      pending.add(item.id);
      close();
      const updateCard = (fields: Partial<LibraryItem>, parentDelta = 0, collections?: Record<string, number>) => patchVideoCards(card => {
        if (card.id === item.id && card.type === item.type) return { ...card, ...fields };
        if (card.type !== 'season' && card.type !== 'show') return card;
        const count = collections?.[card.id];
        if (count != null) return { ...card, viewedLeafCount: count };
        const parent = (card.type === 'season' && card.id === item.parentId) || (card.type === 'show' && card.id === item.grandparentId);
        if (parent && parentDelta && card.leafCount && card.viewedLeafCount != null)
          return { ...card, viewedLeafCount: Math.max(0, Math.min(card.leafCount, card.viewedLeafCount + parentDelta)) };
        return card;
      });
      const watched = action === 'mark_watched' || action === 'mark_unwatched';
      const dismissContinue = action === 'remove_continue';
      if (watched) {
        updateCard({ viewCount: action === 'mark_watched' ? Math.max(1, item.viewCount || 0) : 0, viewOffset: 0 });
        if (homeRow === 'continue' || (homeRow === 'next' && action === 'mark_watched')) restoreAfterRemoval();
      } else if (dismissContinue) {
        setPendingContinueRemovals(current => new Set([...current, item.id]));
        restoreAfterRemoval();
      } else if (action === 'rate') updateCard({ userRating: rating });
      try {
        const result = await call<[string, string, VideoAction, number | null], VideoActionResult>(
          'video_library_action', item.id, serverId, action, rating ?? null,
        );
        if (result?.error) throw new Error(result.error);
        if (pending !== pendingVideoActions.current) return;
        if (watched || dismissContinue) {
          if (watched) {
            const delta = Number(!!result.view_count) - Number(!!item.viewCount);
            updateCard({ viewCount: result.view_count, viewOffset: result.view_offset }, delta, result.collections);
          } else {
            setHomeData(current => {
              const updated = { ...current };
              for (const key of ['continue', 'next'] as const) {
                const row = updated[key];
                if (row) updated[key] = { ...row, items: row.items.filter(card => card.id !== item.id) };
              }
              return updated;
            });
          }
          itemCache.current.delete('video-home:continue');
          window.dispatchEvent(new Event(videoProgressEvent));
        } else if (action !== 'rate') {
          const added = result.on_watchlist === true;
          watchlistMembership.current.set(item.id, added);
          setHomeData(current => {
            const row = current.watchlist;
            if (!row) return current;
            const rest = row.items.filter(card => card.id !== item.id);
            return { ...current, watchlist: { items: added ? [item, ...rest] : rest } };
          });
          const watchingList = () => activeTabRef.current === 'videoWatchlist' && !subViewRef.current;
          if (!added && activeTabRef.current === 'videoWatchlist') {
            const remove = (cards: LibraryItem[]) => cards.filter(card => card.id !== item.id);
            if (watchingList()) setItems(remove);
            setHistory(current => current.map(entry => entry.subView ? entry : { ...entry, items: remove(entry.items) }));
          }
          if (!added && fromWatchlist) restoreAfterRemoval();
          const pendingWatchlist = pendingItems.current.get(watchlistTabCache);
          const invalidateWatchlist = () => {
            if (pending !== pendingVideoActions.current) return;
            itemCache.current.delete(watchlistTabCache);
            if (watchingList() && (!fromWatchlist || pendingWatchlist)) {
              void cachedItems(watchlistTabCache, 60000, () => call('get_video_home', 'watchlist', true)).then(result => {
                if (pending === pendingVideoActions.current && watchingList() && !result?.error && Array.isArray(result?.items)) {
                  setItems(result.items);
                  if (!added) restoreAfterRemoval();
                }
              }).catch(() => {});
            }
          };
          if (pendingWatchlist) void pendingWatchlist.then(invalidateWatchlist, invalidateWatchlist);
          else invalidateWatchlist();
          itemCache.current.delete('video-home:watchlist');
          window.dispatchEvent(new Event(videoWatchlistEvent));
        }
      } catch (error) {
        if (pending !== pendingVideoActions.current) return;
        if (watched) updateCard({ viewCount: item.viewCount, viewOffset: item.viewOffset });
        else if (action === 'rate') updateCard({ userRating: item.userRating });
        void toaster.toast({ title: 'DeckyPlex', body: error instanceof Error ? error.message : 'Could not update this Plex title.' });
      } finally {
        pending.delete(item.id);
        if (dismissContinue && pending === pendingVideoActions.current) {
          setPendingContinueRemovals(current => {
            const next = new Set(current);
            next.delete(item.id);
            return next;
          });
        }
      }
    };
    const dialog = showModal(
      <VideoOptionsDialog item={item} userRating={item.userRating} onWatchlist={onWatchlist}
        allowAccountActions={hasPlexAccount}
        canRemoveContinue={homeRow === 'continue' || homeRow === 'next'}
        playFromBeginning={() => { close(); openMedia(item, undefined, 0); }}
        queueNext={queueNext ? () => { close(); queueNext(); } : undefined} apply={(action, rating) => void apply(action, rating)} close={close} />,
      window, { strTitle: 'Video options', bNeverPopOut: true, fnOnClose: clearDialog },
    );
    actionDialogRef.current = dialog;
    void dialog.ClosedPromise?.then(clearDialog, clearDialog);
  };

  const collectionId = subView?.mediaType === 'show' || subView?.mediaType === 'season' ? subView.id : undefined;
  const collectionKey = collectionId && serverId ? `${serverId}:${collectionId}` : '';
  const requestCollection = useCallback(() => {
    if (!collectionKey || !collectionId) return Promise.resolve([]);
    if (collectionRequest.current?.key === collectionKey) return collectionRequest.current.episodes;
    const episodes = getEpisodeQueue(collectionId, serverId);
    collectionRequest.current = { key: collectionKey, episodes };
    // Prefetch and playback share this request. A failed prefetch must allow a later retry.
    void episodes.then(items => {
      if (!items?.length && collectionRequest.current?.episodes === episodes) collectionRequest.current = null;
    }, () => {
      if (collectionRequest.current?.episodes === episodes) collectionRequest.current = null;
    });
    return episodes;
  }, [collectionKey, collectionId, serverId]);

  useEffect(() => {
    if (!collectionKey) return;
    if (viewerExpanded) {
      collectionRequest.current = null;
      return;
    }
    const refresh = () => { void requestCollection().catch(() => {}); };
    const progressChanged = () => {
      collectionRequest.current = null;
      refresh();
    };
    refresh();
    window.addEventListener(videoProgressEvent, progressChanged);
    return () => window.removeEventListener(videoProgressEvent, progressChanged);
  }, [collectionKey, requestCollection, viewerExpanded]);

  const playVideoCollection = async () => {
    if (!collectionKey || !subView || playbackRequests || actionDialogRef.current) return;
    const requestId = tabLoadRequestId.current;
    setPlaybackRequests(count => count + 1);
    setError(null);
    try {
      const collection = await requestCollection();
      if (requestId !== tabLoadRequestId.current) return;
      const first = collection[0];
      if (!first) throw new Error('No episodes are available in this Plex collection.');
      const resume = resumeEpisode(collection);
      if (!resume || !collectionResumes(collection)) {
        openMedia(first, collection, 0);
        return;
      }

      const position = resumePosition(resume.viewOffset || 0, resume.duration || 0);
      actionDialogRef.current = showPlaybackStartDialog({
        title: subView.title,
        actionTitle: subView.mediaType === 'show' ? 'Play series' : 'Play season',
        firstLabel: episodeLabel(first),
        resumeLabel: episodeLabel(resume),
        position,
        onClose: start => {
          actionDialogRef.current = null;
          if (requestId !== tabLoadRequestId.current) return;
          if (start === 'resume') openMedia(resume, queueFromEpisode(collection, resume.id), position);
          if (start === 'beginning') openMedia(first, collection, 0);
        },
      });
    } catch (error) {
      if (requestId === tabLoadRequestId.current) {
        setError(error instanceof Error ? error.message : 'Could not play this Plex collection.');
      }
    } finally {
      setPlaybackRequests(count => count - 1);
    }
  };

  const handleItemClick = useCallback((item: LibraryItem) => {
    focusedItemId.current = item.id;
    if (item.type === 'artist') {
      loadAlbums(item.id, item.title);
    } else if (item.type === 'album') {
      loadTracks(item.id, item.title);
    } else if (item.type === 'playlist') {
      loadPlaylistTracks(item.id, item.title);
    } else if (item.type === 'track') {
      handlePlayTrack(item);
    } else if (['show', 'season', 'photoalbum'].includes(item.type)) {
      void loadMediaCollection(item);
    } else if (['movie', 'episode', 'clip', 'photo'].includes(item.type)) {
      openMedia(item);
    }
  }, [loadAlbums, loadTracks, loadPlaylistTracks, handlePlayTrack, loadMediaCollection, openMedia]);

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const homeView = !subView && activeTab === 'videoHome';
  const gridView = homeView || (!subView && activeTab === 'videoWatchlist') || subView?.type === 'albums' || subView?.type === 'media'
    || (!subView && (!!sectionForTab(activeTab) || ['artists', 'albums', 'recentlyAdded', 'playlists'].includes(activeTab)));
  const videoCollection = subView?.mediaType === 'show' || subView?.mediaType === 'season';
  const hasCollectionAction = videoCollection || subView?.type === 'albums' || subView?.type === 'tracks';
  const alphabeticallySorted = subView ? subView.type === 'albums'
    : shelf ? sorting.startsWith('titleSort:') : ['artists', 'albums', 'tracks', 'playlists'].includes(activeTab);

  // Steam calls this before positioning its focus ring. A handled scroll
  // replaces its default scroll, including when gamepad focus is virtual.
  const itemScroll = {
    ...focusOutlineProps,
    fnScrollIntoViewHandler: (focused: { Element?: HTMLElement }, previous?: { Element?: HTMLElement }) => {
      const viewport = contentRef.current;
      const item = focused.Element;
      if (!item || !viewport?.contains(item) || !viewport.offsetHeight) return false;
      window.cancelAnimationFrame(focusScrollFrame.current);

      const firstRow = homeView ? item.hasAttribute('data-browser-home-start')
        : Number(item.dataset.browserItemIndex) < (gridView ? gridColumns : 1);
      if (homeView) keepHomeCardVisible(item);
      const viewportRect = viewport.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const scale = viewportRect.height / viewport.offsetHeight;
      if (scale <= 0) return false;
      const itemCenter = viewport.scrollTop + ((itemRect.top + itemRect.bottom) / 2 - viewportRect.top) / scale;
      const visibleHeight = Math.max(0, viewport.clientHeight - BROWSER_FOOTER_CLEARANCE);
      const viewportCenter = viewport.clientTop + visibleHeight / 2;
      const maxScroll = viewport.scrollHeight - viewport.clientHeight;
      const top = firstRow ? 0 : Math.max(0, Math.min(maxScroll, itemCenter - viewportCenter));
      const movingBetweenItems = !!previous?.Element?.closest('[data-browser-item-id]') && viewport.contains(previous.Element);
      const activeScroll = contentScrollAnimation.current;
      if (!activeScroll || Math.abs(activeScroll.top - top) > 1) {
        cancelContentScroll();
        const startTop = viewport.scrollTop;
        const distance = top - startTop;
        if (movingBetweenItems && Math.abs(distance) > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          const duration = fastVerticalNavigation.current || activeScroll ? 90 : 210;
          const started = performance.now();
          const animation = { top, frame: 0 };
          const step = (time: number) => {
            const progress = Math.max(0, Math.min(1, (time - started) / duration));
            viewport.scrollTop = startTop + distance * (1 - (1 - progress) ** 3);
            if (progress < 1) animation.frame = window.requestAnimationFrame(step);
            else contentScrollAnimation.current = null;
          };
          contentScrollAnimation.current = animation;
          animation.frame = window.requestAnimationFrame(step);
        } else {
          viewport.scrollTop = top;
        }
      }
      updateAlphabetOverlay(item);

      const itemId = item.dataset.browserItemId;
      if (!subView && itemId) tabFocusPositions.current.set(activeTab, { itemId, scrollTop: top,
        homeRow: item.dataset.browserHomeRow as VideoHomeRow | undefined });
      return true;
    },
  };
  scrollHomeCard.current = (target, previous) => {
    itemScroll.fnScrollIntoViewHandler({ Element: target }, { Element: previous });
  };

  const scrollContentToTop = useCallback(() => {
    const viewport = contentRef.current;
    if (!viewport) return;
    window.cancelAnimationFrame(focusScrollFrame.current);
    cancelContentScroll();
    viewport.scrollTo({ top: 0, behavior: 'instant' });
  }, [cancelContentScroll]);

  const moveBetweenItems = (event: GamepadEvent, index: number) => {
    const { button } = event.detail;
    if (button !== GamepadButton.DIR_UP && button !== GamepadButton.DIR_DOWN) return;
    const nextIndex = index + (button === GamepadButton.DIR_UP ? -1 : 1);
    const target = nextIndex < 0 ? playCollectionRef.current ?? searchFormRef.current?.querySelector('input')
      : nextIndex < items.length ? contentRef.current?.querySelector<HTMLElement>(`[data-browser-item-index="${nextIndex}"]`) : null;
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (target === playCollectionRef.current) {
      hideAlphabetOverlay();
      scrollContentToTop();
    }
    focusForDirection(target, event);
  };

  const jumpToListTop = (event: import('@decky/ui').GamepadEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!items.length) return;
    scrollContentToTop();
    firstItemRef.current?.focus({ preventScroll: true });
  };

  const renderItemRow = (item: LibraryItem, idx: number, onClick: () => void, firstHomeRow = false, homeRow?: VideoHomeRow) => {
    const sortTitle = alphabeticallySorted ? item.titleSort || item.title : undefined;
    const kind = item.type;
    const showPoster = homeView && kind === 'episode';
    const rawImage = showPoster ? item.poster : kind === 'artist' ? item.art || item.thumb : item.thumb || item.art;
    const originalImage = rawImage && plexMediaUrl(rawImage, !hasPlexAccount);
    const gridImage = showPoster ? item.gridPoster : item.gridThumb;
    const imageUrl = gridImage ? plexMediaUrl(gridImage, !hasPlexAccount) : originalImage;
    const portrait = showPoster || ['movie', 'show', 'season'].includes(kind);
    const canQueueNext = kind === 'episode' && (pipEpisodeQueue || !!viewerQueue && viewerItem?.type === 'episode');
    const queueNext = () => {
      if (pipEpisodeQueue) queueGamePipEpisodeNext(item);
      else if (viewerItem) setViewerQueue(queue => insertNextEpisode(queue ?? [viewerItem], viewerItem.id, item));
    };
    const videoOptions = kind === 'movie' || kind === 'episode' || kind === 'show' || kind === 'season';
    const options = (event: GamepadEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.detail?.is_repeat) return;
      if (videoOptions) openVideoOptions(item, idx, homeRow, canQueueNext ? queueNext : undefined);
      else openPlaylistOptions(item);
    };
    const secondaryAction = (videoOptions && (hasPlexAccount || canQueueNext)) || kind === 'playlist' ? options : undefined;
    const secondaryLabel = secondaryAction ? 'Options' : undefined;
    const title = episodeLabel(item);
    const subtitle = showPoster && item.grandparentTitle
      ? title
      : kind === 'album' ? item.artist || item.grandparentTitle || item.parentTitle
      : kind === 'artist' && combinedArtists && !subView ? libraries.find(library => library.id === item.sectionId)?.name
      : undefined;
    const fallbackIcon = kind === 'track' ? <FaMusic />
      : kind === 'album' ? <FaCompactDisc /> : kind === 'playlist' ? <FaListUl />
      : ['movie', 'show', 'season', 'episode', 'clip'].includes(kind) ? <FaFilm />
      : ['photo', 'photoalbum'].includes(kind) ? <FaImage /> : <FaUser />;
    const restoreOriginalImage = (event: React.SyntheticEvent<HTMLImageElement>) => {
      if (originalImage && event.currentTarget.getAttribute('src') !== originalImage) {
        event.currentTarget.src = originalImage;
      }
    };
    const focusItem = () => {
      focusZone.current = 'content';
      focusedItemId.current = item.id;
      focusedHomeRow.current = homeRow;
      if (homeRow) homeShelfFocus.current.set(homeRow, item.id);
      if (subView) return;
      const previous = tabFocusPositions.current.get(activeTab);
      if (previous?.itemId !== item.id || previous.homeRow !== homeRow) {
        tabFocusPositions.current.set(activeTab, { itemId: item.id, homeRow, scrollTop: contentRef.current?.scrollTop || 0 });
      }
      if (!homeRow && !paginationError && idx >= items.length - (gridView ? gridColumns * 2 : 6)) void loadMoreTabPage();
    };
    if (gridView) {
      return (
        <Focusable
          key={item.id}
          ref={idx === 0 ? firstItemRef : undefined}
          data-browser-item-id={item.id}
          data-browser-item-index={idx}
          data-browser-sort-title={sortTitle}
          data-browser-card=""
          data-browser-home-start={firstHomeRow || undefined}
          data-browser-home-row={homeRow}
          onFocus={focusItem}
          onGamepadFocus={focusItem}
          {...itemScroll}
          onActivate={event => selectWithSound(event, onClick)}
          onClick={onClick}
          onCancel={handleCancel}
          onSecondaryActionDescription={secondaryLabel}
          onSecondaryButton={secondaryAction}
          style={{ display: 'flex', flexDirection: 'column', minWidth: 0, padding: '0 0.35rem 0.35rem', gap: '0.3rem',
            scrollMarginTop: idx < gridColumns && (!homeView || firstHomeRow) ? browserHeaderScrollMargin : undefined }}
        >
          <div style={{ width: '100%', aspectRatio: portrait ? '2 / 3'
              : ['episode', 'clip'].includes(kind) ? '16 / 9' : '1 / 1',
            position: 'relative', contain: 'paint', overflow: 'hidden', borderRadius: '4px', backgroundColor: 'rgba(255,255,255,0.1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {imageUrl ? <img src={imageUrl} alt="" loading="lazy" decoding="async" onError={restoreOriginalImage}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ opacity: 0.6, fontSize: '1.5rem' }}>{fallbackIcon}</span>}
            {videoOptions && <VideoWatchIndicator item={item} />}
          </div>
          <div style={{ fontWeight: 500, lineHeight: '1.2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
            {(showPoster ? item.grandparentTitle || title : title) || '(unknown)'}
          </div>
          {subtitle && (
            <div style={{ fontSize: '0.75rem', lineHeight: '1.15', opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
              {subtitle}
            </div>
          )}
          {item.type === 'playlist' && item.leafCount != null && (
            <div style={{ fontSize: '0.75rem', lineHeight: '1.15', opacity: 0.65, margin: 0 }}>{item.leafCount} tracks</div>
          )}
          {item.type === 'movie' && item.year ? (
            <div style={{ fontSize: '0.75rem', opacity: 0.65 }}>{item.year}</div>
          ) : null}
        </Focusable>
      );
    }
    const rowDetails = (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', minWidth: 0 }}>
            {imageUrl || videoOptions ? (
              <div style={{
                width: '40px',
                height: '40px',
                borderRadius: '4px',
                overflow: 'hidden',
                position: 'relative',
                flexShrink: 0,
                backgroundColor: 'rgba(255,255,255,0.1)',
              }}>
                {imageUrl ? <img src={imageUrl} alt="" loading="lazy" decoding="async" onError={restoreOriginalImage}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <span style={{ display: 'grid', placeItems: 'center', height: '100%', opacity: 0.6 }}>{fallbackIcon}</span>}
                {videoOptions && <VideoWatchIndicator item={item} compact />}
              </div>
            ) : (
              <div style={{ minWidth: '1.5rem', textAlign: 'center' }}>
                {fallbackIcon}
              </div>
            )}
            <div style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', justifyContent: 'center', gap: '0.1rem', overflow: 'hidden' }}>
              <div style={{ fontWeight: 500, lineHeight: '1.15', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
                {title || '(unknown)'}
              </div>
              {item.type === 'track' && (item.grandparentTitle || item.artist || item.parentTitle) && (
                <div style={{ fontSize: '0.75rem', lineHeight: '1.1', opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
                  {[item.grandparentTitle || item.artist, item.parentTitle].filter(Boolean).join(' · ')}
                </div>
              )}
              {item.type === 'album' && (item.artist || item.grandparentTitle || item.parentTitle) && (
                <div style={{ fontSize: '0.75rem', lineHeight: '1.1', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
                  {[item.artist || item.grandparentTitle || item.parentTitle, item.leafCount != null ? `${item.leafCount} tracks` : '', item.year || ''].filter(Boolean).join(' · ')}
                </div>
              )}
              {item.type === 'playlist' && item.leafCount != null && (
                <div style={{ fontSize: '0.75rem', lineHeight: '1.1', opacity: 0.6, margin: 0 }}>
                  {item.leafCount} track{item.leafCount === 1 ? '' : 's'}
                </div>
              )}
              {item.type !== 'album' && item.year && (
                <div style={{ fontSize: '0.75rem', lineHeight: '1.1', opacity: 0.6, margin: 0 }}>
                  {item.year}
                </div>
              )}
            </div>
            {item.type === 'track' && item.duration && (
              <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6, minWidth: '3rem', textAlign: 'right', flexShrink: 0 }}>
                {formatDuration(item.duration)}
              </DialogBodyText>
            )}
      </div>
    );
    const rowStyle = { display: 'block', width: '100%', boxSizing: 'border-box' as const, padding: '0.2rem 0.35rem',
      borderBottom: '1px solid rgba(255,255,255,0.08)', scrollMarginTop: idx === 0 ? browserHeaderScrollMargin : undefined };
    if (item.type === 'track') {
      const trackInfo = { id: item.id, sectionId: item.sectionId || selectedSection, title: item.title, artist: item.grandparentTitle || item.artist || '', album: item.parentTitle || '', duration: item.duration || 0, thumb: item.thumb || '' };
      return (
        <Focusable
          key={item.id}
            ref={idx === 0 ? firstItemRef : undefined}
            data-browser-item-id={item.id}
            data-browser-item-index={idx}
            data-browser-sort-title={sortTitle}
            onFocus={focusItem}
            onGamepadFocus={focusItem}
            {...itemScroll}
            onActivate={event => selectWithSound(event, onClick)}
            onClick={onClick}
            onCancel={handleCancel}
            onGamepadDirection={(event) => moveBetweenItems(event, idx)}
            onSecondaryActionDescription="Options"
            onSecondaryButton={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const playlistId = subView?.type === 'tracks' && subView.queueLabel === 'Play Playlist' ? subView.id : undefined;
              openTrackOptions(trackInfo, playlistId);
            }}
            style={rowStyle}
          >
            {rowDetails}
        </Focusable>
      );
    }
    return (
      <Focusable key={item.id} ref={idx === 0 ? firstItemRef : undefined} data-browser-item-id={item.id} data-browser-item-index={idx}
        data-browser-sort-title={sortTitle}
        onFocus={focusItem} onGamepadFocus={focusItem} {...itemScroll}
        onActivate={event => selectWithSound(event, onClick)} onClick={onClick}
        onCancel={handleCancel} onGamepadDirection={(event) => moveBetweenItems(event, idx)}
        onSecondaryActionDescription={secondaryLabel}
        onSecondaryButton={secondaryAction}
        style={rowStyle}>
        {rowDetails}
      </Focusable>
    );
  };

  const renderContent = () => {
    const visibleHomeRows = homeView ? VIDEO_HOME_ROWS.map(row => {
      const result = homeData[row.id];
      if (!result || (row.id !== 'continue' && row.id !== 'next')) return { ...row, result };
      return { ...row, result: { ...result, items: result.items.filter(item =>
        !pendingContinueRemovals.has(item.id) && (row.id === 'continue' ? !!item.viewOffset : !item.viewCount)) } };
    }) : [];
    const title = subView?.title || tabs.find(tab => tab.key === activeTab)?.title || 'Library';
    const initialLoading = (
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minHeight: '2.5rem', paddingInline: '0.35rem' }}>
        <InlineSpinner />
        <DialogBodyText style={{ margin: 0 }}>{checkingConnection ? 'Checking Plex connection…' : 'Loading…'}</DialogBodyText>
      </div>
    );
    if (checkingConnection) {
      return <div>
        <div style={browserHeaderStyle}><DialogLabel style={{ margin: 0 }}>{title}</DialogLabel></div>
        {initialLoading}
      </div>;
    }
    if (!connected) {
      return (
        <PanelSection>
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.7 }}>
              Sign in under Account or connect directly under Advanced to browse Plex.
            </DialogBodyText>
          </PanelSectionRow>
        </PanelSection>
      );
    }

    return (
      <div>
        <div style={browserHeaderStyle}>
          <DialogLabel style={{ flex: 1, minWidth: 0, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {title}
          </DialogLabel>
          {playbackRequests > 0 && <InlineSpinner />}
          {sortable && <Button ref={sortButtonRef} onClick={openSortMenu} onCancelButton={handleCancel}
            onOKActionDescription="Sort by">
            <span title="Press View to sort" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
              <FaRegClone aria-hidden="true" />{VIDEO_SORTS.find(sort => sort.id === sorting)?.title || 'Sort by'}
            </span>
          </Button>}
          {remoteTargetSelected && (
            <DialogBodyText style={{ color: '#9fc8ff', fontSize: '0.8rem', margin: 0 }}>
              Playback target: {remotePlayerName || 'remote Plex player'}
            </DialogBodyText>
          )}
          {hasCollectionAction && subView && !loading && (
            <Button key={`play-collection-${focusTreeVersion}`} ref={playCollectionRef}
              className="deckyplex-play-collection" noFocusRing
              onClick={videoCollection ? playVideoCollection : handlePlayCollection} onCancelButton={handleCancel}
              onOptionsActionDescription="Jump to top" onOptionsButton={jumpToListTop}>
              <FaPlay /><span style={{ marginLeft: '0.3rem' }}>{videoCollection
                ? subView.mediaType === 'show' ? 'Play series' : 'Play season'
                : remoteTargetSelected ? 'Play remotely' : subView.type === 'albums' ? 'Play Artist' : subView.queueLabel || 'Play All'}</span>
            </Button>
          )}
        </div>

        {activeTab === 'search' && (!subView || subView.type === 'search') && (
            <div ref={searchFormRef} style={{ width: '100%', padding: '0 0.35rem 0.7rem', boxSizing: 'border-box' }}>
              <Focusable flow-children="horizontal" onCancel={handleCancel} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', minWidth: 0 }}>
              <TextField
                label=""
                style={{ flex: '1 1 32rem', minWidth: '320px', width: '32rem', maxWidth: '70vw', boxSizing: 'border-box' }}
                value={searchQuery}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                placeholder={showAllMedia ? 'Search your Plex libraries…' : 'Search artists, albums, tracks…'}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSearch();
                  }
                }}
              />
              <Button onClick={handleSearch} aria-label="Search">
                <FaSearch />
              </Button>
            </Focusable>
            </div>
        )}

        {error && (
          <PanelSectionRow>
            <DialogBodyText style={{ color: '#ff6b6b' }}>{error}</DialogBodyText>
          </PanelSectionRow>
        )}

        {(loading || loadingLibraries) && initialLoading}
        {homeView && !loadingLibraries && !error && (
          <Focusable flow-children="column" onCancel={handleCancel}
            onOptionsActionDescription="Jump to top" onOptionsButton={jumpToListTop}>
            {visibleHomeRows.map((row, rowIndex) => {
              const { result } = row;
              if (result && !result.error && !result.items.length) return null;
              const startIndex = visibleHomeRows.slice(0, rowIndex)
                .reduce((count, previous) => count + (previous.result?.items.length || 0), 0);
              return <section key={row.id} style={{ marginBottom: '1rem' }}>
                <div style={{ padding: '0.25rem 0.35rem 0.5rem' }}>
                  <DialogLabel style={{ margin: 0 }}>{row.title}</DialogLabel>
                </div>
                {!result ? <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginInline: '0.35rem' }}>
                  <InlineSpinner /><span>Loading…</span>
                </div> : result.error ? <DialogBodyText style={{ margin: '0 0.35rem', opacity: 0.7 }}>
                  {result.error}
                </DialogBodyText> :
                  <Focusable flow-children="horizontal" data-home-shelf={row.id} onScroll={event => {
                    const shelf = event.currentTarget;
                    if (shelf.scrollLeft + shelf.clientWidth * 1.35 >= shelf.scrollWidth) loadMoreHome.current(row.id);
                  }} style={{ display: 'grid', gridAutoFlow: 'column',
                    gridAutoColumns: `calc((100% - ${(gridColumns - 1) * 0.5}rem) / ${gridColumns})`,
                    alignItems: 'start', gap: '0.5rem', boxSizing: 'border-box', width: '100%',
                    paddingBlock: '4px', overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none',
                    overscrollBehaviorX: 'contain', overflowAnchor: 'none' }}>
                    {result.items.map((item, index) => renderItemRow(item, startIndex + index, () => handleItemClick(item), startIndex === 0, row.id))}
                    {(result.paging || result.pageError) && <div role="status"
                      style={{ display: 'grid', placeItems: 'center', minHeight: '4rem', opacity: 0.75 }}>
                      {result.paging ? <InlineSpinner /> : 'Press right to retry'}
                    </div>}
                  </Focusable>}
              </section>;
            })}
          </Focusable>
        )}
        {!homeView && !loading && !loadingLibraries && !error && items.length > 0 && (
            <div style={{ width: '100%' }}>
            {gridView ? (
              <Focusable flow-children="geometric" onCancel={handleCancel}
                onOptionsActionDescription="Jump to top" onOptionsButton={jumpToListTop}
                style={{ display: 'grid', gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`, gap: '0.5rem', width: '100%' }}>
                {items.map((item, idx) => {
                  const handleClick = () => handleItemClick(item);
                  return renderItemRow(item, idx, handleClick);
                })}
              </Focusable>
            ) : (
              <Focusable key={`list-${activeTab}-${subView?.type || 'root'}-${subView?.id || ''}-${focusTreeVersion}`} flow-children="column" onCancel={handleCancel}
                onOptionsActionDescription="Jump to top" onOptionsButton={jumpToListTop}
                style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
                {items.map((item, idx) => {
                  const handleClick = () => handleItemClick(item);
                  return renderItemRow(item, idx, handleClick);
                })}
              </Focusable>
            )}
            </div>
        )}
        {gridView && !gridPreferenceSet && (
          <PanelSectionRow><Button onClick={openGridColumnsDialog}>Choose browser grid width</Button></PanelSectionRow>
        )}
        {!subView && tabHasMore && <div ref={moreItemsRef} aria-hidden="true" style={{ height: 1 }} />}
        {!subView && paginationError && (
          <PanelSectionRow><Button onClick={() => void loadMoreTabPage()}>Retry loading more</Button></PanelSectionRow>
        )}
        {!subView && loadingMore && (
          <PanelSectionRow>
            <div style={{ display: 'flex', justifyContent: 'center', width: '100%', padding: '0.35rem 0' }}>
              <Spinner style={{ width: '18px', height: '18px', flexShrink: 0 }} />
            </div>
          </PanelSectionRow>
        )}

        {!loading && !loadingLibraries && !error && !subView && activeTab !== 'search'
          && (homeView ? visibleHomeRows.every(row => row.result && !row.result.error && !row.result.items.length) : !items.length) && (
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>
              {activeTab === 'videoWatchlist' ? 'No Watchlist titles in the selected libraries yet. Add one from its X menu.' : 'No items found.'}
            </DialogBodyText>
          </PanelSectionRow>
        )}
        {!loading && !error && items.length === 0 && subView?.type === 'search' && (
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>No results found.</DialogBodyText>
          </PanelSectionRow>
        )}
        {!loading && !error && items.length === 0 && subView?.type === 'albums' && (
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>No albums found for this artist.</DialogBodyText>
          </PanelSectionRow>
        )}
        {!loading && !error && items.length === 0 && subView?.type === 'tracks' && (
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>No tracks found.</DialogBodyText>
          </PanelSectionRow>
        )}
        {!loading && !error && items.length === 0 && subView?.type === 'media' && (
          <PanelSectionRow><DialogBodyText style={{ opacity: 0.5 }}>No items found.</DialogBodyText></PanelSectionRow>
        )}
      </div>
    );
  };

  useEffect(() => {
    const browser = browserRef.current;
    if (viewerExpanded || !browser) return;
    const moveInHome = (event: Event, button?: GamepadButton) => {
      const active = (event.target as Element | null)?.closest?.<HTMLElement>('[data-browser-home-row]');
      const shelf = active?.closest<HTMLElement>('[data-home-shelf]');
      if (!active || !shelf) return false;
      let target: HTMLElement | undefined;
      if (button === GamepadButton.DIR_LEFT || button === GamepadButton.DIR_RIGHT) {
        const cards = Array.from(shelf.querySelectorAll<HTMLElement>('[data-browser-home-row]'));
        const index = cards.indexOf(active);
        const next = button === GamepadButton.DIR_RIGHT ? index + 1 : index - 1;
        target = cards[next];
        if (button === GamepadButton.DIR_RIGHT && next >= cards.length - 3) {
          loadMoreHome.current(active.dataset.browserHomeRow as VideoHomeRow, next === cards.length);
        }
      } else if (button === GamepadButton.DIR_UP || button === GamepadButton.DIR_DOWN) {
        const shelves = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-home-shelf]') || []);
        const destination = shelves[shelves.indexOf(shelf) + (button === GamepadButton.DIR_DOWN ? 1 : -1)];
        if (destination) {
          const wanted = homeShelfFocus.current.get(destination.dataset.homeShelf as VideoHomeRow);
          const cards = Array.from(destination.querySelectorAll<HTMLElement>('[data-browser-home-row]'));
          target = cards.find(card => card.dataset.browserItemId === wanted) ?? cards[0];
        }
      } else return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (target && target !== active) {
        if (target.dataset.browserHomeRow) scrollHomeCard.current(target, active);
        focusForDirection(target, event);
      }
      return true;
    };
    const moveAtBoundary = (event: Event, button: GamepadButton, repeat: boolean) => {
      if (button !== GamepadButton.DIR_UP && button !== GamepadButton.DIR_DOWN) return;
      // Steam sends controller input to the focused navigation node, which can
      // differ from the DOM's active element when Gaming Mode uses virtual focus.
      const active = event.target as HTMLElement | null;
      if (!active?.closest) return;
      const sidebar = sidebarRef.current;
      const content = contentRef.current;
      let target: HTMLElement | null | undefined;
      if (sidebar?.contains(active)) {
        const tab = active.closest('[data-browser-tab]');
        if (!tab) return;
        const tabs = Array.from(sidebar.querySelectorAll<HTMLElement>('[data-browser-tab]'));
        if (tab !== (button === GamepadButton.DIR_UP ? tabs[0] : tabs[tabs.length - 1])) return;
      } else if (content?.contains(active)) {
        const collection = playCollectionRef.current;
        if (collection?.contains(active)) {
          if (button === GamepadButton.DIR_DOWN) {
            target = lastCollectionItem.current ?? firstItemRef.current;
            lastCollectionItem.current = null;
          }
        } else if (button === GamepadButton.DIR_UP) {
          const card = active.closest<HTMLElement>('[data-browser-item-index]');
          if (!card || Number(card.dataset.browserItemIndex) >= (gridView ? gridColumns : 1)
              || (homeView && !card.hasAttribute('data-browser-home-start'))) return;
          lastCollectionItem.current = collection ? card : null;
          target = collection ?? searchFormRef.current?.querySelector('input');
        } else {
          const page = nextPageAtBoundary.current;
          const hold = alphabetHold.current;
          if (!page || hold?.button !== button || (!repeat && hold.timer != null)) return;
          const card = active.closest<HTMLElement>('[data-browser-item-index]');
          if (!card) return;
          const columns = gridView ? gridColumns : 1;
          const row = Math.floor(Number(card.dataset.browserItemIndex) / columns);
          // A partial next row is still navigable from every column.
          if ((row + 1) * columns < page.itemCount) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          void page.load();
          return;
        }
      } else return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const destination = target?.isConnected ? target
        : button === GamepadButton.DIR_DOWN && playCollectionRef.current?.contains(active) ? firstItemRef.current : null;
      if (destination && destination !== active) {
        if (destination === playCollectionRef.current) {
          hideAlphabetOverlay();
          scrollContentToTop();
        }
        focusForDirection(destination, event);
      }
    };
    let lastVerticalPress = -Infinity;
    const recordVerticalPress = (button: GamepadButton | undefined, repeat: boolean, target: EventTarget | null) => {
      if (button !== GamepadButton.DIR_UP && button !== GamepadButton.DIR_DOWN) {
        fastVerticalNavigation.current = false;
        hideAlphabetOverlay();
        return;
      }
      const now = performance.now();
      fastVerticalNavigation.current = repeat || now - lastVerticalPress < 225;
      lastVerticalPress = now;
      if (alphabetHold.current?.button === button) return;
      hideAlphabetOverlay();

      // Steam can dispatch focus events from the separate Gaming Mode window.
      const item = (target as Element | null)?.closest?.<HTMLElement>('[data-browser-sort-title]');
      if (!item || !contentRef.current?.contains(item)) return;
      const hold: NonNullable<typeof alphabetHold.current> = { button, item, timer: null };
      alphabetHold.current = hold;
      hold.timer = window.setTimeout(() => {
        if (alphabetHold.current !== hold) return;
        hold.timer = null;
        updateAlphabetOverlay(hold.item);
      }, ALPHABET_HOLD_DELAY);
    };
    const onButtonDown = (event: Event) => {
      const detail = (event as GamepadEvent).detail;
      const repeat = detail?.is_repeat === true;
      recordVerticalPress(detail?.button, repeat, event.target);
      if (detail?.button === GamepadButton.START && connected && !gridDialogRef.current && !actionDialogRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!detail.is_repeat) openSearch();
        return;
      }
      if (detail?.button === GamepadButton.SELECT && sortable && !gridDialogRef.current && !actionDialogRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!repeat) openSortMenu();
        return;
      }
      if (!homeView || !moveInHome(event, detail?.button)) moveAtBoundary(event, detail?.button, repeat);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const button = { ArrowUp: GamepadButton.DIR_UP, ArrowDown: GamepadButton.DIR_DOWN,
        ArrowLeft: GamepadButton.DIR_LEFT, ArrowRight: GamepadButton.DIR_RIGHT }[event.key];
      if (button === undefined || (!homeView && button !== GamepadButton.DIR_UP && button !== GamepadButton.DIR_DOWN)) return;
      recordVerticalPress(button, event.repeat, event.target);
      if (!homeView || !moveInHome(event, button)) moveAtBoundary(event, button, event.repeat);
    };
    const endRepeat = () => {
      fastVerticalNavigation.current = false;
      hideAlphabetOverlay();
    };
    const releaseDirection = (button?: GamepadButton) => {
      if (button !== GamepadButton.DIR_UP && button !== GamepadButton.DIR_DOWN) return;
      if (!alphabetHold.current || alphabetHold.current.button === button) endRepeat();
    };
    const onButtonUp = (event: Event) => releaseDirection((event as GamepadEvent).detail?.button);
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp') releaseDirection(GamepadButton.DIR_UP);
      else if (event.key === 'ArrowDown') releaseDirection(GamepadButton.DIR_DOWN);
    };
    const ownerDocument = browser.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    browser.addEventListener('vgp_onbuttondown', onButtonDown, true);
    browser.addEventListener('keydown', onKeyDown, true);
    ownerDocument.addEventListener('vgp_onbuttonup', onButtonUp, true);
    ownerDocument.addEventListener('keyup', onKeyUp, true);
    ownerWindow?.addEventListener('blur', endRepeat);
    return () => {
      browser.removeEventListener('vgp_onbuttondown', onButtonDown, true);
      browser.removeEventListener('keydown', onKeyDown, true);
      ownerDocument.removeEventListener('vgp_onbuttonup', onButtonUp, true);
      ownerDocument.removeEventListener('keyup', onKeyUp, true);
      ownerWindow?.removeEventListener('blur', endRepeat);
      endRepeat();
    };
  }, [viewerExpanded, gridView, gridColumns, homeView, connected, openSearch, openSortMenu, sortable, activeTab, sorting,
    hideAlphabetOverlay, scrollContentToTop, updateAlphabetOverlay]);

  const enterContent = () => {
    focusZone.current = 'content';
    const savedPosition = tabFocusPositions.current.get(activeTab);
    enterContentPending.current = !savedPosition;
    if (savedPosition) {
      pendingFocusId.current = savedPosition.itemId;
      pendingHomeRow.current = savedPosition.homeRow;
      pendingScrollTop.current = savedPosition.scrollTop;
      setRestoreFocusTick(value => value + 1);
    }
    if (!loading && !loadingLibraries && (items.length > 0 || activeTab === 'search')) {
      if (!savedPosition) {
        enterContentPending.current = false;
        if (searchFormRef.current) searchFormRef.current.querySelector('input')?.focus();
        else firstItemRef.current?.focus({ preventScroll: homeView });
      }
    }
  };

  const episodes = viewerItem?.type === 'episode' ? viewerQueue ?? [viewerItem] : [];
  const playEpisode = (id: string, presentation: VideoPresentation) => {
    const next = latestViewerQueue.current?.find(episode => episode.id === id);
    if (!next || viewerItem?.id === id) return false;
    if (viewerOrigin.current.itemId && items.some(entry => entry.id === next.id)) viewerOrigin.current.itemId = next.id;
    setViewerResume(null);
    setViewerPresentation(presentation);
    setViewerStartPosition(undefined);
    setViewerItem(next);
    return true;
  };

  const browser = !viewerExpanded && (
    <Focusable onCancel={handleCancel} style={{ display: 'contents' }}>
      <FocusOutlineStyles />
      <style>{`
        [data-browser-card].deckyplex-focus-outline-active::after { top: -4px; }
        .deckyplex-play-collection:is(.gpfocus, :focus) {
          outline: 2px solid rgba(255, 255, 255, 0.6) !important;
          outline-offset: -3px;
        }
        [data-browser-zone="sidebar"] {
          width: max-content; max-width: min(17rem, 30vw);
        }
        [data-browser-alphabet]:not([hidden]) { display: grid; place-items: center; }
      `}</style>
    <div
      ref={browserRef}
      onFocusCapture={(event) => {
        if (!(event.target instanceof HTMLElement)) return;
        const inSidebar = !!event.target.closest('[data-browser-zone="sidebar"]');
        focusZone.current = inSidebar ? 'sidebar' : 'content';
        if (inSidebar || !event.target.closest('[data-browser-item-id]')) {
          keepFocusedElementVisible(event.target, inSidebar);
        }
      }}
      style={{ display: 'flex', gap: '0.65rem', marginTop: '40px', height: 'calc(100% - 40px)', minHeight: 0,
        overflow: 'hidden' }}
    >
      <div data-browser-zone="sidebar" ref={sidebarRef}
        style={{ boxSizing: 'border-box', flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.1)',
          padding: `0.5rem 0.4rem ${BROWSER_SIDEBAR_FOOTER_CLEARANCE + BROWSER_FOCUS_EDGE_PADDING}px 0.2rem`,
          scrollPaddingBottom: BROWSER_SIDEBAR_FOOTER_CLEARANCE, overflowY: 'auto' }}>
        <div style={browserHeaderStyle}><DialogLabel style={{ margin: 0 }}>DeckyPlex</DialogLabel></div>
        <Focusable flow-children="column" onCancel={handleCancel} style={{ display: 'flex', flexDirection: 'column' }}>
          {tabs.map(({ key: tab, title, icon }) => (
            <Fragment key={tab}>
            {tab === visibleVideo[0]?.key &&
              <div style={{ margin: '0.45rem 0.65rem 0.35rem', fontSize: '0.73rem', color: '#aeb9c5' }}>Video</div>}
            <Focusable
              data-browser-tab={tab}
              preferredFocus={tab === activeTab}
              onFocus={() => {
                focusZone.current = 'sidebar';
                selectTab(tab);
              }}
              onActivate={event => selectWithSound(event, enterContent)}
              onClick={enterContent}
              style={{ display: 'flex', alignSelf: 'stretch', minHeight: '42px', boxSizing: 'border-box', alignItems: 'center', gap: '0.55rem', padding: '0.35rem 0.65rem', paddingInlineEnd: '1.825rem', marginBottom: '0.3rem', border: `1px solid ${activeTab === tab ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)'}`, background: activeTab === tab ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.035)', borderRadius: '4px' }}
            >
              <span style={{ display: 'inline-flex', width: '1.1rem', justifyContent: 'center', flexShrink: 0 }}>{icon}</span>
              <span title={neverWrapCategories ? title : undefined} style={{ minWidth: 0, fontWeight: 400, fontSize: '0.85rem',
                ...(neverWrapCategories
                  ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
                  : { whiteSpace: 'normal', overflowWrap: 'anywhere' }) }}>{title}</span>
              {tab === 'search' && connected && (
                <span role="img" aria-label="Start button shortcut" title="Start button shortcut"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginLeft: 'auto',
                    width: '1.2rem', height: '1rem', border: '1px solid rgba(255,255,255,0.3)', borderRadius: '4px', fontSize: '0.65rem' }}>
                  <FaBars aria-hidden="true" />
                </span>
              )}
            </Focusable>
            </Fragment>
          ))}
        </Focusable>
      </div>
      <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0 }}>
        <div data-browser-zone="content" ref={contentRef}
          onWheel={cancelContentScroll} onPointerDown={cancelContentScroll}
          style={{ height: '100%', overflowY: 'auto', scrollBehavior: 'auto', padding: `0.5rem 0.5rem ${BROWSER_FOOTER_CLEARANCE}px 0`,
            boxSizing: 'border-box', scrollPaddingTop: '28px', scrollPaddingBottom: `${BROWSER_FOOTER_CLEARANCE}px` }}>
          {renderContent()}
        </div>
        <div ref={alphabetOverlayRef} data-browser-alphabet="" hidden aria-hidden="true"
          style={{ position: 'absolute', inset: 0, paddingBottom: BROWSER_FOOTER_CLEARANCE, zIndex: 2, pointerEvents: 'none',
            background: 'rgba(12, 16, 21, 0.55)', backdropFilter: 'blur(4px)', color: '#fff',
            fontSize: 'clamp(4rem, 12vw, 8rem)', fontWeight: 700 }} />
      </div>
    </div>
    </Focusable>
  );

  return (
    <>
      {browser}
      {viewerItem && <MediaViewer key={`${viewerItem.id}:${viewerSession}`} item={viewerItem}
        subtitle={viewerItem.grandparentTitle || viewerItem.parentTitle}
        photo={viewerItem.type === 'photo'} initialVolume={localVolume} initialPlayback={viewerResume}
        initialPosition={viewerStartPosition}
        initialPresentation={viewerPresentation} close={closeMedia}
        minimized={viewerMinimized} onMinimizedChange={(minimized, queue) => {
          setViewerMinimized(minimized);
          if (minimized) restoreBrowserFocus();
          else if (queue) setViewerQueue(queue.length ? queue : null);
        }}
        overGamePip={overGamePip} autoplay={videoAutoplay}
        episodes={episodes} episodeQueueReady={!!viewerQueue} playEpisode={playEpisode}
        removeEpisode={id => {
          if (id !== viewerItem.id) setViewerQueue(queue => queue?.filter(episode => episode.id !== id) ?? null);
        }}
        onPlaying={() => { if (localMusicPlaying) pause(); }} />}
    </>
  );
});

function GridColumnsDialog({ initialColumns, onPreview, onConfirm, onClose }: {
  initialColumns: number;
  onPreview: (columns: number) => void;
  onConfirm: (columns: number) => Promise<void>;
  onClose: () => void;
}) {
  const [columns, setColumns] = useState(initialColumns);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const commitInProgress = useRef(false);
  const changeColumns = (next: number) => {
    if (commitInProgress.current) return;
    const value = Math.max(3, Math.min(9, next));
    setColumns(value);
    onPreview(value);
  };
  const saveColumns = async (value: number) => {
    if (commitInProgress.current) return;
    commitInProgress.current = true;
    setSaving(true);
    setError('');
    try {
      await onConfirm(value);
      onClose();
    } catch {
      setError('Could not save the grid width.');
      setSaving(false);
      commitInProgress.current = false;
    }
  };
  const confirm = () => saveColumns(columns);
  const cancel = () => {
    if (commitInProgress.current) return;
    setColumns(DEFAULT_GRID_COLUMNS);
    onPreview(DEFAULT_GRID_COLUMNS);
    void saveColumns(DEFAULT_GRID_COLUMNS);
  };
  const handleDirection = (event: import('@decky/ui').GamepadEvent) => {
    if (event.detail.button === GamepadButton.DIR_LEFT) {
      event.preventDefault();
      changeColumns(columns - 1);
    } else if (event.detail.button === GamepadButton.DIR_RIGHT) {
      event.preventDefault();
      changeColumns(columns + 1);
    }
  };
  return (
    <ModalRoot closeModal={cancel} onCancel={cancel} onOK={confirm} bDisableBackgroundDismiss={saving}>
      <ChoiceDialogBody title="Choose grid width">
        <ChoiceDialogList>
          <Focusable
            {...focusOutlineProps}
            flow-children="horizontal"
            onGamepadDirection={handleDirection}
            onActivate={event => selectWithSound(event, confirm)}
            onClick={confirm}
            onOKActionDescription="Confirm"
            role="slider"
            aria-label="Grid columns"
            aria-valuemin={3}
            aria-valuemax={9}
            aria-valuenow={columns}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                changeColumns(columns + (event.key === 'ArrowRight' ? 1 : -1));
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                void confirm();
              }
            }}
            style={{ boxSizing: 'border-box', padding: '0.65rem 0.8rem', borderRadius: '0.5rem',
              border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.45rem' }}>
              <span>Grid columns</span><strong>{columns}</strong>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: '0.28rem' }}>
              {Array.from({ length: 9 }, (_, index) => (
                <div key={index} style={{ height: '0.45rem', borderRadius: '3px', background: index < columns ? '#66c0f4' : 'rgba(255,255,255,0.2)' }} />
              ))}
            </div>
          </Focusable>
        </ChoiceDialogList>
        <PanelSectionRow>
          <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.8rem' }}>
            <DialogBodyText style={{ opacity: 0.7, margin: 0 }}>Change anytime in Settings › Interface.</DialogBodyText>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              {saving ? <InlineSpinner /> : <span aria-hidden="true" style={{ display: 'grid', placeItems: 'center', border: '1px solid currentColor', borderRadius: '50%', width: '1.15rem', height: '1.15rem', fontSize: '0.75rem' }}>A</span>}
              {saving ? 'Saving…' : 'Confirm'}
            </span>
          </div>
        </PanelSectionRow>
        {error && <PanelSectionRow><DialogBodyText>{error}</DialogBodyText></PanelSectionRow>}
      </ChoiceDialogBody>
    </ModalRoot>
  );
}

function PlaylistOptionsDialog({ playlist, onDeleted, onClose }: {
  playlist: LibraryItem;
  onDeleted: (playlistId: string) => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const deleting = useRef(false);
  const actionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (busy) return;
    const frame = window.requestAnimationFrame(() => actionRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [confirming, busy]);

  const deletePlaylist = async () => {
    if (deleting.current) return;
    deleting.current = true;
    setBusy(true);
    try {
      const result: any = await call('delete_audio_playlist', playlist.id);
      if (!result?.success) throw new Error(result?.error || 'Could not delete playlist.');
      onDeleted(playlist.id);
    } catch (error: any) {
      setMessage(error?.message || 'Could not delete playlist.');
      setConfirming(false);
    } finally {
      deleting.current = false;
      setBusy(false);
    }
  };

  const cancel = () => {
    if (deleting.current) return;
    if (confirming) setConfirming(false);
    else onClose();
  };

  return (
    <ModalRoot closeModal={cancel} onCancel={cancel} onOK={() => {}} bCancelDisabled={busy} bDisableBackgroundDismiss={busy}>
      <ChoiceDialogBody title={confirming ? 'Delete Playlist' : playlist.title}
        subtitle={confirming ? `Permanently delete “${playlist.title}”?` : `${playlist.leafCount ?? 0} tracks`}>
        <ChoiceDialogList>
          {confirming ? <>
            <ChoiceDialogRow key="keep" title="Keep Playlist" icon={<FaArrowLeft />} rowRef={actionRef} preferredFocus disabled={busy} onChoose={cancel} />
            <ChoiceDialogRow key="confirm" title="Delete Playlist" icon={<FaTrash />} destructive disabled={busy}
              onChoose={() => void deletePlaylist()} />
          </> : <ChoiceDialogRow key="ask" title="Delete Playlist" icon={<FaTrash />} rowRef={actionRef} destructive preferredFocus onChoose={() => {
            setMessage('');
            setConfirming(true);
          }} />}
        </ChoiceDialogList>
        {busy && <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
          <InlineSpinner /> Deleting playlist…
        </div>}
        {!!message && <DialogBodyText style={{ color: '#ff7777' }}>{message}</DialogBodyText>}
      </ChoiceDialogBody>
    </ModalRoot>
  );
}

function TrackOptionsDialog({ track, playlistId, allowPlaylists, addToQueue, onClose }: {
  track: Parameters<ReturnType<typeof usePlayer>['addToQueue']>[0];
  playlistId?: string;
  allowPlaylists: boolean;
  addToQueue: ReturnType<typeof usePlayer>['addToQueue'];
  onClose: () => void;
}) {
  const [view, setView] = useState<'actions' | 'playlists' | 'new'>('actions');
  const [playlists, setPlaylists] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [playlistName, setPlaylistName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const playlistKeyboard = useRef<{ HideVirtualKeyboard: () => void } | null>(null);
  const queueActionInProgress = useRef(false);
  const playlistLoadInProgress = useRef(false);
  const playlistActionInProgress = useRef(false);

  const queueTrack = async (playNext: boolean) => {
    if (busy || queueActionInProgress.current) return;
    queueActionInProgress.current = true;
    onClose();
    try {
      const result = await addToQueue(track, playNext);
      const message = result.success ? result.warning : result.error || 'Could not update the queue.';
      if (message) void toaster.toast({ title: 'DeckyPlex', body: message });
    } catch (error: any) {
      void toaster.toast({ title: 'DeckyPlex', body: error?.message || 'Could not update the queue.' });
    }
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('button, input, [tabindex="0"]')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [view, loading, playlists.length]);

  const showPlaylists = async () => {
    if (playlistLoadInProgress.current) return;
    playlistLoadInProgress.current = true;
    setView('playlists');
    setLoading(true);
    setMessage('');
    try {
      const result: any = await call('get_audio_playlists', 100);
      if (result?.error) throw new Error(result.error);
      setPlaylists(result?.items || []);
      setMessage('');
    } catch (error: any) {
      setMessage(error?.message || 'Could not load playlists.');
    } finally {
      playlistLoadInProgress.current = false;
      setLoading(false);
    }
  };

  const addToPlaylist = async (playlistId: string) => {
    if (playlistActionInProgress.current) return;
    playlistActionInProgress.current = true;
    setBusy(true);
    try {
      const result: any = await call('add_track_to_playlist', playlistId, track.id);
      if (!result?.success) throw new Error(result?.error || 'Could not add track to playlist.');
      setMessage(`Added to ${result.playlist || 'playlist'}.`);
      window.dispatchEvent(new CustomEvent('deckyplex-playlists-change', { detail: { playlistId } }));
    } catch (error: any) {
      setMessage(error?.message || 'Could not add track to playlist.');
    } finally {
      playlistActionInProgress.current = false;
      setBusy(false);
    }
  };

  const createPlaylist = async () => {
    const name = playlistName.trim();
    if (!name || playlistActionInProgress.current) return;
    playlistActionInProgress.current = true;
    setBusy(true);
    try {
      playlistKeyboard.current?.HideVirtualKeyboard?.();
      const result: any = await call('create_audio_playlist', name, track.id);
      if (!result?.success) throw new Error(result?.error || 'Could not create playlist.');
      setMessage(`Created ${result.playlist || name} and added this song.`);
      setPlaylists(items => [{ id: result.id, key: '', title: result.playlist || name, type: 'playlist' }, ...items]);
      setView('playlists');
      window.dispatchEvent(new CustomEvent('deckyplex-playlists-change', { detail: { playlistId: result.id } }));
    } catch (error: any) {
      setMessage(error?.message || 'Could not create playlist.');
    } finally {
      playlistActionInProgress.current = false;
      setBusy(false);
    }
  };

  const removeFromPlaylist = async () => {
    if (!playlistId || playlistActionInProgress.current) return;
    playlistActionInProgress.current = true;
    setBusy(true);
    try {
      const result: any = await call('remove_track_from_playlist', playlistId, track.id);
      if (!result?.success) throw new Error(result?.error || 'Could not remove track from playlist.');
      setMessage(`Removed from ${result.playlist || 'playlist'}.`);
      window.dispatchEvent(new CustomEvent('deckyplex-playlists-change', { detail: { playlistId } }));
    } catch (error: any) {
      setMessage(error?.message || 'Could not remove track from playlist.');
    } finally {
      playlistActionInProgress.current = false;
      setBusy(false);
    }
  };

  const handleDialogCancel = () => {
    if (busy) return;
    if (view === 'new') {
      setMessage('');
      setView('playlists');
    } else if (view === 'playlists') {
      setView('actions');
    } else {
      onClose();
    }
  };

  const showNewPlaylist = () => {
    setPlaylistName('');
    setMessage('');
    setView('new');
  };

  return (
    <ModalRoot closeModal={onClose} onCancel={handleDialogCancel} onOK={() => {}}>
      <ChoiceDialogBody bodyRef={menuRef} key={view}
        title={view === 'actions' ? track.title : view === 'new' ? 'New Playlist' : 'Add to Playlist'}
        subtitle={view === 'actions' ? [track.artist, track.album].filter(Boolean).join(' · ') : track.title}>
        {view === 'actions' && <ChoiceDialogList>
          <ChoiceDialogRow title="Play Next" icon={<FaStepForward />} disabled={busy} onChoose={() => void queueTrack(true)} />
          <ChoiceDialogRow title="Add to Queue" icon={<FaListOl />} disabled={busy} onChoose={() => void queueTrack(false)} />
          {allowPlaylists && <ChoiceDialogRow title="Add to Playlist" icon={<FaListUl />} disabled={busy} onChoose={() => void showPlaylists()} />}
          {playlistId && <ChoiceDialogRow title="Remove from Playlist" icon={<FaMinus />} disabled={busy}
            onChoose={() => void removeFromPlaylist()} />}
        </ChoiceDialogList>}
        {view === 'playlists' && <>
          {loading && <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <InlineSpinner /><DialogBodyText style={{ margin: 0 }}>Loading playlists…</DialogBodyText>
          </div>}
          {!loading && playlists.length === 0 && !message && <PanelSectionRow><DialogBodyText>No audio playlists yet. Create one for this song.</DialogBodyText></PanelSectionRow>}
          {!loading && <ChoiceDialogList>
            {playlists.map(playlist => <ChoiceDialogRow key={playlist.id} title={playlist.title} icon={<FaListUl />}
              actionDescription="Add to playlist" disabled={busy} onChoose={() => void addToPlaylist(playlist.id)} />)}
            <ChoiceDialogRow title="New Playlist" icon={<FaPlus />} disabled={busy} onChoose={showNewPlaylist} />
          </ChoiceDialogList>}
        </>}
        {view === 'new' && <ChoiceDialogList>
          <PanelSectionRow>
            <TextField label="Playlist name" value={playlistName} disabled={busy}
              {...{
                refKeyboardHandle: playlistKeyboard,
                strEnterKeyLabel: 'Create Playlist',
                onEnterKeyPress: () => { void createPlaylist(); },
              }}
              onChange={event => setPlaylistName(event.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                event.stopPropagation();
                if (!event.repeat) void createPlaylist();
              }} />
          </PanelSectionRow>
          <ChoiceDialogRow title="Create Playlist" icon={<FaPlus />} disabled={busy || !playlistName.trim()}
            onChoose={() => void createPlaylist()} />
        </ChoiceDialogList>}
        {busy ? <PanelSectionRow><DialogBodyText style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <InlineSpinner /> {view === 'new' ? 'Creating playlist…' : 'Updating…'}
        </DialogBodyText></PanelSectionRow> : !!message && <PanelSectionRow><DialogBodyText style={{ color: /^(Added to|Created|Removed from)/.test(message) ? '#78d99a' : '#ff7777' }}>{message}</DialogBodyText></PanelSectionRow>}
      </ChoiceDialogBody>
    </ModalRoot>
  );
}
