import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Dropdown,
  PanelSection,
  PanelSectionRow,
  DialogBodyText,
  ButtonItem,
  SidebarNavigation,
} from '@decky/ui';
import { call } from '@decky/api';
import { FaUser, FaServer, FaMusic } from 'react-icons/fa';

interface Settings {
  plexamp_url: string;
  plex_server_url: string;
  plex_token: string;
  selected_server_id: string;
  selected_server_name: string;
  selected_server_url: string;
  selected_player_id: string;
  logged_in_username: string;
  server_access_token: string;
}

interface Server {
  id: string;
  name: string;
  access_token?: string;
  base_url?: string;
}

interface Player {
  name: string;
  product: string;
  machineIdentifier: string;
  state: string;
}

const DEFAULT_SETTINGS: Settings = {
  plexamp_url: "",
  plex_server_url: "",
  plex_token: "",
  selected_server_id: "",
  selected_server_name: "",
  selected_server_url: "",
  selected_player_id: "",
  logged_in_username: "",
  server_access_token: "",
};

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS });
  const [players, setPlayers] = useState<Player[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [status, setStatus] = useState<string>("");
  const [pinCode, setPinCode] = useState<string>("");
  const [pinUrl, setPinUrl] = useState<string>("");
  const [loggingIn, setLoggingIn] = useState(false);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const saveSettings = useCallback((s: Settings) => {
    return call("set_settings", s).then((result: any) => {
      if (result?.error) {
        setStatus("Failed to save settings: " + result.error);
      }
    }).catch(() => {
      setStatus("Failed to save settings.");
    });
  }, []);

  const callWithTimeout = (method: string, timeoutMs: number = 5000, ...args: any[]): Promise<any> => {
    return Promise.race([
      call(method, ...args),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Backend call timed out (${timeoutMs/1000}s): ${method}`)), timeoutMs)
      ),
    ]);
  };

  // Load settings on mount
  useEffect(() => {
    callWithTimeout("get_settings", 10000)
      .then((result: any) => {
        setSettings(result);
        // If no token, nothing to validate
        if (!result.plex_token) return;

        // If we have a token and server URL, just load servers in the background
        if (result.selected_server_url) {
          (async () => {
            try {
              const discoverResult: any = await callWithTimeout("discover_servers", 15000);
              if (discoverResult.servers && discoverResult.servers.length > 0) {
                setServers(discoverResult.servers);
                if (discoverResult.players) setPlayers(discoverResult.players);
                if (discoverResult.plexamp_url) {
                  const updated = { ...settingsRef.current, plexamp_url: discoverResult.plexamp_url };
                  setSettings(updated);
                }
              }
            } catch (e: any) {
              console.error("[DeckyPlex] Server discovery error:", e);
              // Don't clear login — server discovery from plex.tv can fail if internet is slow
            }
          })();
        }
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

    const interval = setInterval(async () => {
      try {
        const result: any = await callWithTimeout("plex_login_poll", 15000);
        if (result.token) {
          // Login successful — save settings and update UI
          clearInterval(interval);
          setPinCode("");
          setPinUrl("");

          const newSettings: Settings = {
            ...settingsRef.current,
            plex_token: result.token,
            logged_in_username: result.username || "",
            selected_player_id: result.player_id || "",
            plexamp_url: result.plexamp_url || "",
          };
          setSettings(newSettings);
          await saveSettings(newSettings);

          if (result.servers && result.servers.length > 0) {
            setServers(result.servers);
            // Auto-select first server
            const server = result.servers[0];
            newSettings.selected_server_id = server.id;
            newSettings.selected_server_name = server.name || "";
            newSettings.selected_server_url = server.base_url || "";
            newSettings.server_access_token = server.access_token || "";
            setSettings(newSettings);
            await saveSettings(newSettings);
          }

          // Load players
          try {
            const playersResult: any = await callWithTimeout("discover_players", 10000);
            if (playersResult.players) {
              setPlayers(playersResult.players);
            }
          } catch {}

          setStatus(`Logged in as ${result.username || 'user'}. ${result.servers?.length || 0} server(s) found.`);
        } else if (result.error) {
          clearInterval(interval);
          setPinCode("");
          setPinUrl("");
          setStatus(result.error);
        }
        // Empty result means still waiting — keep polling
      } catch (e: any) {
        console.error("[DeckyPlex] Poll error:", e);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [pinCode]);

  const handleLogout = useCallback(() => {
    const cleared: Settings = { ...DEFAULT_SETTINGS };
    setSettings(cleared);
    saveSettings(cleared);
    setServers([]);
    setPlayers([]);
    setStatus("Logged out.");
  }, [saveSettings]);

  const handleSelectServer = useCallback((serverId: string) => {
    const server = servers.find(s => s.id === serverId);
    if (server) {
      const updated = {
        ...settingsRef.current,
        selected_server_id: server.id,
        selected_server_name: server.name || "",
        selected_server_url: server.base_url || "",
        server_access_token: server.access_token || "",
      };
      setSettings(updated);
      saveSettings(updated);
      setStatus(`Selected server: ${server.name}`);
    }
  }, [servers, saveSettings]);

  const handleSelectPlayer = useCallback((playerId: string) => {
    const updated = { ...settingsRef.current, selected_player_id: playerId };
    setSettings(updated);
    saveSettings(updated);
  }, [saveSettings]);

  // Login page content
  const renderLoginPage = () => (
    <PanelSection>
      {!settings.plex_token && !pinCode && (
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
              Waiting for approval...
            </DialogBodyText>
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
        <ButtonItem onClick={handleLogout}>Logout</ButtonItem>
      </PanelSectionRow>
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
    </PanelSection>
  );

  // Players page content
  const renderPlayersPage = () => (
    <PanelSection>
      {players.length > 0 && (
        <PanelSectionRow>
          <div style={{ width: '100%' }}>
            <DialogBodyText style={{ marginBottom: '0.25rem' }}>Player</DialogBodyText>
            <Dropdown
              rgOptions={players.map(p => ({ label: `${p.name} (${p.product})`, data: p.machineIdentifier }))}
              selectedOption={settings.selected_player_id}
              onChange={(option: any) => handleSelectPlayer(option.data)}
            />
          </div>
        </PanelSectionRow>
      )}
      {players.length === 0 && (
        <PanelSectionRow>
          <DialogBodyText style={{ opacity: 0.5 }}>No players discovered. Open Plexamp on another device to see it here.</DialogBodyText>
        </PanelSectionRow>
      )}
    </PanelSection>
  );

  const pages = [
    {
      title: 'Account',
      icon: <FaUser />,
      content: settings.plex_token ? renderAccountPage() : renderLoginPage(),
    },
    {
      title: 'Server',
      icon: <FaServer />,
      content: settings.plex_token ? renderServerPage() : (
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
      content: settings.plex_token ? renderPlayersPage() : (
        <PanelSection>
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>
              Log in first to discover players.
            </DialogBodyText>
          </PanelSectionRow>
        </PanelSection>
      ),
    },
  ];

  return (
    <div style={{ marginTop: '40px', height: 'calc(100% - 40px)' }}>
      <SidebarNavigation title="DeckyPlex Settings" showTitle pages={pages} />
    </div>
  );
}
