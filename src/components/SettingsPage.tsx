import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import {
  Dropdown,
  DropdownItem,
  gamepadDialogClasses,
  DialogBodyText,
  ButtonItem,
  Button,
  TextField,
  SliderField,
  ToggleField,
  SidebarNavigation,
  showModal,
} from '@decky/ui';
import { call } from '@decky/api';
import { FaUser, FaServer, FaMusic, FaCog, FaSlidersH } from 'react-icons/fa';
import { InlineSpinner } from './InlineSpinner';
import { stopGamePip } from './GamePip';
import { LibraryRow, PlexSetupDialog, type LibraryCatalog, type PlexServerOption } from './PlexSetupDialog';
import { musicBrowserCategories, videoCategories, type BrowserLayouts, type CategoryLayout } from './BrowserCategories';
import { BrowserCategoriesDialog } from './BrowserCategoriesDialog';
import { defaultPipPosition, pipPositions, type PipPosition } from './PipPosition';
import { PipPositionDialog } from './PipPositionDialog';
import { FocusOutlineStyles } from './FocusOutline';
import { InterfaceThemeStyles } from './InterfaceTheme';
import { videoQualityOptions } from './VideoQuality';

interface Settings {
  plexamp_url: string;
  plex_server_url: string;
  plex_token: string;
  has_plex_token: boolean;
  local_server_enabled: boolean;
  selected_server_id: string;
  selected_server_name: string;
  selected_server_url: string;
  selected_player_id: string;
  selected_player_name: string;
  logged_in_username: string;
  server_access_token: string;
  manual_server_url: string;
  playback_target: 'local' | 'remote';
  connection_timeout: number;
  verify_tls: boolean;
  grid_columns: number;
  browser_layouts: BrowserLayouts;
  browser_never_wrap_categories: boolean;
  interface_theme: 'light' | 'dark';
  companion_receiver_enabled: boolean;
  companion_device_name: string;
  allow_signed_out_companion: boolean;
  hide_quick_login: boolean;
  quick_player_maintain_x: boolean;
  quick_player_show_idle: boolean;
  quick_player_native_style: boolean;
  quick_player_compact_header: boolean;
  quick_player_close_tray_on_back: boolean;
  over_game_pip: boolean;
  video_autoplay: boolean;
  video_quality: string;
  video_show_extras: boolean;
  pip_position: PipPosition;
  pip_size: number;
}

interface Player {
  name: string;
  product: string;
  machineIdentifier: string;
  state: string;
  platform?: string;
}

const DEFAULT_SETTINGS: Settings = {
  plexamp_url: "",
  plex_server_url: "",
  plex_token: "",
  has_plex_token: false,
  local_server_enabled: false,
  selected_server_id: "",
  selected_server_name: "",
  selected_server_url: "",
  selected_player_id: "",
  selected_player_name: "",
  logged_in_username: "",
  server_access_token: "",
  manual_server_url: "",
  playback_target: "local",
  connection_timeout: 8,
  verify_tls: false,
  grid_columns: 0,
  browser_layouts: {},
  browser_never_wrap_categories: false,
  interface_theme: 'dark',
  companion_receiver_enabled: false,
  companion_device_name: 'DeckyPlex',
  allow_signed_out_companion: false,
  hide_quick_login: false,
  quick_player_maintain_x: false,
  quick_player_show_idle: true,
  quick_player_native_style: false,
  quick_player_compact_header: true,
  quick_player_close_tray_on_back: true,
  over_game_pip: false,
  video_autoplay: true,
  video_quality: 'auto',
  video_show_extras: false,
  pip_position: defaultPipPosition,
  pip_size: 29,
};

function SettingsRow({ children }: { children: ReactNode }) {
  return <div className="deckyplex-settings-row">{children}</div>;
}

function SettingsSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="deckyplex-settings-section" aria-label={title}>
      {title && <h2>{title}</h2>}
      <div className="deckyplex-settings-fields">{children}</div>
    </section>
  );
}

function StatusLine({ text, busy, light }: { text: string; busy?: boolean; light?: string }) {
  return (
    <SettingsRow>
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minHeight: '1.2rem' }}>
        {busy ? <InlineSpinner /> : light && (
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: light }} />
        )}
        <DialogBodyText style={{ margin: 0 }}>{text}</DialogBodyText>
      </div>
    </SettingsRow>
  );
}

