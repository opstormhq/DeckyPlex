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
  Spinner,
} from '@decky/ui';
import { call } from '@decky/api';
import { FaUser, FaServer, FaMusic, FaCog, FaTh } from 'react-icons/fa';

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
}

interface Server {
  id: string;
  name: string;
  base_url?: string;
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
};

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS });
  const [players, setPlayers] = useState<Player[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [status, setStatus] = useState<string>("");
  const [serverStatus, setServerStatus] = useState("");
  const [playersStatus, setPlayersStatus] = useState("");
  const [browserStatus, setBrowserStatus] = useState("");
  const [advancedStatus, setAdvancedStatus] = useState("");
  const [pinCode, setPinCode] = useState<string>("");
  const [pinUrl, setPinUrl] = useState<string>("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [connectingToPlex, setConnectingToPlex] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshingPlayers, setRefreshingPlayers] = useState(false);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const autoSaveTimer = useRef<number | null>(null);
  const autoSaveRevision = useRef(0);

  const saveSettings = useCallback((s: Settings) => {
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
    callWithTimeout("get_settings", 10000)
      .then((result: any) => {
        settingsRef.current = result;
        setSettings(result);
        if (!result.has_plex_token) return;
        void (async () => {
          try {
            const discoverResult: any = await callWithTimeout("discover_servers", 15000);
            if (discoverResult.servers) setServers(discoverResult.servers);
            if (discoverResult.plexamp_url) {
              const updated = { ...settingsRef.current, plexamp_url: discoverResult.plexamp_url };
              settingsRef.current = updated;
              setSettings(updated);
            }
            const playersResult: any = await callWithTimeout("discover_players", 30000);
            if (playersResult.players) setPlayers(playersResult.players);
          } catch (e: any) {
            console.error("[DeckyPlex] Plex discovery error:", e);
          }
        })();
      })
      .catch(() => {
        // Backend not responding — show UI with defaults
        setStatus("Backend not responding. Make sure the plugin is loaded.");
      });
  }, []);

  const handlePlexLogin = useCallback(async () => {
    setLoggingIn(true);
    setStatus("Requesting login code from Plex...");
    try {
      const result: any = await callWithTimeout("plex_login", 20000);
      if (result.pin) {
        setPinCode(result.pin);
        setPinUrl(result.url || "");
        setStatus("Enter this code at plex.tv/link:");
      } else if (result.error) {
        setStatus(result.error);
      }
    } catch (e: any) {
      setStatus(e?.message || "Could not contact the Decky plugin backend.");
    } finally {
      setLoggingIn(false);
    }
  }, []);

  // Poll for PIN approval after showing the code
  useEffect(() => {
    if (!pinCode) return;
    let polling = false;
    const interval = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const result: any = await callWithTimeout("plex_login_poll", 15000);
        if (result.logged_in) {
          clearInterval(interval);
          setConnectingToPlex(true);
          setStatus("Plex approved. Connecting to your server...");
          try {
            const savedSettings: any = await callWithTimeout("get_settings", 10000);
            settingsRef.current = savedSettings;
            setSettings(savedSettings);
            setPinCode("");
            setPinUrl("");
            setStatus("Login complete. Discovering your Plex server...");

            const discovery: any = await callWithTimeout("discover_servers", 30000);
            setServers(discovery.servers || []);
            const connectedSettings: any = await callWithTimeout("get_settings", 10000);
            settingsRef.current = connectedSettings;
            setSettings(connectedSettings);
            setStatus(discovery.servers?.length
              ? `Connected as ${connectedSettings.logged_in_username || 'your Plex account'}. ${discovery.servers.length} server(s) found.`
              : "Plex login succeeded, but no server was found. Check Server or Advanced settings.");
            setConnectingToPlex(false);

            setRefreshingPlayers(true);
            void callWithTimeout("discover_players", 30000)
              .then((playersResult: any) => setPlayers(playersResult.players || []))
              .catch(() => {})
              .finally(() => setRefreshingPlayers(false));
          } catch (e: any) {
            setPinCode("");
            setPinUrl("");
            setStatus(e?.message || "Plex login succeeded, but server discovery failed.");
          } finally {
            setConnectingToPlex(false);
          }
        } else if (result.error) {
          clearInterval(interval);
          setPinCode("");
          setPinUrl("");
          setStatus(result.error);
        }
        // Empty result means still waiting — keep polling
      } catch (e: any) {
        console.error("[DeckyPlex] Poll error:", e);
      } finally {
        polling = false;
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [pinCode]);

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

  const handleSelectServer = useCallback((serverId: string) => {
    const server = servers.find(s => s.id === serverId);
    if (server) {
      callWithTimeout("select_server", 15000, server.id).then((result: any) => {
        if (!result?.success) throw new Error(result?.error || "Could not select Plex server.");
        settingsRef.current = result.settings;
        setSettings(result.settings);
        window.dispatchEvent(new Event('deckyplex-settings-change'));
        setServerStatus(`Selected server: ${server.name}`);
      }).catch((e: any) => setServerStatus(e?.message || "Could not select Plex server."));
    }
  }, [servers]);

  const handleSelectPlayer = useCallback((playerId: string) => {
    const player = players.find(p => p.machineIdentifier === playerId);
    const updated = {
      ...settingsRef.current,
      selected_player_id: playerId,
      selected_player_name: player?.name || '',
      playback_target: playerId ? settingsRef.current.playback_target : 'local',
    };
    settingsRef.current = updated;
    setSettings(updated);
    saveSettings(updated);
  }, [players, saveSettings]);

  const handleRefreshPlayers = useCallback(async () => {
    setRefreshingPlayers(true);
    try {
      const result: any = await callWithTimeout("discover_players", 30000);
      if (result.error) throw new Error(result.error);
      const nextPlayers = result.players || [];
      setPlayers(nextPlayers);
      if (settingsRef.current.selected_player_id && !nextPlayers.some((p: Player) => p.machineIdentifier === settingsRef.current.selected_player_id)) {
        const updated = { ...settingsRef.current, selected_player_id: "", selected_player_name: "", playback_target: "local" as const };
        settingsRef.current = updated;
        setSettings(updated);
        await saveSettings(updated);
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
    const isBrowserSetting = key === 'grid_columns';
    const setSaveStatus = isBrowserSetting ? setBrowserStatus : setAdvancedStatus;
    setSaveStatus('Saving…');
    if (autoSaveTimer.current !== null) window.clearTimeout(autoSaveTimer.current);
    const revision = ++autoSaveRevision.current;
    autoSaveTimer.current = window.setTimeout(async () => {
      if (revision === autoSaveRevision.current) autoSaveTimer.current = null;
      const result: any = await saveSettings(settingsRef.current);
      if (revision === autoSaveRevision.current) setSaveStatus(result?.error || 'Saved automatically.');
    }, 350);
    return updated;
  }, [saveSettings]);

  useEffect(() => () => {
    if (autoSaveTimer.current !== null) window.clearTimeout(autoSaveTimer.current);
  }, []);

  const testServerConnection = useCallback(async () => {
    if (autoSaveTimer.current !== null) window.clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = null;
    autoSaveRevision.current++;
    setAdvancedStatus("Testing Plex server connection...");
    try {
      const saved: any = await saveSettings(settingsRef.current);
      if (saved?.error) throw new Error(saved.error);
      const result: any = await callWithTimeout("validate_connection", 15000);
      setAdvancedStatus(result.valid ? `Connected to ${result.serverName || "Plex Media Server"}.` : `Connection failed: ${result.error}`);
    } catch (e: any) {
      setAdvancedStatus(e?.message || "Connection test failed.");
    }
  }, [saveSettings]);

  // Login page content
  const renderLoginPage = () => (
    <PanelSection>
      {!settings.has_plex_token && !pinCode && (
        <PanelSectionRow>
          <ButtonItem onClick={handlePlexLogin} disabled={loggingIn}>
            {loggingIn ? "Requesting..." : "Login with Plex"}
          </ButtonItem>
        </PanelSectionRow>
      )}
      {status && (
        <PanelSectionRow>
          <DialogBodyText>{status}</DialogBodyText>
        </PanelSectionRow>
      )}
      {pinCode && (
        <PanelSectionRow>
          <div style={{ textAlign: 'center', width: '100%' }}>
            <DialogBodyText style={{ fontSize: '2rem', fontWeight: 'bold', margin: '1rem 0' }}>
              {pinCode}
            </DialogBodyText>
            {pinUrl && (
              <DialogBodyText style={{ opacity: 0.6 }}>
                or visit: {pinUrl}
              </DialogBodyText>
            )}
            <DialogBodyText style={{ marginTop: '1rem', opacity: 0.7 }}>
              {connectingToPlex ? 'Plex approved. Connecting to your server...' : 'Waiting for approval...'}
            </DialogBodyText>
            {connectingToPlex && <Spinner style={{ width: '18px', height: '18px', margin: '0.35rem auto' }} />}
          </div>
        </PanelSectionRow>
      )}
    </PanelSection>
  );

  // Account page content
  const renderAccountPage = () => (
    <PanelSection>
      <PanelSectionRow>
        <DialogBodyText>Logged in as: {settings.logged_in_username || 'Unknown'}</DialogBodyText>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem onClick={handleLogout} disabled={loggingOut}>
          {loggingOut ? 'Logging out...' : 'Logout'}
        </ButtonItem>
      </PanelSectionRow>
      {loggingOut && <PanelSectionRow><Spinner style={{ width: '18px', height: '18px' }} /></PanelSectionRow>}
      {connectingToPlex && <PanelSectionRow><Spinner style={{ width: '18px', height: '18px' }} /></PanelSectionRow>}
      {status && (
        <PanelSectionRow>
          <DialogBodyText>{status}</DialogBodyText>
        </PanelSectionRow>
      )}
    </PanelSection>
  );

  // Server page content
  const renderServerPage = () => (
    <PanelSection>
      <PanelSectionRow>
        <DialogBodyText>Servers found: {servers.length}</DialogBodyText>
      </PanelSectionRow>
      {serverStatus && <PanelSectionRow><DialogBodyText>{serverStatus}</DialogBodyText></PanelSectionRow>}
      {servers.length > 0 && (
        <PanelSectionRow>
          <div style={{ width: '100%' }}>
            <DialogBodyText style={{ marginBottom: '0.25rem' }}>Select Server</DialogBodyText>
            <Dropdown
              rgOptions={servers.map(s => ({ label: s.name, data: s.id }))}
              selectedOption={settings.selected_server_id}
              onChange={(option: any) => handleSelectServer(option.data)}
            />
          </div>
        </PanelSectionRow>
      )}
      {settings.selected_server_name && (
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
  );

  // Players page content
  const renderPlayersPage = () => (
    <PanelSection>
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
            disabled={!settings.selected_player_id}
            onChange={(option: any) => {
              const updated: Settings = { ...settingsRef.current, playback_target: option.data === 'remote' ? 'remote' : 'local' };
              settingsRef.current = updated;
              setSettings(updated);
              saveSettings(updated);
            }}
          />
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem onClick={handleRefreshPlayers} disabled={refreshingPlayers}>
          {refreshingPlayers ? "Refreshing players..." : "Refresh players"}
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
              onChange={(option: any) => handleSelectPlayer(option.data)}
            />
          </div>
        </PanelSectionRow>
      )}
      {players.length === 0 && (
        <PanelSectionRow>
          <DialogBodyText style={{ opacity: 0.5 }}>No players found. Open a Plex player, then refresh this list.</DialogBodyText>
        </PanelSectionRow>
      )}
      {playersStatus && <PanelSectionRow><DialogBodyText>{playersStatus}</DialogBodyText></PanelSectionRow>}
    </PanelSection>
  );

  const renderBrowserPage = () => (
    <PanelSection>
      <PanelSectionRow>
        <DialogBodyText>Choose how many album and artist tiles fit across the music browser.</DialogBodyText>
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField
          label={`Grid columns: ${settings.grid_columns || 5}`}
          min={3}
          max={8}
          step={1}
          value={settings.grid_columns || 5}
          onChange={(value: number) => updateSetting('grid_columns', Math.round(value))}
        />
      </PanelSectionRow>
      {browserStatus && <PanelSectionRow><DialogBodyText>{browserStatus}</DialogBodyText></PanelSectionRow>}
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
        <Button onClick={testServerConnection}>Test connection</Button>
      </PanelSectionRow>
      {advancedStatus && <PanelSectionRow><DialogBodyText>{advancedStatus}</DialogBodyText></PanelSectionRow>}
    </PanelSection>
  );

  const pages = [
    {
      title: 'Account',
      icon: <FaUser />,
      content: settings.has_plex_token ? renderAccountPage() : renderLoginPage(),
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
      content: settings.has_plex_token ? renderPlayersPage() : (
        <PanelSection>
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>
              Log in first to discover players.
            </DialogBodyText>
          </PanelSectionRow>
        </PanelSection>
      ),
    },
    {
      title: 'Browser',
      icon: <FaTh />,
      content: settings.has_plex_token ? renderBrowserPage() : (
        <PanelSection><PanelSectionRow><DialogBodyText style={{ opacity: 0.5 }}>Log in first to change browser settings.</DialogBodyText></PanelSectionRow></PanelSection>
      ),
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
