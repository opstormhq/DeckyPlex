import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Dropdown,
  PanelSection,
  PanelSectionRow,
  DialogBodyText,
  ButtonItem,
  Button,
  TextField,
  SliderField,
  DialogCheckbox,
  SidebarNavigation,
  showModal,
} from '@decky/ui';
import { call } from '@decky/api';
import { FaUser, FaServer, FaMusic, FaCog, FaSlidersH } from 'react-icons/fa';
import { InlineSpinner } from './InlineSpinner';
import { stopGamePip } from './GamePip';
import { LibraryRow, PlexSetupDialog, type LibraryCatalog, type PlexServerOption } from './PlexSetupDialog';

interface Settings {
  plexamp_url: string;
  plex_server_url: string;
  plex_token: string;
  has_plex_token: boolean;
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
  companion_receiver_enabled: boolean;
  companion_device_name: string;
  allow_signed_out_companion: boolean;
  hide_quick_login: boolean;
  quick_player_maintain_x: boolean;
  over_game_pip: boolean;
  pip_position: string;
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
  companion_receiver_enabled: false,
  companion_device_name: 'DeckyPlex',
  allow_signed_out_companion: false,
  hide_quick_login: false,
  quick_player_maintain_x: false,
  over_game_pip: false,
  pip_position: 'bottom-left',
  pip_size: 29,
};

const pipPositions = [
  { label: 'Bottom left', data: 'bottom-left' },
  { label: 'Bottom right', data: 'bottom-right' },
  { label: 'Top left', data: 'top-left' },
  { label: 'Top right', data: 'top-right' },
];

function StatusLine({ text, busy, light }: { text: string; busy?: boolean; light?: string }) {
  return (
    <PanelSectionRow>
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minHeight: '1.2rem' }}>
        {busy ? <InlineSpinner /> : light && (
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: light }} />
        )}
        <DialogBodyText style={{ margin: 0 }}>{text}</DialogBodyText>
      </div>
    </PanelSectionRow>
  );
}