export function SettingsPage({ startLogin = false }: { startLogin?: boolean }) {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS });
  const [players, setPlayers] = useState<Player[]>([]);
  const [servers, setServers] = useState<PlexServerOption[]>([]);
  const [status, setStatus] = useState<string>("");
  const [serverStatus, setServerStatus] = useState("");
  const [refreshingServers, setRefreshingServers] = useState(false);
  const [selectingServer, setSelectingServer] = useState(false);
  const [companionStatus, setCompanionStatus] = useState<{ active: boolean; enabled?: boolean; port?: number; error?: string }>({ active: false });
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [settingsAvailable, setSettingsAvailable] = useState(false);
  const [checkingCompanionStatus, setCheckingCompanionStatus] = useState(true);
  const [receiverNameStatus, setReceiverNameStatus] = useState('');
  const [savingPlayerSettings, setSavingPlayerSettings] = useState(false);
  const [interfaceStatus, setInterfaceStatus] = useState('');
  const [savingInterface, setSavingInterface] = useState(false);
  const [playersStatus, setPlayersStatus] = useState("");
  const [browserStatus, setBrowserStatus] = useState("");
  const [libraryCatalog, setLibraryCatalog] = useState<LibraryCatalog | null>(null);
  const [librarySelection, setLibrarySelection] = useState<string[]>([]);
  const [loadingLibraries, setLoadingLibraries] = useState(false);
  const [savingLibraries, setSavingLibraries] = useState(false);
  const [libraryStatus, setLibraryStatus] = useState('');
  const [advancedStatus, setAdvancedStatus] = useState("");
  const [localAddress, setLocalAddress] = useState('');
  const [localConnectionStatus, setLocalConnectionStatus] = useState('');
  const [changingLocalConnection, setChangingLocalConnection] = useState(false);
  const localConnectionPending = useRef(false);
  const [loginAttempt, setLoginAttempt] = useState<{ id: string; pin: string } | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [connectingToPlex, setConnectingToPlex] = useState(false);
  const [settingUpPlex, setSettingUpPlex] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshingPlayers, setRefreshingPlayers] = useState(false);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const pendingQuickLogin = useRef(startLogin);
  const requestingLoginCode = useRef(false);
  const autoSaveTimer = useRef<number | null>(null);
  const autoSaveRevision = useRef(0);
  const pendingPreferences = useRef<Partial<Settings>>({});
  const libraryDraft = useRef<string[]>([]);
  const savedLibraries = useRef<string[]>([]);
  const librarySaveQueue = useRef(Promise.resolve());
  const libraryRevision = useRef(0);
  const setupDialog = useRef<ReturnType<typeof showModal> | null>(null);
  const categoriesDialog = useRef<ReturnType<typeof showModal> | null>(null);
  const pipPositionDialog = useRef<ReturnType<typeof showModal> | null>(null);
  const settingsMounted = useRef(false);

  const saveSettings = useCallback((s: Partial<Settings>) => {
    return call("set_settings", s).then((result: any) => {
      if (result?.error) {
        return result;
      } else {
        window.dispatchEvent(new CustomEvent('deckyplex-settings-change', { detail: result }));
      }
      return result;
    }).catch(() => {
      return { error: "Failed to save settings." };
    });
  }, []);

  const callWithTimeout = (method: string, timeoutMs: number = 5000, ...args: any[]): Promise<any> => {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error(`Backend call timed out (${timeoutMs / 1000}s): ${method}`)), timeoutMs,
      );
      call(method, ...args).then(resolve, reject).finally(() => window.clearTimeout(timeout));
    });
  };

  // Load settings on mount
  useEffect(() => {
    settingsMounted.current = true;
    callWithTimeout("get_settings", 10000)
      .then(async (result: any) => {
        if (!result || result.error) throw new Error(result?.error ?? 'Could not load settings.');
        settingsRef.current = result;
        setSettings(result);
        setSettingsAvailable(true);
        setLoadingSettings(false);
        try {
          // Read this local status before starting Plex discovery below. Discovery
          // uses synchronous PlexAPI requests and can block Decky's Python event
          // loop long enough for this otherwise-instant call to time out.
          const status = await callWithTimeout('get_companion_status', 15000);
          setCompanionStatus(status);
        } catch (error: any) {
          setCompanionStatus({ active: false, error: error?.message || 'Could not check receiver status' });
        } finally {
          setCheckingCompanionStatus(false);
        }
        setRefreshingServers(result.has_plex_token === true);
        void (async () => {
          try {
            if (result.has_plex_token) {
              const discoverResult: any = await callWithTimeout("discover_servers", 15000);
              if (discoverResult.servers) setServers(discoverResult.servers);
              if (settingsRef.current.has_plex_token && !settingsRef.current.selected_server_id) {
                const updated: Settings = await callWithTimeout('get_settings', 10000);
                settingsRef.current = updated;
                setSettings(updated);
              }
            }
            setRefreshingServers(false);
            setRefreshingPlayers(true);
            const playersResult: any = await callWithTimeout("discover_players", 30000);
            if (playersResult.players) setPlayers(playersResult.players);
          } catch (e: any) {
            console.error("[DeckyPlex] Plex discovery error:", e);
          } finally {
            setRefreshingServers(false);
            setRefreshingPlayers(false);
          }
        })();
      })
      .catch(() => {
        setLoadingSettings(false);
        setCheckingCompanionStatus(false);
        setStatus("Backend not responding. Make sure the plugin is loaded.");
      });
    return () => {
      settingsMounted.current = false;
      setupDialog.current?.Close();
      categoriesDialog.current?.Close();
    };
  }, []);

  useEffect(() => {
    libraryRevision.current++;
    setLibraryCatalog(null);
    setLibrarySelection([]);
    setLibraryStatus('');
    setSavingLibraries(false);
    if (settingUpPlex || !(settings.has_plex_token || settings.local_server_enabled) || !settings.selected_server_id) {
      setLoadingLibraries(false);
      return;
    }
    let active = true;
    setLoadingLibraries(true);
    void callWithTimeout('get_library_catalog', 20000).then((catalog: LibraryCatalog) => {
      if (!active) return;
      if (catalog.error) throw new Error(catalog.error);
      if (catalog.server_id !== settings.selected_server_id) throw new Error('Plex returned libraries for a different server.');
      setLibraryCatalog(catalog);
      const selected = catalog.selected_ids || [];
      savedLibraries.current = selected;
      libraryDraft.current = selected;
      setLibrarySelection(selected);
    }).catch(error => {
      if (active) setLibraryStatus(error instanceof Error ? error.message : 'Could not load Plex libraries.');
    }).finally(() => {
      if (active) setLoadingLibraries(false);
    });
    return () => { active = false; };
  }, [settingUpPlex, settings.has_plex_token, settings.local_server_enabled, settings.selected_server_id, settings.selected_server_url]);

  useEffect(() => {
    if (settings.local_server_enabled) setLocalAddress(settings.selected_server_url);
  }, [settings.local_server_enabled, settings.selected_server_url]);

  const handlePlexLogin = useCallback(async () => {
    if (requestingLoginCode.current || settingsRef.current.has_plex_token) return;
    requestingLoginCode.current = true;
    setLoggingIn(true);
    setLoginAttempt(null);
    setStatus('Requesting a login code…');
    try {
      const result: any = await callWithTimeout('plex_login', 35000);
      if (result?.error) throw new Error(result.error);
      if (!result?.login_id || !result.pin) throw new Error('Plex did not return a sign-in code.');
      setLoginAttempt({ id: result.login_id, pin: result.pin });
      setStatus('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not start Plex sign-in.');
    } finally {
      requestingLoginCode.current = false;
      setLoggingIn(false);
    }
  }, []);

  useEffect(() => {
    if (!pendingQuickLogin.current || loadingSettings) return;
    pendingQuickLogin.current = false;
    if (settingsAvailable && !settings.has_plex_token) void handlePlexLogin();
  }, [loadingSettings, settingsAvailable, settings.has_plex_token, handlePlexLogin]);

  // The backend completes sign-in even if Steam closes the Settings route.
  useEffect(() => {
    if (!loginAttempt) return;
    let active = true;
    let polling = false;
    const interval = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const result: any = await callWithTimeout('plex_login_poll', 10000, loginAttempt.id);
        if (!active) return;
        if (result.error) {
          setLoginAttempt(null);
          setConnectingToPlex(false);
          setStatus(result.error);
          return;
        }
        if (result.connecting) {
          setConnectingToPlex(true);
          setStatus('Plex approved. Finding your server…');
          return;
        }
        if (!result.logged_in) return;

        const connectedSettings: Settings = await callWithTimeout('get_settings', 10000);
        if (!active) return;
        const discoveredServers: PlexServerOption[] = result.servers || [];
        const applySettings = (next: Settings) => {
          settingsRef.current = next;
          setSettings(next);
          window.dispatchEvent(new CustomEvent('deckyplex-settings-change', { detail: next }));
        };
        setLoginAttempt(null);
        setConnectingToPlex(false);
        setSettingUpPlex(discoveredServers.length > 0);
        applySettings(connectedSettings);
        setServers(discoveredServers);
        setStatus(discoveredServers.length ? '' : 'Signed in to Plex. Check Server or Advanced to connect to a server.');
        if (discoveredServers.length) {
          const dialog = showModal(
            <PlexSetupDialog lightTheme={connectedSettings.interface_theme === 'light'}
              servers={discoveredServers} defaultServerId={connectedSettings.selected_server_id}
              loadLibraries={serverId => callWithTimeout('get_plex_setup_catalog', 30000, loginAttempt.id, serverId)}
              complete={async (serverId, selectedIds) => {
                const saved: Settings & { error?: string } = await callWithTimeout('complete_plex_setup', 20000, loginAttempt.id, serverId, selectedIds);
                if (saved.error) throw new Error(saved.error);
                if (settingsMounted.current) applySettings(saved);
              }}
              close={() => dialog.Close()}
            />,
            window, { strTitle: 'Set up Plex', bNeverPopOut: true },
          );
          setupDialog.current = dialog;
          // Decky's direct Close() does not invoke fnOnClose for this in-window modal.
          void dialog.ClosedPromise.then(() => {
              if (setupDialog.current !== dialog) return;
              setupDialog.current = null;
              void call('dismiss_plex_setup', loginAttempt.id).catch(() => {});
              if (!settingsMounted.current) return;
              setSettingUpPlex(false);
              setRefreshingPlayers(true);
              void callWithTimeout('discover_players', 30000)
                .then((playersResult: any) => { if (settingsMounted.current) setPlayers(playersResult.players || []); })
                .catch(() => {})
                .finally(() => { if (settingsMounted.current) setRefreshingPlayers(false); });
          });
        } else {
          void call('dismiss_plex_setup', loginAttempt.id).catch(() => {});
        }
      } catch (error) {
        if (active && !setupDialog.current) setSettingUpPlex(false);
        console.error('[DeckyPlex] Could not read sign-in status:', error);
      } finally {
        polling = false;
      }
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [loginAttempt]);

  const handleLogout = useCallback(async () => {
    setLoggingOut(true);
    setStatus("Logging out of Plex...");
    try {
      const cleared: any = await callWithTimeout("logout", 15000);
      settingsRef.current = cleared;
      setSettings(cleared);
      window.dispatchEvent(new CustomEvent('deckyplex-settings-change', { detail: cleared }));
      setServers([]);
      setPlayers([]);
      setStatus("Logged out.");
      setRefreshingPlayers(true);
      void callWithTimeout('discover_players', 30000)
        .then((result: any) => {
          if (settingsMounted.current && !settingsRef.current.has_plex_token) setPlayers(result.players || []);
        })
        .catch(() => {})
        .finally(() => { if (settingsMounted.current) setRefreshingPlayers(false); });
    } catch (e: any) {
      setStatus(e?.message || "Could not log out of Plex.");
    } finally {
      setLoggingOut(false);
    }
  }, []);

  const handleSelectServer = useCallback(async (serverId: string) => {
    const server = servers.find(s => s.id === serverId);
    if (!server || settingsRef.current.selected_server_id === serverId) return;
    setSelectingServer(true);
    setServerStatus('');
    try {
      await librarySaveQueue.current;
      const result: any = await callWithTimeout("select_server", 30000, server.id);
      if (!result?.success) throw new Error(result?.error || "Could not select Plex server.");
      settingsRef.current = result.settings;
      setSettings(result.settings);
      window.dispatchEvent(new CustomEvent('deckyplex-settings-change', { detail: result.settings }));
    } catch (error) {
      setServerStatus(error instanceof Error ? error.message : "Could not select Plex server.");
    } finally {
      setSelectingServer(false);
    }
  }, [servers]);

  const updatePlayerSettings = useCallback(async (changes: Partial<Settings>, refreshReceiver = false) => {
    setSavingPlayerSettings(true);
    setPlayersStatus('');
    if (refreshReceiver) setCheckingCompanionStatus(true);
    try {
      const saved: any = await saveSettings(changes);
      if (saved?.error) throw new Error(saved.error);
      const updated = { ...settingsRef.current };
      for (const key of Object.keys(changes) as (keyof Settings)[]) {
        Object.assign(updated, { [key]: saved[key] });
      }
      settingsRef.current = updated;
      setSettings(updated);
      if (refreshReceiver) setCompanionStatus(await callWithTimeout('get_companion_status', 15000));
    } catch (error) {
      setPlayersStatus(error instanceof Error ? error.message : 'Could not save player settings.');
    } finally {
      if (refreshReceiver) setCheckingCompanionStatus(false);
      setSavingPlayerSettings(false);
    }
  }, [saveSettings]);

  const handleSelectPlayer = (playerId: string) => {
    const player = players.find(p => p.machineIdentifier === playerId);
    void updatePlayerSettings({
      selected_player_id: playerId,
      selected_player_name: playerId ? player?.name || settingsRef.current.selected_player_name : '',
      playback_target: playerId ? 'remote' : 'local',
    });
  };

  const handleRefreshPlayers = useCallback(async () => {
    setRefreshingPlayers(true);
    try {
      const result: any = await callWithTimeout("discover_players", 30000);
      if (result.error) throw new Error(result.error);
      const nextPlayers = result.players || [];
      setPlayers(nextPlayers);
      setPlayersStatus(nextPlayers.length ? `Found ${nextPlayers.length} Plex player(s) on your network or Plex account.` : "No Plex players found.");
    } catch (e: any) {
      setPlayersStatus(e?.message || "Could not refresh Plex players.");
    } finally {
      setRefreshingPlayers(false);
    }
  }, []);

  const updateSetting = useCallback((key: keyof Settings, value: any) => {
    const updated = { ...settingsRef.current, [key]: value };
    settingsRef.current = updated;
    setSettings(updated);
    if (key === 'grid_columns') setBrowserStatus('Saving…');
    else if (key === 'companion_device_name') setReceiverNameStatus('Saving…');
    else if (key === 'pip_size' || key === 'pip_position') setInterfaceStatus('Saving…');
    else setAdvancedStatus('Saving…');
    pendingPreferences.current = { ...pendingPreferences.current, [key]: value };
    if (autoSaveTimer.current !== null) window.clearTimeout(autoSaveTimer.current);
    const revision = ++autoSaveRevision.current;
    autoSaveTimer.current = window.setTimeout(async () => {
      if (revision === autoSaveRevision.current) autoSaveTimer.current = null;
      const changes = pendingPreferences.current;
      pendingPreferences.current = {};
      const result: any = await saveSettings(changes);
      if (revision === autoSaveRevision.current) {
        const message = result?.error || 'Saved automatically.';
        if ('grid_columns' in changes) setBrowserStatus(message);
        if ('companion_device_name' in changes) setReceiverNameStatus(message);
        if ('pip_size' in changes || 'pip_position' in changes) setInterfaceStatus(result?.error || '');
        if (Object.keys(changes).some(key => !['grid_columns', 'companion_device_name', 'pip_size', 'pip_position'].includes(key))) setAdvancedStatus(message);
      }
    }, 350);
    return updated;
  }, [saveSettings]);

  useEffect(() => () => {
    if (autoSaveTimer.current !== null) {
      window.clearTimeout(autoSaveTimer.current);
      void saveSettings(pendingPreferences.current);
    }
  }, [saveSettings]);

  const saveInterfaceSetting = async <K extends 'hide_quick_login' | 'quick_player_maintain_x' | 'quick_player_show_idle'
    | 'quick_player_native_style' | 'quick_player_compact_header' | 'quick_player_close_tray_on_back'
    | 'over_game_pip' | 'video_autoplay'
    | 'browser_never_wrap_categories' | 'interface_theme' | 'video_show_extras' | 'video_quality'>(key: K, value: Settings[K]) => {
    setSavingInterface(true);
    setInterfaceStatus('');
    try {
      const result: any = await saveSettings({ [key]: value });
      if (result?.error) throw new Error(result.error);
      const updated = { ...settingsRef.current, [key]: value };
      settingsRef.current = updated;
      setSettings(updated);
      if (key === 'over_game_pip' && !value) stopGamePip();
    } catch (error) {
      setInterfaceStatus(error instanceof Error ? error.message : 'Could not save interface settings.');
    } finally {
      setSavingInterface(false);
    }
  };

  const openPipPosition = () => {
    if (pipPositionDialog.current) return;
    const clear = () => { if (pipPositionDialog.current === dialog) pipPositionDialog.current = null; };
    const close = () => { clear(); dialog.Close(); };
    const position = settingsRef.current.pip_position;
    const dialog = showModal(
      <PipPositionDialog lightTheme={settingsRef.current.interface_theme === 'light'} selected={position} close={close} choose={next => {
        if (pipPositionDialog.current !== dialog) return;
        if (next !== position) updateSetting('pip_position', next);
        close();
      }} />, window, { strTitle: 'Picture-in-picture position', bNeverPopOut: true, fnOnClose: clear },
    );
    pipPositionDialog.current = dialog;
    void dialog.ClosedPromise?.then(clear, clear);
  };

  const editBrowserCategories = (title: string, scope: string, categories: readonly { key: string; title: string }[]) => {
    if (categoriesDialog.current) return;
    const close = () => {
      categoriesDialog.current = null;
    };
    const dialog = showModal(
      <BrowserCategoriesDialog lightTheme={settingsRef.current.interface_theme === 'light'}
        title={title} categories={categories} initialLayout={settingsRef.current.browser_layouts?.[scope]}
        close={() => dialog.Close()} save={async (layout: CategoryLayout) => {
          const result = await saveSettings({ browser_layouts: { [scope]: layout } });
          if (result?.error) throw new Error(result.error);
          if (!settingsMounted.current) return;
          const updated = { ...settingsRef.current, browser_layouts: result.browser_layouts };
          settingsRef.current = updated;
          setSettings(updated);
        }} />,
      window, { strTitle: title, bNeverPopOut: true, fnOnClose: close },
    );
    categoriesDialog.current = dialog;
    void dialog.ClosedPromise?.then(close, close);
  };

  const testServerConnection = useCallback(async () => {
    if (advancedStatus === 'Testing Plex server connection…') return;
    if (autoSaveTimer.current !== null) window.clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = null;
    autoSaveRevision.current++;
    const pending = pendingPreferences.current;
    pendingPreferences.current = {};
    setAdvancedStatus("Testing Plex server connection…");
    try {
      const saved: any = await saveSettings(pending);
      if ('grid_columns' in pending) setBrowserStatus(saved?.error || 'Saved automatically.');
      if ('companion_device_name' in pending) setReceiverNameStatus(saved?.error || 'Saved automatically.');
      if (saved?.error) throw new Error(saved.error);
      const result: any = await callWithTimeout("validate_connection", 15000);
      setAdvancedStatus(result.valid ? `Connected to ${result.serverName || "Plex Media Server"}.` : `Connection failed: ${result.error}`);
    } catch (e: any) {
      setAdvancedStatus(e?.message || "Connection test failed.");
    }
  }, [advancedStatus, saveSettings]);

  const changeLocalConnection = async (disconnect = false) => {
    if (localConnectionPending.current || (!disconnect && !localAddress.trim())) return;
    localConnectionPending.current = true;
    setChangingLocalConnection(true);
    setLocalConnectionStatus(disconnect ? 'Disconnecting…' : 'Connecting to Plex…');
    try {
      const result = disconnect
        ? await call<[], Settings & { error?: string }>('disconnect_local_server')
        : await call<[string], Settings & { error?: string; catalog?: LibraryCatalog }>('connect_local_server', localAddress.trim());
      if (!result || result.error) throw new Error(result?.error || 'Could not change the local connection.');
      if (settingsMounted.current) {
        settingsRef.current = result;
        setSettings(result);
        setLocalConnectionStatus(disconnect ? 'Disconnected.' : '');
        if ('catalog' in result && result.catalog) {
          const catalog = result.catalog;
          setLoginAttempt(null);
          setConnectingToPlex(false);
          setStatus('');
          setSettingUpPlex(true);
          const server = { id: result.selected_server_id, name: result.selected_server_name };
          const dialog = showModal(
            <PlexSetupDialog lightTheme={settingsRef.current.interface_theme === 'light'} servers={[server]} defaultServerId={server.id}
              loadLibraries={async () => catalog}
              complete={async (serverId, selectedIds) => {
                const saved: Settings & { error?: string } = await callWithTimeout('set_library_selection', 20000, serverId, selectedIds);
                if (saved.error) throw new Error(saved.error);
                if (settingsMounted.current) {
                  settingsRef.current = saved;
                  setSettings(saved);
                }
                window.dispatchEvent(new CustomEvent('deckyplex-settings-change', { detail: saved }));
              }}
              close={() => dialog.Close()}
            />,
            window, { strTitle: 'Set up Plex', bNeverPopOut: true },
          );
          setupDialog.current = dialog;
          void dialog.ClosedPromise.then(() => {
            if (setupDialog.current !== dialog) return;
            setupDialog.current = null;
            if (settingsMounted.current) {
              setSettingUpPlex(false);
              void handleRefreshPlayers();
            }
          });
        }
      }
      window.dispatchEvent(new CustomEvent('deckyplex-settings-change', { detail: result }));
    } catch (error) {
      if (settingsMounted.current) setLocalConnectionStatus(error instanceof Error ? error.message : 'Could not change the local connection.');
    } finally {
      localConnectionPending.current = false;
      if (settingsMounted.current) setChangingLocalConnection(false);
    }
  };

  const toggleLibrary = (id: string, checked: boolean) => {
    const serverId = libraryCatalog?.server_id;
    if (!serverId) return;
    const current = libraryDraft.current;
    const selected = checked ? [...new Set([...current, id])] : current.filter(libraryId => libraryId !== id);
    if (!selected.length) return;
    libraryDraft.current = selected;
    setLibrarySelection(selected);
    const revision = ++libraryRevision.current;
    setSavingLibraries(true);
    setLibraryStatus('');
    librarySaveQueue.current = librarySaveQueue.current.then(async () => {
      if (revision !== libraryRevision.current || settingsRef.current.selected_server_id !== serverId) return;
      try {
        const result: any = await callWithTimeout('set_library_selection', 20000, serverId, selected);
        if (result?.error) throw new Error(result.error);
        if (settingsRef.current.selected_server_id !== serverId) return;
        savedLibraries.current = selected;
        if (revision === libraryRevision.current) setLibraryStatus('Libraries saved.');
        window.dispatchEvent(new CustomEvent('deckyplex-settings-change', { detail: result }));
      } catch (error) {
        if (revision !== libraryRevision.current) return;
        libraryDraft.current = savedLibraries.current;
        setLibrarySelection(savedLibraries.current);
        setLibraryStatus(error instanceof Error ? error.message : 'Could not save the selected libraries.');
      } finally {
        if (revision === libraryRevision.current) setSavingLibraries(false);
      }
    });
  };

  const renderLibraryPicker = () => (
    <SettingsSection title="Libraries">
      {loadingLibraries && <StatusLine busy text="Loading Plex libraries…" />}
      {!loadingLibraries && libraryCatalog?.server_id === settings.selected_server_id && libraryCatalog.libraries?.map(library => (
        <LibraryRow key={library.id} library={library}
          included={librarySelection.includes(library.id)}
          disabled={selectingServer || (librarySelection.length === 1 && librarySelection[0] === library.id)}
          onChange={included => toggleLibrary(library.id, included)}
        />
      ))}
      {libraryCatalog?.libraries?.length === 0 && <StatusLine text="This server has no supported libraries." />}
      {(savingLibraries || libraryStatus) && <StatusLine busy={savingLibraries} text={savingLibraries ? 'Saving libraries…' : libraryStatus} />}
    </SettingsSection>
  );

  const renderAccountPage = () => (
    <SettingsSection>
      {settings.has_plex_token ? (
        <>
          <StatusLine text={`Logged in as ${settings.logged_in_username || 'your Plex account'}`} />
          <SettingsRow>
            <Button className="deckyplex-settings-button" onClick={handleLogout} disabled={loggingOut || connectingToPlex}>Log out</Button>
          </SettingsRow>
        </>
      ) : (
        <SettingsRow>
          <Button className="deckyplex-settings-button" onClick={handlePlexLogin} disabled={loadingSettings || loggingIn || connectingToPlex || !!loginAttempt}>
            Sign in with a code
          </Button>
        </SettingsRow>
      )}
      {status && <StatusLine busy={loggingIn || loggingOut || connectingToPlex} text={status} />}
      {loginAttempt?.pin && !connectingToPlex && (
        <SettingsRow>
          <div style={{ textAlign: 'center', width: '100%' }}>
            <DialogBodyText>Enter this code at plex.tv/link</DialogBodyText>
            <DialogBodyText style={{ fontSize: '2rem', fontWeight: 'bold', margin: '0.6rem 0' }}>
              {loginAttempt.pin}
            </DialogBodyText>
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem', margin: '0.8rem 0' }}>
              <InlineSpinner />
              <DialogBodyText style={{ margin: 0, opacity: 0.7 }}>Waiting for approval…</DialogBodyText>
            </div>
          </div>
        </SettingsRow>
      )}
    </SettingsSection>
  );

  const lightMenuOptions = settings.interface_theme === 'light' ? { strClassName: 'deckyplex-light-menu' } : undefined;
  const renderInterfacePage = () => (
    <>
    <SettingsSection title="Appearance">
      <SettingsRow>
        <ToggleField label="Light mode" description="Use a light theme throughout DeckyPlex."
          checked={settings.interface_theme === 'light'} disabled={!settingsAvailable || savingInterface}
          onChange={enabled => saveInterfaceSetting('interface_theme', enabled ? 'light' : 'dark')} />
      </SettingsRow>
    </SettingsSection>
    <SettingsSection title="Quick Player">
      <SettingsRow>
        <ToggleField label="Compact header" description="Put Log in or Browse beside the status."
          checked={settings.quick_player_compact_header} disabled={!settingsAvailable || savingInterface}
          onChange={enabled => saveInterfaceSetting('quick_player_compact_header', enabled)} />
      </SettingsRow>
      <SettingsRow>
        <ToggleField label="Use Steam button styling" description="Use Steam’s default buttons and keep the playback card."
          checked={settings.quick_player_native_style === true} disabled={!settingsAvailable || savingInterface}
          onChange={enabled => saveInterfaceSetting('quick_player_native_style', enabled)} />
      </SettingsRow>
      <SettingsRow>
        <ToggleField label="Show idle player" description="Keep the playback controls visible when nothing is playing."
          checked={settings.quick_player_show_idle !== false} disabled={!settingsAvailable || savingInterface}
          onChange={enabled => saveInterfaceSetting('quick_player_show_idle', enabled)} />
      </SettingsRow>
      <SettingsRow>
        <ToggleField label="Close Quick Access on Back during playback"
          description="Use the back arrow to return to the Decky plugin list while media is playing."
          checked={settings.quick_player_close_tray_on_back !== false} disabled={!settingsAvailable || savingInterface}
          onChange={enabled => saveInterfaceSetting('quick_player_close_tray_on_back', enabled)} />
      </SettingsRow>
      <SettingsRow>
        <ToggleField
          label="Remember media control position"
          description="Return to the previous control when entering the row. When off, focus starts on Play/Pause."
          checked={settings.quick_player_maintain_x}
          disabled={!settingsAvailable || savingInterface}
          onChange={(enabled: boolean) => saveInterfaceSetting('quick_player_maintain_x', enabled)}
        />
      </SettingsRow>
      <SettingsRow>
        <ToggleField
          label="Hide Quick Player login button"
          checked={settings.hide_quick_login}
          disabled={!settingsAvailable || savingInterface}
          onChange={(hidden: boolean) => saveInterfaceSetting('hide_quick_login', hidden)}
        />
      </SettingsRow>
    </SettingsSection>
    <SettingsSection title="Video">
      <SettingsRow>
        <DropdownItem label="Default streaming quality" selectedOption={settings.video_quality}
          description="Applies when you start a video. Change quality for the current video in the player."
          contextMenuPositionOptions={lightMenuOptions}
          rgOptions={videoQualityOptions} disabled={!settingsAvailable || savingInterface}
          onChange={({ data }) => saveInterfaceSetting('video_quality', data)} />
      </SettingsRow>
      <SettingsRow>
        <ToggleField label="Show trailers and extras" description="List available extras in a video’s options menu."
          checked={settings.video_show_extras === true} disabled={!settingsAvailable || savingInterface}
          onChange={enabled => saveInterfaceSetting('video_show_extras', enabled)} />
      </SettingsRow>
      <SettingsRow>
        <ToggleField label="Autoplay next episode" checked={settings.video_autoplay !== false}
          disabled={!settingsAvailable || savingInterface}
          onChange={enabled => saveInterfaceSetting('video_autoplay', enabled)} />
      </SettingsRow>
      <SettingsRow>
        <ToggleField
          label="Allow picture-in-picture over games"
          description="Keep video visible while playing a game in Steam Gaming Mode."
          checked={settings.over_game_pip}
          disabled={!settingsAvailable || savingInterface}
          onChange={(enabled: boolean) => saveInterfaceSetting('over_game_pip', enabled)}
        />
      </SettingsRow>
      {settings.over_game_pip && <>
        <SettingsRow>
          <ButtonItem label="Picture-in-picture position" layout="below" bottomSeparator="none"
            disabled={!settingsAvailable || savingInterface} onClick={openPipPosition}>
            {pipPositions.find(({ id }) => id === settings.pip_position)?.label ?? 'Bottom left'}
          </ButtonItem>
        </SettingsRow>
        <SettingsRow>
          <SliderField label="Picture-in-picture width" value={settings.pip_size} min={20} max={50}
            step={1} valueSuffix="%" showValue layout="below" bottomSeparator="none"
            disabled={!settingsAvailable} onChange={value => updateSetting('pip_size', value)} />
        </SettingsRow>
      </>}
      {(savingInterface || interfaceStatus) && <StatusLine busy={savingInterface || interfaceStatus === 'Saving…'}
        text={savingInterface ? 'Saving…' : interfaceStatus} />}
    </SettingsSection>
    {renderBrowserSettings()}
    </>
  );

  // Server page content
  const renderServerPage = () => (
    <>
    <SettingsSection>
      <StatusLine busy={refreshingServers || selectingServer} text={selectingServer ? 'Connecting to selected server…' : refreshingServers ? 'Finding Plex servers…' : `Servers found: ${servers.length}`} />
      {serverStatus && <SettingsRow><DialogBodyText>{serverStatus}</DialogBodyText></SettingsRow>}
      {servers.length > 0 && (
        <SettingsRow>
          <div style={{ width: '100%' }}>
            <DialogBodyText style={{ marginBottom: '0.25rem' }}>Select Server</DialogBodyText>
            <Dropdown
              contextMenuPositionOptions={lightMenuOptions}
              rgOptions={servers.map(s => ({ label: s.name, data: s.id }))}
              selectedOption={settings.selected_server_id}
              disabled={selectingServer}
              onChange={(option: any) => handleSelectServer(option.data)}
            />
          </div>
        </SettingsRow>
      )}
      {!servers.length && settings.selected_server_name && (
        <SettingsRow>
          <DialogBodyText>Current: {settings.selected_server_name}</DialogBodyText>
        </SettingsRow>
      )}
      <SettingsRow>
        <DialogBodyText style={{ opacity: 0.65 }}>
          Use Advanced settings to enter a local IP address when automatic server discovery chooses an unreachable address.
        </DialogBodyText>
      </SettingsRow>
    </SettingsSection>
    {settings.selected_server_id && renderLibraryPicker()}
    </>
  );

  // Players page content
  const renderPlayersPage = () => (
    <>
    <SettingsSection title="Receive playback">
      <SettingsRow>
        <ToggleField
          label="Plexamp receiver"
          description="Receive music from Plexamp and other Plex apps on your network."
          checked={settings.companion_receiver_enabled}
          disabled={!settingsAvailable || savingPlayerSettings}
          onChange={(enabled: boolean) => updatePlayerSettings({ companion_receiver_enabled: enabled }, true)}
        />
      </SettingsRow>
      <SettingsRow>
        <ToggleField
          label="Accept playback from any Plex account"
          description="Receive music while signed out using the sender’s Plex access or your connected local server."
          checked={settings.allow_signed_out_companion}
          disabled={!settingsAvailable || savingPlayerSettings}
          onChange={(enabled: boolean) => updatePlayerSettings({ allow_signed_out_companion: enabled })}
        />
      </SettingsRow>
      <SettingsRow>
        <TextField
          label="Receiver device name"
          value={settings.companion_device_name}
          placeholder={DEFAULT_SETTINGS.companion_device_name}
          disabled={!settingsAvailable}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => updateSetting('companion_device_name', event.target.value.slice(0, 48))}
        />
      </SettingsRow>
      {receiverNameStatus && <StatusLine busy={receiverNameStatus === 'Saving…'} text={receiverNameStatus} />}
      <StatusLine busy={checkingCompanionStatus}
        light={!settings.companion_receiver_enabled ? '#8b8b8b' : companionStatus.active ? '#77d98b' : '#e7a64a'}
        text={checkingCompanionStatus ? 'Updating receiver status…' : !settings.companion_receiver_enabled ? 'Receiver is off.' : companionStatus.active ? `Receiver ready · TCP ${companionStatus.port}` : companionStatus.error || 'Receiver is unavailable.'} />
    </SettingsSection>
    <SettingsSection title="Send playback">
      <SettingsRow>
        <div style={{ width: '100%' }}>
          <DialogBodyText style={{ marginBottom: '0.25rem' }}>Playback target</DialogBodyText>
          <Dropdown
            contextMenuPositionOptions={lightMenuOptions}
            rgOptions={[
              { label: 'This Decky device', data: 'local' },
              ...players.map(player => ({
                label: `${player.name} (${player.product})${player.state && player.state !== 'idle' ? ` — ${player.state}` : ''}`,
                data: player.machineIdentifier,
              })),
              ...(settings.playback_target === 'remote' && settings.selected_player_id
                  && !players.some(player => player.machineIdentifier === settings.selected_player_id)
                ? [{ label: settings.selected_player_name || 'Saved Plex player', data: settings.selected_player_id }]
                : []),
            ]}
            selectedOption={settings.playback_target === 'remote'
              ? settings.selected_player_id : 'local'}
            disabled={savingPlayerSettings || refreshingPlayers}
            onChange={(option: any) => handleSelectPlayer(option.data === 'local' ? '' : option.data)}
          />
        </div>
      </SettingsRow>
      <SettingsRow>
        <Button className="deckyplex-settings-button" onClick={handleRefreshPlayers} disabled={refreshingPlayers || savingPlayerSettings}>
          Refresh players
        </Button>
      </SettingsRow>
      {players.length === 0 && !refreshingPlayers && (
        <SettingsRow>
          <DialogBodyText style={{ opacity: 0.5 }}>No players found. Open a Plex player, then refresh this list.</DialogBodyText>
        </SettingsRow>
      )}
      {!settings.has_plex_token && !settings.local_server_enabled && (
        <SettingsRow><DialogBodyText style={{ opacity: 0.7 }}>
          Connect a Plex server in Advanced to send music from your library.
        </DialogBodyText></SettingsRow>
      )}
      {(refreshingPlayers || savingPlayerSettings || playersStatus) && <StatusLine busy={refreshingPlayers || savingPlayerSettings}
        text={savingPlayerSettings ? 'Saving player settings…' : refreshingPlayers ? 'Finding Plex players…' : playersStatus} />}
    </SettingsSection>
    </>
  );

  const renderBrowserSettings = () => {
    const selectedVideoCategories = videoCategories(
      libraryCatalog?.server_id === settings.selected_server_id
        ? (libraryCatalog.libraries || []).filter(library => librarySelection.includes(library.id))
        : [],
      settings.has_plex_token,
    );
    return (
    <SettingsSection title="Library browser">
      <SettingsRow>
        <ToggleField label="Never wrap category names" description="Keep sidebar labels on one line."
          checked={settings.browser_never_wrap_categories === true} disabled={!settingsAvailable || savingInterface}
          onChange={enabled => saveInterfaceSetting('browser_never_wrap_categories', enabled)} />
      </SettingsRow>
      <SettingsRow>
        <SliderField
          label="Grid columns"
          min={3}
          max={9}
          step={1}
          value={settings.grid_columns || 6}
          showValue
          disabled={!settingsAvailable}
          onChange={(value: number) => updateSetting('grid_columns', Math.round(value))}
        />
      </SettingsRow>
      <SettingsRow>
        <ButtonItem label="Music categories" description="Choose what to show and in which order."
          disabled={!settingsAvailable}
          onClick={() => editBrowserCategories('Music categories', 'music', musicBrowserCategories(settings.has_plex_token))}>Customize</ButtonItem>
      </SettingsRow>
      {loadingLibraries && <StatusLine busy text="Loading video categories…" />}
      {selectedVideoCategories.length > 0 && <SettingsRow>
        <ButtonItem label="Video categories" description={settings.selected_server_name}
          disabled={!settingsAvailable || savingLibraries}
          onClick={() => editBrowserCategories(
            'Video categories', `video:${settings.selected_server_id}`, selectedVideoCategories,
          )}>Customize</ButtonItem>
      </SettingsRow>}
      {browserStatus && <StatusLine busy={browserStatus === 'Saving…'} text={browserStatus} />}
    </SettingsSection>
    );
  };

  const canConnectLocal = !changingLocalConnection && !!localAddress.trim()
    && (!settings.local_server_enabled || localAddress.trim() !== settings.selected_server_url);
  const submitServerAddress = () => {
    if (settings.has_plex_token) void testServerConnection();
    else if (canConnectLocal) void changeLocalConnection();
  };

  const renderAdvancedPage = () => (
    <SettingsSection>
      {settings.has_plex_token && <SettingsRow>
        <DialogBodyText>Use a server address override when Plex discovery picks an unreachable address.</DialogBodyText>
      </SettingsRow>}
      <SettingsRow>
        <TextField
          label={settings.has_plex_token ? 'Plex server IP or URL' : 'Local Plex server address'}
          value={settings.has_plex_token ? settings.manual_server_url : localAddress}
          description={settings.has_plex_token ? undefined : 'Connect directly to a server that already allows access from this device.'}
          placeholder="192.168.1.20:32400"
          disabled={changingLocalConnection}
          {...{
            strEnterKeyLabel: settings.has_plex_token ? 'Test connection' : 'Connect',
            onEnterKeyPress: submitServerAddress,
          }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) submitServerAddress();
          }}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            if (settings.has_plex_token) updateSetting('manual_server_url', e.target.value);
            else {
              setLocalAddress(e.target.value);
              setLocalConnectionStatus('');
            }
          }}
        />
      </SettingsRow>
      {!settings.has_plex_token && <>
        {(!settings.local_server_enabled || localAddress.trim() !== settings.selected_server_url) && (
          <SettingsRow>
            <Button className="deckyplex-settings-button" onClick={submitServerAddress}
              disabled={!canConnectLocal}>
              Connect
            </Button>
          </SettingsRow>
        )}
        {settings.local_server_enabled && <SettingsRow>
          <Button className="deckyplex-settings-button" onClick={() => void changeLocalConnection(true)}
            disabled={changingLocalConnection}>Disconnect</Button>
        </SettingsRow>}
        {(localConnectionStatus || settings.local_server_enabled) && <StatusLine busy={changingLocalConnection}
          text={localConnectionStatus || `Connected to ${settings.selected_server_name}.`} />}
      </>}
      <SettingsRow>
        <SliderField
          label={`Connection timeout: ${settings.connection_timeout}s`}
          value={settings.connection_timeout}
          min={4}
          max={30}
          step={1}
          onChange={(value: number) => updateSetting('connection_timeout', Math.round(value))}
        />
      </SettingsRow>
      <SettingsRow>
        <ToggleField
          label="Verify HTTPS certificates"
          description="Turn off only for a server with an invalid or self-signed certificate."
          checked={settings.verify_tls}
          onChange={(checked: boolean) => updateSetting('verify_tls', checked)}
        />
      </SettingsRow>
      {settings.has_plex_token && <SettingsRow>
        <Button className="deckyplex-settings-button" onClick={testServerConnection}
          disabled={advancedStatus === 'Testing Plex server connection…'}>Test connection</Button>
      </SettingsRow>}
      {advancedStatus && <StatusLine busy={advancedStatus === 'Saving…' || advancedStatus === 'Testing Plex server connection…'} text={advancedStatus} />}
    </SettingsSection>
  );

  const pages = [
    {
      title: 'Account',
      icon: <FaUser />,
      content: renderAccountPage(),
    },
    {
      title: 'Server',
      icon: <FaServer />,
      content: settings.has_plex_token ? renderServerPage() : settings.local_server_enabled ? (
        <>
          <SettingsSection><StatusLine text={`Connected to ${settings.selected_server_name}.`} /></SettingsSection>
          {renderLibraryPicker()}
        </>
      ) : (
        <SettingsSection>
          <SettingsRow>
            <DialogBodyText style={{ opacity: 0.7 }}>Sign in under Account or connect directly under Advanced.</DialogBodyText>
          </SettingsRow>
        </SettingsSection>
      ),
    },
    {
      title: 'Players',
      icon: <FaMusic />,
      content: renderPlayersPage(),
    },
    {
      title: 'Interface',
      icon: <FaSlidersH />,
      content: renderInterfacePage(),
    },
    {
      title: 'Advanced',
      icon: <FaCog />,
      content: renderAdvancedPage(),
    },
  ];

  const compactPages = pages.map(page => ({ ...page, hideTitle: true, padding: 'none' as const,
    content: <div className="deckyplex-settings-page">{page.content}</div>,
  }));
  return (
    <div data-deckyplex-settings="" data-deckyplex-light={settings.interface_theme === 'light' || undefined}
      style={{ marginTop: 40, height: 'calc(100% - 40px)', width: '100%',
        background: 'var(--deckyplex-bg, transparent)', color: 'var(--deckyplex-text, inherit)' }}>
      <InterfaceThemeStyles />
      <FocusOutlineStyles />
      <style>{`
        @media (min-width: 501px) {
          [data-deckyplex-settings] .PageListColumn {
            flex: 0 0 clamp(10rem, 19vw, 13rem); width: clamp(10rem, 19vw, 13rem); min-width: 0;
          }
        }
        [data-deckyplex-settings] [role="tabpanel"] > .DialogContent_InnerWidth {
          width: 100%; max-width: none; box-sizing: border-box;
        }
        .deckyplex-settings-page { display: grid; gap: 0.95rem; width: 100%; min-width: 0;
          box-sizing: border-box; padding: 0.75rem clamp(0.8rem, 1.8vw, 1.6rem) 3rem; }
        .deckyplex-settings-section > h2 { font-size: 0.92rem; font-weight: 650; line-height: 1.25;
          margin: 0 0 0.4rem; color: var(--deckyplex-text, #dce8f6); }
        .deckyplex-settings-fields { display: grid; gap: 0.25rem; align-items: start; padding: 0.48rem 0.7rem;
          background: var(--deckyplex-surface, #1b2635); border: 1px solid var(--deckyplex-border, #304057); border-radius: 7px; }
        .deckyplex-settings-row { min-width: 0; padding-block: 0.08rem; }
        .deckyplex-settings-button { width: 100%; margin: 0 !important; box-sizing: border-box; }
        [data-deckyplex-settings] .deckyplex-settings-fields :is(.deckyplex-settings-button, button.DialogButton) {
          background: var(--deckyplex-button, #29394d) !important; color: var(--deckyplex-text, #edf3fd) !important; border: 0 !important;
          border-radius: 5px;
        }
        [data-deckyplex-settings] .deckyplex-settings-fields :is(.deckyplex-settings-button, button.DialogButton):is(.gpfocus, :focus-visible, :active) {
          background: var(--deckyplex-hover, #416489) !important; color: var(--deckyplex-text, #edf3fd) !important;
          outline: 2px solid var(--deckyplex-focus, #a0c9ef) !important; outline-offset: -2px;
        }
        [data-deckyplex-settings] .deckyplex-settings-fields :is(.deckyplex-settings-button, button.DialogButton):is(:disabled, .Disabled, [aria-disabled="true"]) {
          background: var(--deckyplex-bg, #202c3b) !important; color: var(--deckyplex-disabled, #8b9caf) !important; outline: none !important;
        }
        [data-deckyplex-settings] :is(button, [role="button"]),
        [data-deckyplex-settings] :is(button, [role="button"])::before,
        [data-deckyplex-settings] :is(button, [role="button"])::after {
          box-shadow: none !important; text-shadow: none !important; filter: none !important;
        }
        [data-deckyplex-settings] .${gamepadDialogClasses?.FieldLabel || 'deckyplex-no-match'} {
          font-size: 0.91rem; line-height: 1.28; }
        [data-deckyplex-settings] .${gamepadDialogClasses?.FieldDescription || 'deckyplex-no-match'} {
          font-size: 0.79rem; line-height: 1.35; color: var(--deckyplex-muted, #bac9da); }
        [data-deckyplex-settings] .${gamepadDialogClasses?.Field || 'deckyplex-no-match'} {
          padding-block: 0.38rem; }
        [data-deckyplex-settings][data-deckyplex-light] :is(.PageListColumn, [role="tabpanel"]) {
          background: var(--deckyplex-bg); color: var(--deckyplex-text);
        }
        [data-deckyplex-settings][data-deckyplex-light] :is([role="tab"], .${gamepadDialogClasses?.FieldLabel || 'deckyplex-no-match'}) {
          color: var(--deckyplex-text);
        }
        [data-deckyplex-settings][data-deckyplex-light] [role="tab"]:is(.gpfocus, :focus-visible, [aria-selected="true"]) {
          background: var(--deckyplex-hover) !important; color: var(--deckyplex-focus-text) !important; text-shadow: none;
        }
        [data-deckyplex-settings][data-deckyplex-light] .deckyplex-settings-fields :is(
          .${gamepadDialogClasses?.Field || 'deckyplex-no-match'}, .${gamepadDialogClasses?.FieldClickTarget || 'deckyplex-no-match'},
          .${gamepadDialogClasses?.FieldChildrenInner || 'deckyplex-no-match'}
        ) {
          background: transparent !important; border-color: var(--deckyplex-border) !important;
          color: var(--deckyplex-text) !important; text-shadow: none;
        }
        [data-deckyplex-settings][data-deckyplex-light] .deckyplex-settings-fields :is(
          .${gamepadDialogClasses?.FieldClickTarget || 'deckyplex-no-match'}, .${gamepadDialogClasses?.HighlightOnFocus || 'deckyplex-no-match'}
        ):is(.gpfocus, :focus-visible) {
          background: transparent !important; outline: none !important;
        }
        [data-deckyplex-settings][data-deckyplex-light] .deckyplex-settings-fields :is(
          button, [role="button"], [role="combobox"], .${gamepadDialogClasses?.Button || 'deckyplex-no-match'},
          .${gamepadDialogClasses?.DropDownControlButtonContents || 'deckyplex-no-match'}
        ):not([role="switch"], .${gamepadDialogClasses?.FieldClickTarget || 'deckyplex-no-match'}) {
          background: var(--deckyplex-button) !important; color: var(--deckyplex-text) !important;
          border-color: var(--deckyplex-border) !important;
        }
        [data-deckyplex-settings][data-deckyplex-light] .deckyplex-settings-fields :is(
          button, [role="button"], [role="combobox"], [role="switch"], .${gamepadDialogClasses?.Toggle || 'deckyplex-no-match'}
        ):not(:disabled, [aria-disabled="true"]):is(.gpfocus, :focus-visible) {
          color: var(--deckyplex-focus-text) !important; outline: none !important;
        }
        [data-deckyplex-settings][data-deckyplex-light] .deckyplex-settings-row {
          border-radius: 5px; padding-inline: 0.4rem; margin-inline: -0.4rem;
        }
        [data-deckyplex-settings][data-deckyplex-light] .deckyplex-settings-row:is(
          :focus-within, :has(.gpfocus, :focus-visible)
        ) {
          background: var(--deckyplex-hover); color: var(--deckyplex-focus-text);
        }
        [data-deckyplex-settings][data-deckyplex-light] .deckyplex-settings-row
          :is(.gpfocus, :focus-visible):not(:is(input, textarea)) {
          outline: none !important;
        }
        [data-deckyplex-settings][data-deckyplex-light] .deckyplex-settings-row
          :is(.gpfocus, :focus-visible):not(:is(input, textarea))::after {
          outline: none !important; box-shadow: none !important;
        }
        [data-deckyplex-settings][data-deckyplex-light] .deckyplex-settings-fields :is(
          .${gamepadDialogClasses?.Field || 'deckyplex-no-match'}, .${gamepadDialogClasses?.FieldClickTarget || 'deckyplex-no-match'}
        ):is(.gpfocus, :focus-visible, :focus-within) :is(
          .${gamepadDialogClasses?.FieldLabel || 'deckyplex-no-match'}, .${gamepadDialogClasses?.FieldLabelValue || 'deckyplex-no-match'},
          .${gamepadDialogClasses?.FieldDescription || 'deckyplex-no-match'}
        ) {
          color: var(--deckyplex-focus-text) !important;
        }
        [data-deckyplex-settings][data-deckyplex-light] .${gamepadDialogClasses?.ToggleRail || 'deckyplex-no-match'} {
          background: var(--deckyplex-disabled) !important; box-shadow: none !important;
        }
        [data-deckyplex-settings][data-deckyplex-light] :is([aria-checked="true"],
          .${gamepadDialogClasses?.On || 'deckyplex-no-match'}) .${gamepadDialogClasses?.ToggleRail || 'deckyplex-no-match'},
        [data-deckyplex-settings][data-deckyplex-light] .${gamepadDialogClasses?.ToggleRail || 'deckyplex-no-match'}.${gamepadDialogClasses?.On || 'deckyplex-no-match'} {
          background: var(--deckyplex-accent) !important;
        }
        [data-deckyplex-settings][data-deckyplex-light] .${gamepadDialogClasses?.ToggleSwitch || 'deckyplex-no-match'} {
          background: var(--deckyplex-surface) !important;
        }
      `}</style>
      {loadingSettings
        ? <div className="deckyplex-settings-page"><SettingsSection><StatusLine busy text="Loading settings…" /></SettingsSection></div>
        : <SidebarNavigation title="DeckyPlex Settings" showTitle={false} pages={compactPages} />}
    </div>
  );
}