export function SettingsPage() {
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
  const [loginAttempt, setLoginAttempt] = useState<{ id: string; pin: string } | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [connectingToPlex, setConnectingToPlex] = useState(false);
  const [settingUpPlex, setSettingUpPlex] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshingPlayers, setRefreshingPlayers] = useState(false);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const autoSaveTimer = useRef<number | null>(null);
  const autoSaveRevision = useRef(0);
  const pendingPreferences = useRef<Partial<Settings>>({});
  const libraryDraft = useRef<string[]>([]);
  const savedLibraries = useRef<string[]>([]);
  const librarySaveQueue = useRef(Promise.resolve());
  const libraryRevision = useRef(0);
  const setupDialog = useRef<ReturnType<typeof showModal> | null>(null);
  const settingsMounted = useRef(false);

  const saveSettings = useCallback((s: Partial<Settings>) => {
    return call("set_settings", s).then((result: any) => {
      if (result?.error) {
        return result;
      } else {
        window.dispatchEvent(new Event('deckyplex-settings-change'));
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
        settingsRef.current = result;
        setSettings(result);
        setLoadingSettings(false);
        setSettingsAvailable(true);
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
        if (!result.has_plex_token) return;
        setRefreshingServers(true);
        void (async () => {
          try {
            const discoverResult: any = await callWithTimeout("discover_servers", 15000);
            if (discoverResult.servers) setServers(discoverResult.servers);
            if (settingsRef.current.has_plex_token && !settingsRef.current.selected_server_id) {
              const updated: Settings = await callWithTimeout('get_settings', 10000);
              settingsRef.current = updated;
              setSettings(updated);
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
    };
  }, []);

  useEffect(() => {
    libraryRevision.current++;
    setLibraryCatalog(null);
    setLibrarySelection([]);
    setLibraryStatus('');
    setSavingLibraries(false);
    if (settingUpPlex || !settings.has_plex_token || !settings.selected_server_id) {
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
  }, [settingUpPlex, settings.has_plex_token, settings.selected_server_id]);

  const handlePlexLogin = useCallback(async () => {
    setLoggingIn(true);
    setLoginAttempt(null);
    setStatus('Requesting a login code…');
    try {
      const result: any = await callWithTimeout('plex_login', 20000);
      if (result?.error) throw new Error(result.error);
      if (!result?.login_id || !result.pin) throw new Error('Plex did not return a sign-in code.');
      setLoginAttempt({ id: result.login_id, pin: result.pin });
      setStatus('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not start Plex sign-in.');
    } finally {
      setLoggingIn(false);
    }
  }, []);

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
          window.dispatchEvent(new Event('deckyplex-settings-change'));
        };
        setLoginAttempt(null);
        setConnectingToPlex(false);
        setSettingUpPlex(discoveredServers.length > 0);
        applySettings(connectedSettings);
        setServers(discoveredServers);
        setStatus(discoveredServers.length ? '' : 'Signed in to Plex. Check Server or Advanced to connect to a server.');
        if (discoveredServers.length) {
          const dialog = showModal(
            <PlexSetupDialog servers={discoveredServers} defaultServerId={connectedSettings.selected_server_id}
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
      window.dispatchEvent(new Event('deckyplex-settings-change'));
      setServers([]);
      setPlayers([]);
      setStatus("Logged out.");
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
      window.dispatchEvent(new Event('deckyplex-settings-change'));
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
      selected_player_name: player?.name || '',
      playback_target: playerId ? settingsRef.current.playback_target : 'local',
    });
  };

  const handleRefreshPlayers = useCallback(async () => {
    setRefreshingPlayers(true);
    try {
      const result: any = await callWithTimeout("discover_players", 30000);
      if (result.error) throw new Error(result.error);
      const nextPlayers = result.players || [];
      setPlayers(nextPlayers);
      if (settingsRef.current.selected_player_id && !nextPlayers.some((p: Player) => p.machineIdentifier === settingsRef.current.selected_player_id)) {
        const changes = { selected_player_id: "", selected_player_name: "", playback_target: "local" as const };
        const saved: any = await saveSettings(changes);
        if (saved?.error) throw new Error(saved.error);
        const updated = { ...settingsRef.current, ...changes };
        settingsRef.current = updated;
        setSettings(updated);
      }
      setPlayersStatus(nextPlayers.length ? `Found ${nextPlayers.length} Plex player(s), including account-registered devices.` : "No Plex players were found through the server or account device list.");
    } catch (e: any) {
      setPlayersStatus(e?.message || "Could not refresh Plex players.");
    } finally {
      setRefreshingPlayers(false);
    }
  }, [saveSettings]);

  const updateSetting = useCallback((key: keyof Settings, value: any) => {
    const updated = { ...settingsRef.current, [key]: value };
    settingsRef.current = updated;
    setSettings(updated);
    if (key === 'grid_columns') setBrowserStatus('Saving…');
    else if (key === 'companion_device_name') setReceiverNameStatus('Saving…');
    else if (key === 'pip_size') setInterfaceStatus('Saving…');
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
        if ('pip_size' in changes) setInterfaceStatus(result?.error || '');
        if (Object.keys(changes).some(key => !['grid_columns', 'companion_device_name', 'pip_size'].includes(key))) setAdvancedStatus(message);
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

  const saveInterfaceSetting = async <K extends 'hide_quick_login' | 'quick_player_maintain_x' | 'over_game_pip' | 'pip_position'>(key: K, value: Settings[K]) => {
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
        window.dispatchEvent(new Event('deckyplex-settings-change'));
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
    <PanelSection title="Libraries">
      {loadingLibraries && <StatusLine busy text="Loading Plex libraries…" />}
      {libraryCatalog?.server_id === settings.selected_server_id && libraryCatalog.libraries?.map(library => (
        <LibraryRow key={library.id} library={library}
          checked={librarySelection.includes(library.id)}
          disabled={selectingServer || (librarySelection.length === 1 && librarySelection[0] === library.id)}
          onChange={checked => toggleLibrary(library.id, checked)}
        />
      ))}
      {libraryCatalog?.libraries?.length === 0 && <StatusLine text="This server has no supported libraries." />}
      {(savingLibraries || libraryStatus) && <StatusLine busy={savingLibraries} text={savingLibraries ? 'Saving libraries…' : libraryStatus} />}
    </PanelSection>
  );

  const renderAccountPage = () => (
    <PanelSection>
      {settings.has_plex_token ? (
        <>
          <StatusLine text={`Logged in as ${settings.logged_in_username || 'your Plex account'}`} />
          <PanelSectionRow>
            <ButtonItem onClick={handleLogout} disabled={loggingOut || connectingToPlex}>Log out</ButtonItem>
          </PanelSectionRow>
        </>
      ) : (
        <PanelSectionRow>
          <ButtonItem onClick={handlePlexLogin} disabled={loadingSettings || loggingIn || connectingToPlex || !!loginAttempt}>
            Sign in with a code
          </ButtonItem>
        </PanelSectionRow>
      )}
      {loadingSettings && <StatusLine busy text="Loading settings…" />}
      {status && <StatusLine busy={loggingIn || loggingOut || connectingToPlex} text={status} />}
      {loginAttempt?.pin && !connectingToPlex && (
        <PanelSectionRow>
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
        </PanelSectionRow>
      )}
    </PanelSection>
  );

  const renderInterfacePage = () => (
    <>
    <PanelSection title="Quick Player">
      <PanelSectionRow>
        <DialogCheckbox
          label="Preserve horizontal focus on media controls"
          description="Enter the transport row near the previous control’s horizontal position. Turn this off to prefer Play/Pause."
          checked={settings.quick_player_maintain_x}
          disabled={!settingsAvailable || savingInterface}
          onChange={(enabled: boolean) => saveInterfaceSetting('quick_player_maintain_x', enabled)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <DialogCheckbox
          label="Hide Quick Player login button"
          checked={settings.hide_quick_login}
          disabled={!settingsAvailable || savingInterface}
          onChange={(hidden: boolean) => saveInterfaceSetting('hide_quick_login', hidden)}
        />
      </PanelSectionRow>
    </PanelSection>
    <PanelSection title="Video">
      <PanelSectionRow>
        <DialogCheckbox
          label="Allow picture-in-picture over games"
          description="Keep video visible while playing a game in Steam Gaming Mode."
          checked={settings.over_game_pip}
          disabled={!settingsAvailable || savingInterface}
          onChange={(enabled: boolean) => saveInterfaceSetting('over_game_pip', enabled)}
        />
      </PanelSectionRow>
      {settings.over_game_pip && <>
        <PanelSectionRow>
          <div style={{ width: '100%' }}>
            <DialogBodyText style={{ marginBottom: '0.25rem' }}>Picture-in-picture position</DialogBodyText>
            <Dropdown rgOptions={pipPositions} selectedOption={settings.pip_position}
              disabled={!settingsAvailable || savingInterface}
              onChange={(option: { data: string }) => saveInterfaceSetting('pip_position', option.data)} />
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField label="Picture-in-picture width" value={settings.pip_size} min={20} max={50}
            step={1} valueSuffix="%" showValue layout="below" bottomSeparator="none"
            disabled={!settingsAvailable} onChange={value => updateSetting('pip_size', value)} />
        </PanelSectionRow>
      </>}
      {(savingInterface || interfaceStatus) && <StatusLine busy={savingInterface || interfaceStatus === 'Saving…'}
        text={savingInterface ? 'Saving…' : interfaceStatus} />}
    </PanelSection>
    {renderBrowserSettings()}
    </>
  );

  // Server page content
  const renderServerPage = () => (
    <>
    <PanelSection>
      <StatusLine busy={refreshingServers || selectingServer} text={selectingServer ? 'Connecting to selected server…' : refreshingServers ? 'Finding Plex servers…' : `Servers found: ${servers.length}`} />
      {serverStatus && <PanelSectionRow><DialogBodyText>{serverStatus}</DialogBodyText></PanelSectionRow>}
      {servers.length > 0 && (
        <PanelSectionRow>
          <div style={{ width: '100%' }}>
            <DialogBodyText style={{ marginBottom: '0.25rem' }}>Select Server</DialogBodyText>
            <Dropdown
              rgOptions={servers.map(s => ({ label: s.name, data: s.id }))}
              selectedOption={settings.selected_server_id}
              disabled={selectingServer}
              onChange={(option: any) => handleSelectServer(option.data)}
            />
          </div>
        </PanelSectionRow>
      )}
      {!servers.length && settings.selected_server_name && (
        <PanelSectionRow>
          <DialogBodyText>Current: {settings.selected_server_name}</DialogBodyText>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <DialogBodyText style={{ opacity: 0.65 }}>
          Use Advanced settings to enter a local IP address when automatic server discovery chooses an unreachable address.
        </DialogBodyText>
      </PanelSectionRow>
    </PanelSection>
    {settings.selected_server_id && renderLibraryPicker()}
    </>
  );

  // Players page content
  const renderPlayersPage = () => (
    <PanelSection>
      <PanelSectionRow><div style={{ fontWeight: 600, marginBlock: '0.3rem' }}>Receive playback</div></PanelSectionRow>
      <PanelSectionRow>
        <DialogCheckbox
          label="Plexamp receiver"
          description="Let Plexamp and other Plex apps send music to this device over your local network."
          checked={settings.companion_receiver_enabled}
          disabled={!settingsAvailable || savingPlayerSettings}
          onChange={(enabled: boolean) => updatePlayerSettings({ companion_receiver_enabled: enabled }, true)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <DialogCheckbox
          label="Accept playback from any Plex account"
          description="Use Plexamp’s access token even when DeckyPlex is signed in to another account or server, or signed out. Supports LAN servers and secure plex.direct addresses."
          checked={settings.allow_signed_out_companion}
          disabled={!settingsAvailable || savingPlayerSettings}
          onChange={(enabled: boolean) => updatePlayerSettings({ allow_signed_out_companion: enabled })}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <TextField
          label="Receiver device name"
          value={settings.companion_device_name}
          placeholder={DEFAULT_SETTINGS.companion_device_name}
          disabled={!settingsAvailable}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => updateSetting('companion_device_name', event.target.value.slice(0, 48))}
        />
      </PanelSectionRow>
      {receiverNameStatus && <StatusLine busy={receiverNameStatus === 'Saving…'} text={receiverNameStatus} />}
      <StatusLine busy={checkingCompanionStatus}
        light={!settings.companion_receiver_enabled ? '#8b8b8b' : companionStatus.active ? '#77d98b' : '#e7a64a'}
        text={checkingCompanionStatus ? 'Updating receiver status…' : !settings.companion_receiver_enabled ? 'Receiver is off.' : companionStatus.active ? `Receiver ready on port ${companionStatus.port}.` : companionStatus.error || 'Receiver is unavailable.'} />
      <PanelSectionRow>
        <div style={{ width: '100%', marginBlock: '0.9rem 0.4rem', paddingTop: '0.9rem', borderTop: '1px solid rgba(255,255,255,0.16)', fontWeight: 600 }}>Send playback</div>
      </PanelSectionRow>
      {!settings.has_plex_token ? (
        <PanelSectionRow><DialogBodyText style={{ opacity: 0.65 }}>Log in to Plex to select remote players.</DialogBodyText></PanelSectionRow>
      ) : <>
      <PanelSectionRow>
        <DialogBodyText style={{ opacity: 0.75 }}>
          Choose where DeckyPlex sends playback. The list includes server-connected clients and devices registered to your Plex account. A registered device may need to be opened or started before it can accept playback.
        </DialogBodyText>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ width: '100%' }}>
          <DialogBodyText style={{ marginBottom: '0.25rem' }}>Playback target</DialogBodyText>
          <Dropdown
            rgOptions={[
              { label: 'This Decky device', data: 'local' },
              { label: 'Selected remote Plex player', data: 'remote' },
            ]}
            selectedOption={settings.playback_target}
            disabled={!settings.selected_player_id || savingPlayerSettings || refreshingPlayers}
            onChange={(option: any) => updatePlayerSettings({ playback_target: option.data === 'remote' ? 'remote' : 'local' })}
          />
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem onClick={handleRefreshPlayers} disabled={refreshingPlayers || savingPlayerSettings}>
          Refresh players
        </ButtonItem>
      </PanelSectionRow>
      {players.length > 0 && (
        <PanelSectionRow>
          <div style={{ width: '100%' }}>
              <DialogBodyText style={{ marginBottom: '0.25rem' }}>Remote player</DialogBodyText>
            <Dropdown
              rgOptions={[
                { label: 'No remote player selected', data: '' },
                ...players.map(p => ({ label: `${p.name} (${p.product})${p.state && p.state !== 'idle' ? ` — ${p.state}` : ''}`, data: p.machineIdentifier })),
              ]}
              selectedOption={settings.selected_player_id}
              disabled={refreshingPlayers || savingPlayerSettings}
              onChange={(option: any) => handleSelectPlayer(option.data)}
            />
          </div>
        </PanelSectionRow>
      )}
      {players.length === 0 && !refreshingPlayers && (
        <PanelSectionRow>
          <DialogBodyText style={{ opacity: 0.5 }}>No players found. Open a Plex player, then refresh this list.</DialogBodyText>
        </PanelSectionRow>
      )}
      </>}
      {(refreshingPlayers || savingPlayerSettings || playersStatus) && <StatusLine busy={refreshingPlayers || savingPlayerSettings}
        text={savingPlayerSettings ? 'Saving player settings…' : refreshingPlayers ? 'Finding Plex players…' : playersStatus} />}
    </PanelSection>
  );

  const renderBrowserSettings = () => (
    <PanelSection title="Library browser">
      <PanelSectionRow>
        <SliderField
          label={`Grid columns: ${settings.grid_columns || 6}`}
          min={3}
          max={9}
          step={1}
          value={settings.grid_columns || 6}
          disabled={!settingsAvailable}
          onChange={(value: number) => updateSetting('grid_columns', Math.round(value))}
        />
      </PanelSectionRow>
      {browserStatus && <StatusLine busy={browserStatus === 'Saving…'} text={browserStatus} />}
    </PanelSection>
  );

  const renderAdvancedPage = () => (
    <PanelSection>
      <PanelSectionRow>
        <DialogBodyText>
          Optional local address override. Enter an IP address such as 192.168.1.20 or a full URL. Leave blank to use automatic Plex discovery.
        </DialogBodyText>
      </PanelSectionRow>
      <PanelSectionRow>
        <TextField
          label="Plex server IP or URL"
          value={settings.manual_server_url}
          placeholder="192.168.1.20:32400"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateSetting('manual_server_url', e.target.value)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField
          label={`Connection timeout: ${settings.connection_timeout}s`}
          value={settings.connection_timeout}
          min={4}
          max={30}
          step={1}
          onChange={(value: number) => updateSetting('connection_timeout', Math.round(value))}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <DialogCheckbox
          label="Verify HTTPS certificates"
          description="Turn off only for a server with an invalid or self-signed certificate."
          checked={settings.verify_tls}
          onChange={(checked: boolean) => updateSetting('verify_tls', checked)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <Button onClick={testServerConnection} disabled={advancedStatus === 'Testing Plex server connection…'}>Test connection</Button>
      </PanelSectionRow>
      {advancedStatus && <StatusLine busy={advancedStatus === 'Saving…' || advancedStatus === 'Testing Plex server connection…'} text={advancedStatus} />}
    </PanelSection>
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
      content: settings.has_plex_token ? renderServerPage() : (
        <PanelSection>
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>Log in first to select a server.</DialogBodyText>
          </PanelSectionRow>
        </PanelSection>
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
      content: settings.has_plex_token ? renderAdvancedPage() : (
        <PanelSection><PanelSectionRow><DialogBodyText style={{ opacity: 0.5 }}>Log in first to change connection settings.</DialogBodyText></PanelSectionRow></PanelSection>
      ),
    },
  ];

  return (
    <div style={{ marginTop: '40px', height: 'calc(100% - 40px)' }}>
      <SidebarNavigation title="DeckyPlex Settings" showTitle pages={pages} />
    </div>
  );
}
