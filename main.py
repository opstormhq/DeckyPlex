import json
import os
import secrets
import sys
import urllib.parse
from typing import Any, Dict, List, Optional

# Add py_modules to Python path so bundled dependencies (plexapi, requests) are available
_py_modules_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "py_modules")
if os.path.isdir(_py_modules_dir):
    if _py_modules_dir in sys.path:
        sys.path.remove(_py_modules_dir)
    sys.path.insert(0, _py_modules_dir)
    # Decky can preload an `xml` package before loading plugins, leaving its
    # package path pointed at a stripped stdlib directory. Add our bundled
    # ElementTree implementation to that already-loaded package explicitly.
    _bundled_xml_dir = os.path.join(_py_modules_dir, "xml")
    try:
        import xml
        xml_path = getattr(xml, "__path__", None)
        xml_paths = list(xml_path or [])
        xml.__path__ = [_bundled_xml_dir] + [p for p in xml_paths if p != _bundled_xml_dir]
    except ModuleNotFoundError:
        # The bundled `xml` package will be discovered from sys.path normally.
        pass

import decky

logger = decky.logger


DEFAULT_SETTINGS = {
    "plexamp_url": "",
    "plex_server_url": "",
    "plex_token": "",
    "selected_server_id": "",
    "selected_server_url": "",
    "selected_player_id": "",
    "logged_in_username": "",
    "server_access_token": "",
}

# Settings file path — Decky provides this directory
try:
    _settings_dir = decky.DECKY_PLUGIN_SETTINGS_DIR
except Exception:
    _settings_dir = ""
if not _settings_dir:
    _settings_dir = os.environ.get("DECKY_PLUGIN_SETTINGS_DIR", "")
if not _settings_dir:
    _settings_dir = os.path.join(os.environ.get("HOME", "/home/deck"), "homebrew", "settings", "DeckyPlex")
_settings_file = os.path.join(_settings_dir, "settings.json")


def _load_settings() -> Dict[str, Any]:
    """Load settings from JSON file, merging with defaults."""
    try:
        if os.path.exists(_settings_file):
            with open(_settings_file, "r") as f:
                saved = json.load(f)
            # Merge with defaults so new keys are present
            merged = {**DEFAULT_SETTINGS, **saved}
            # Filter to known keys only
            known_keys = set(DEFAULT_SETTINGS.keys())
            return {k: v for k, v in merged.items() if k in known_keys}
    except Exception as e:
        logger.error(f"Failed to load settings: {e}")
    return dict(DEFAULT_SETTINGS)


def _save_settings(settings: Dict[str, Any]) -> None:
    """Save settings to JSON file. Only saves known keys."""
    try:
        known_keys = set(DEFAULT_SETTINGS.keys())
        filtered = {k: v for k, v in settings.items() if k in known_keys}
        settings_dir = os.path.dirname(_settings_file)
        if settings_dir:
            os.makedirs(settings_dir, exist_ok=True)
        with open(_settings_file, "w") as f:
            json.dump(filtered, f, indent=4)
        logger.debug(f"Settings saved to: {_settings_file}")
    except Exception as e:
        logger.error(f"Failed to save settings: {e}")
        raise


# Store PIN state across calls
_pin_state: Dict[str, Any] = {}
_plex_cache_key = None
_plex_cache_instance = None


class PlexHTTP:
    """Small Decky-facing adapter around the bundled python-plexapi SDK."""

    def __init__(self, base_url: str, token: str):
        import requests
        from plexapi.server import PlexServer

        self.base_url = base_url.rstrip("/")
        self.token = token
        session = requests.Session()
        session.verify = False
        self.sdk = PlexServer(self.base_url, token, session=session, timeout=10)

    @staticmethod
    def _item_dict(item: Any) -> Dict[str, Any]:
        def attr(name, default=""):
            value = getattr(item, name, default)
            return default if value is None else value

        item_type = attr("type")
        artist = attr("grandparentTitle")
        if item_type == "album":
            artist = artist or attr("parentTitle")
            if not artist:
                try:
                    artist = item.artist().title or ""
                except Exception:
                    artist = ""

        return {
            "id": str(attr("ratingKey")), "key": attr("key"),
            "title": attr("title"), "type": item_type, "artist": artist,
            "thumb": attr("thumbUrl"), "art": attr("artUrl"),
            "summary": attr("summary"), "year": attr("year"),
            "index": attr("index"), "parentTitle": attr("parentTitle"),
            "grandparentTitle": attr("grandparentTitle"),
            "leafCount": attr("leafCount", 0), "viewCount": attr("viewCount", 0),
            "duration": attr("duration", 0),
        }

    def discover_players(self) -> List[Dict[str, str]]:
        return [{
            "title": client.title or "", "product": client.product or "",
            "machineIdentifier": client.machineIdentifier or "",
            "key": client.machineIdentifier or "",
        } for client in self.sdk.clients()]

    def get_sessions(self) -> List[Any]:
        return self.sdk.sessions()

    def _client(self, machine_id: str):
        client = next((c for c in self.sdk.clients() if c.machineIdentifier == machine_id), None)
        if client is None:
            raise RuntimeError("Plex player is no longer connected")
        return client

    def play(self, machine_id: str) -> None:
        self._client(machine_id).play(mtype="music")

    def pause(self, machine_id: str) -> None:
        self._client(machine_id).pause(mtype="music")

    def skip_next(self, machine_id: str) -> None:
        self._client(machine_id).skipNext(mtype="music")

    def skip_previous(self, machine_id: str) -> None:
        self._client(machine_id).skipPrevious(mtype="music")

    def set_volume(self, machine_id: str, volume: int) -> None:
        self._client(machine_id).setVolume(volume, mtype="music")

    def get_library_sections(self) -> List[Dict[str, Any]]:
        return [{"id": str(section.key), "name": section.title, "type": section.type}
                for section in self.sdk.library.sections()]

    def get_section_contents(self, section_id: str, type_filter: str = "", limit: int = 50) -> List[Dict[str, Any]]:
        section = self.sdk.library.sectionByID(int(section_id))
        item_type = type_filter if type_filter in ("artist", "album", "track") else "artist"
        sort = "titleSort:asc"
        return [self._item_dict(item) for item in section.search(libtype=item_type, sort=sort, maxresults=limit)]

    def get_metadata_children(self, metadata_id: str) -> List[Dict[str, Any]]:
        item = self.sdk.fetchItem(int(metadata_id))
        if getattr(item, "type", "") == "artist":
            try:
                children = item.albums(sort="titleSort:asc")
            except Exception:
                children = []
            if not children:
                children = item.fetchItems(f"{item.key}/children")
        elif getattr(item, "type", "") == "album":
            children = item.tracks()
            if not children:
                children = item.fetchItems(f"{item.key}/children")
        else:
            children = item.fetchItems(f"{item.key}/children")
        return [self._item_dict(child) for child in children]

    def get_artist_tracks(self, artist_id: str) -> List[Dict[str, Any]]:
        artist = self.sdk.fetchItem(int(artist_id))
        if getattr(artist, "type", "") != "artist":
            raise ValueError("Selected Plex item is not an artist")
        tracks = artist.tracks(maxresults=1000)
        return [self._item_dict(track) for track in tracks]

    def get_recently_played(self, section_id: str = "", limit: int = 50) -> List[Dict[str, Any]]:
        """Return recently played tracks using PlexAPI's server history endpoint."""
        history = self.sdk.history(
            maxresults=max(1, min(int(limit), 100)),
            librarySectionID=int(section_id) if section_id else None,
        )
        result = []
        for history_item in history:
            if getattr(history_item, "type", "") != "track":
                continue
            try:
                source = history_item.source()
                if source is not None:
                    history_item = source
            except Exception:
                pass
            result.append(self._item_dict(history_item))
        return result

    def get_recently_added(self, section_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Return the newest albums in a music library, using PlexAPI sorting."""
        section = self.sdk.library.sectionByID(int(section_id))
        albums = section.search(libtype="album", sort="addedAt:desc", maxresults=max(1, min(int(limit), 100)))
        return [self._item_dict(album) for album in albums]

    def get_audio_playlists(self, limit: int = 100) -> List[Dict[str, Any]]:
        playlists = self.sdk.playlists(playlistType="audio", sort="titleSort:asc")
        result = []
        for playlist in playlists[:max(1, min(int(limit), 100))]:
            composite = getattr(playlist, "composite", "") or ""
            result.append({
                "id": str(playlist.ratingKey), "key": playlist.key,
                "title": playlist.title or "Untitled playlist", "type": "playlist",
                "thumb": self.sdk.url(composite, includeToken=True) if composite else "",
                "summary": playlist.summary or "", "leafCount": playlist.leafCount or 0,
                "duration": playlist.duration or 0,
            })
        return result

    def get_playlist_tracks(self, playlist_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        playlists = self.sdk.playlists(playlistType="audio")
        playlist = next((item for item in playlists if str(item.ratingKey) == str(playlist_id)), None)
        if playlist is None:
            raise ValueError("Audio playlist not found")
        return [self._item_dict(item) for item in playlist.items(libtype="track")[:max(1, min(int(limit), 200))]]

    def search_library(self, query: str, section_id: str = "", limit: int = 20) -> List[Dict[str, Any]]:
        if section_id:
            results = self.sdk.library.sectionByID(int(section_id)).search(title=query, maxresults=limit)
        else:
            results = self.sdk.search(query, mediatype="audio", limit=limit)
        return [self._item_dict(item) for item in results]

    def get_hubs(self, section_ids: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        hubs = self.sdk.library.hubs(sectionID=section_ids or None)
        result = []
        for hub in hubs:
            items = [self._item_dict(item) for item in hub.items()]
            if items:
                result.append({"title": hub.title or "", "key": hub.key or "",
                               "type": hub.type or "", "items": items})
        return result

    def get_server_identity(self) -> Dict[str, str]:
        return {"machineIdentifier": self.sdk.machineIdentifier or "",
                "friendlyName": self.sdk.friendlyName or "", "version": self.sdk.version or ""}

    def get_stream_urls(self, rating_key: str) -> Dict[str, str]:
        """Prefer PlexAPI's direct media URL for common codecs, with MP3 transcode fallback."""
        track = self.sdk.fetchItem(int(rating_key))
        if getattr(track, "type", "") != "track":
            raise ValueError("Selected Plex item is not a music track")
        media = list(getattr(track, "media", []) or [])
        part = next((part for item in media for part in (getattr(item, "parts", []) or [])
                     if getattr(part, "key", "")), None)
        direct_url = self.sdk.url(part.key, includeToken=True) if part else ""
        codec = str(getattr(media[0], "audioCodec", "") or "").lower() if media else ""
        # The transcoder requires a client identifier. Reuse PlexAPI's
        # configured identifier and advertise an MP3 target profile so the
        # response is an audio/mpeg byte stream, not a manifest/error document.
        client_identifier = self.sdk._headers().get("X-Plex-Client-Identifier", "deckyplex")
        profile_extra = (
            "add-transcode-target(type=musicProfile&context=streaming&"
            "protocol=http&container=mp3&audioCodec=mp3)"
        )
        params = urllib.parse.urlencode({
            "path": track.key, "mediaIndex": 0, "partIndex": 0,
            "protocol": "http", "audioCodec": "mp3",
            "directPlay": 0, "directStream": 0, "directStreamAudio": 0,
            "musicBitrate": 320,
            "X-Plex-Client-Identifier": client_identifier,
            "X-Plex-Client-Profile-Name": "Generic",
            "X-Plex-Client-Profile-Extra": profile_extra,
            "X-Plex-Platform": "Chrome",
            "X-Plex-Product": "DeckyPlex",
            "X-Plex-Version": "1.0.0",
        })
        transcode_url = self.sdk.url(f"/music/:/transcode/universal/start.mp3?{params}", includeToken=True)
        if direct_url and codec in ("mp3", "flac"):
            return {"stream_url": direct_url, "fallback_stream_url": transcode_url,
                    "stream_mode": f"direct-{codec}"}
        return {"stream_url": transcode_url,
                "fallback_stream_url": direct_url if codec in ("mp3", "flac") else "",
                "stream_mode": "transcode-mp3"}

    def inspect_stream(self, rating_key: str, stream_url: str) -> Dict[str, Any]:
        """Read a tiny range from the exact stream URL the client rejected."""
        expected = urllib.parse.urlparse(self.sdk._baseurl)
        supplied = urllib.parse.urlparse(stream_url)
        if supplied.scheme not in ("http", "https") or supplied.netloc != expected.netloc:
            raise ValueError("Stream diagnostic URL does not match the connected Plex server")
        response = self.sdk._session.get(
            stream_url, headers={"Range": "bytes=0-255"}, stream=True, timeout=(4, 8)
        )
        try:
            body = next(response.iter_content(256), b"")
            content_type = response.headers.get("Content-Type", "")
            result = {
                "status": response.status_code,
                "content_type": content_type,
                "content_range": response.headers.get("Content-Range", ""),
                "prefix_hex": body[:32].hex(),
            }
            if "text" in content_type or "json" in content_type or "xml" in content_type:
                result["body_preview"] = body[:256].decode("utf-8", errors="replace")
            return result
        finally:
            response.close()


class Plugin:
    """Decky plugin backend for Plexamp integration."""

    async def _main(self):
        """Called when the plugin is loaded."""
        logger.info(f"DeckyPlex plugin loaded, settings file: {_settings_file}")
        settings_dir = os.path.dirname(_settings_file)
        if settings_dir:
            logger.info(f"Settings dir exists: {os.path.exists(settings_dir)}")
            try:
                os.makedirs(settings_dir, exist_ok=True)
                logger.info(f"Settings dir ensured: {settings_dir}")
            except Exception as e:
                logger.error(f"Failed to create settings dir: {e}")
        else:
            logger.warning(f"Settings file has no directory: {_settings_file}")

    async def _unload(self):
        """Called when the plugin is unloaded."""
        logger.info("DeckyPlex plugin unloaded")

    async def _uninstall(self):
        """Called when the plugin is uninstalled. Clean up saved settings."""
        logger.info("DeckyPlex plugin uninstalled")
        try:
            if os.path.exists(_settings_file):
                os.remove(_settings_file)
                logger.info(f"Removed settings file: {_settings_file}")
            settings_dir = os.path.dirname(_settings_file)
            if os.path.exists(settings_dir) and not os.listdir(settings_dir):
                os.rmdir(settings_dir)
                logger.info(f"Removed empty settings directory: {settings_dir}")
        except Exception as e:
            logger.error(f"Failed to clean up settings on uninstall: {e}")

    async def log_message(self, message: str) -> Dict[str, Any]:
        """Log a message from the frontend to the backend log file.
        
        Used for debugging browser-side events (audio playback) that don't
        appear in backend logs.
        """
        logger.info(f"[frontend] {message}")
        return {"ok": True}

    async def health_check(self) -> Dict[str, Any]:
        """Simple health check to verify the backend is running."""
        return {"ok": True, "settings_file": _settings_file}

    async def get_settings(self) -> Dict[str, Any]:
        """Return current plugin settings."""
        settings = _load_settings()
        # DEBUG: log connection details with masked tokens
        token = settings.get("plex_token", "")
        server_token = settings.get("server_access_token", "")
        logger.debug(f"get_settings: plex_token={'***' + token[-4:] if token else '(empty)'}, "
                      f"server_url={settings.get('selected_server_url', '(empty)')}, "
                      f"server_token={'***' + server_token[-4:] if server_token else '(empty)'}, "
                      f"server_id={settings.get('selected_server_id', '(empty)')}, "
                      f"player_id={settings.get('selected_player_id', '(empty)')}, "
                      f"plexamp_url={settings.get('plexamp_url', '(empty)')}, "
                      f"username={settings.get('logged_in_username', '(empty)')}")
        return settings

    async def set_settings(self, settings: Dict[str, Any]) -> Dict[str, Any]:
        """Save and return updated plugin settings. Only saves known keys to avoid errors."""
        try:
            token = settings.get("plex_token", "")
            server_url = settings.get("selected_server_url", "")
            logger.debug(f"set_settings: plex_token={'***' + token[-4:] if token else '(empty)'}, "
                          f"server_url={'***' + server_url[-10:] if server_url else '(empty)'}")
            logger.debug(f"Saving to: {_settings_file}")
            # Merge with defaults to ensure all keys are present
            merged = {**DEFAULT_SETTINGS, **settings}
            # Only keep known keys
            known_keys = set(DEFAULT_SETTINGS.keys())
            filtered = {k: v for k, v in merged.items() if k in known_keys}
            _save_settings(filtered)
            # Verify the file was actually written
            if os.path.exists(_settings_file):
                logger.debug(f"Settings saved to: {_settings_file}")
            else:
                logger.error(f"Settings file NOT found after save at: {_settings_file}")
            return filtered
        except Exception as e:
            logger.error(f"Failed to save settings: {e}")
            return {"error": str(e)}

    def _get_plex(self) -> Optional[PlexHTTP]:
        """Connect to the Plex server using saved settings."""
        global _plex_cache_key, _plex_cache_instance
        settings = _load_settings()
        url = self._get_plex_server_url()
        # Use server-specific access token if available, otherwise fall back to user token
        token = self._get_server_access_token() or settings.get("plex_token", "").strip()
        if not url or not token:
            # Only log once at DEBUG level — this is expected when no server is configured
            logger.debug(f"_get_plex: missing url or token (url={bool(url)}, token={bool(token)}), plex_token in settings={bool(settings.get('plex_token', '').strip())}")
            return None
        cache_key = (url.rstrip("/"), token)
        if _plex_cache_instance is not None and _plex_cache_key == cache_key:
            return _plex_cache_instance
        try:
            plex = PlexHTTP(url, token)
            # PlexServer validates the connection during construction and keeps
            # the authenticated session for every subsequent SDK request.
            logger.debug(f"_get_plex: connected to server at {url}")
            _plex_cache_key = cache_key
            _plex_cache_instance = plex
            return plex
        except Exception as e:
            logger.debug(f"_get_plex: cannot connect to {url}: {e}")
            return None

    def _find_plexamp_player(self, plex: PlexHTTP) -> Optional[Dict[str, str]]:
        """Find the Plexamp/Caldera player on the Plex server."""
        settings = _load_settings()
        selected_id = settings.get("selected_player_id", "").strip()

        try:
            clients = plex.discover_players()
            # If a specific player is selected, match by machineIdentifier
            if selected_id:
                for client in clients:
                    if client.get("machineIdentifier") == selected_id:
                        return client
            # Otherwise, find the first Plexamp/Caldera player
            for client in clients:
                product = (client.get("product") or "").lower()
                if "caldera" in product or "plexamp" in product:
                    return client
        except Exception as e:
            logger.error(f"Failed to find Plexamp player: {e}")
        return None

    async def discover_players(self) -> Dict[str, Any]:
        """List all connected Plex clients for player selection."""
        plex = self._get_plex()
        if not plex:
            return {"players": [], "error": "Not connected to Plex server"}
        try:
            clients = plex.discover_players()
            players = []
            for client in clients:
                players.append({
                    "name": client.get("title") or client.get("product") or "Unknown",
                    "product": client.get("product", ""),
                    "machineIdentifier": client.get("machineIdentifier", ""),
                    "key": client.get("key", ""),
                })
            return {"players": players}
        except Exception as e:
            logger.error(f"Failed to discover players: {e}")
            return {"players": [], "error": str(e)}

    async def get_playback_state(self) -> Dict[str, Any]:
        """Get current playback state from server sessions.
        
        Uses /status/sessions to check what's playing, which works regardless
        of which player is controlling playback (e.g., Plexamp on iPhone).
        """
        plex = self._get_plex()
        if not plex:
            return {"state": "disconnected", "error": "Not connected to Plex server"}
        try:
            sessions = plex.get_sessions()
            for meta in sessions:
                if getattr(meta, "type", "") == "track":
                    return {"state": "playing"}
            return {"state": "stopped"}
        except Exception as e:
            logger.error(f"Failed to get playback state: {e}")
            return {"state": "error", "error": str(e)}

    async def get_current_track(self) -> Dict[str, Any]:
        """Get the currently playing track information from server sessions.
        
        Uses /status/sessions which works regardless of which player is controlling playback.
        """
        plex = self._get_plex()
        if not plex:
            return {"error": "Not connected to Plex server"}
        try:
            sessions = plex.get_sessions()
            for meta in sessions:
                if getattr(meta, "type", "") == "track":
                    return {
                        "title": meta.title or "",
                        "artist": meta.grandparentTitle or "",
                        "album": meta.parentTitle or "",
                        "duration": meta.duration or 0,
                        "thumb": meta.thumbUrl or "",
                    }
            return {"title": "", "artist": "", "album": ""}
        except Exception as e:
            logger.error(f"Failed to get current track: {e}")
            return {"error": str(e)}

    def _find_active_player(self, plex: PlexHTTP) -> Optional[Dict[str, str]]:
        """Find the player currently controlling playback.
        
        First tries to get the player key from the active session.
        Falls back to discovering Plexamp/Caldera players.
        """
        # Try to find the player from the current session
        try:
            sessions = plex.get_sessions()
            for meta in sessions:
                client = getattr(meta, "player", None)
                if client and client.machineIdentifier:
                    return {"key": client.machineIdentifier, "title": client.title or "Unknown",
                            "product": client.product or ""}
        except Exception as e:
            logger.debug(f"Could not find player from session: {e}")
        
        # Fall back to Plexamp/Caldera discovery
        return self._find_plexamp_player(plex)

    async def play(self) -> Dict[str, Any]:
        """Play or resume playback."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            player = self._find_active_player(plex)
            if not player:
                return {"success": False, "error": "No active player found"}
            plex.play(player["key"])
            return {"success": True}
        except Exception as e:
            logger.error(f"Failed to play: {e}")
            return {"success": False, "error": str(e)}

    async def pause(self) -> Dict[str, Any]:
        """Pause playback."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            player = self._find_active_player(plex)
            if not player:
                return {"success": False, "error": "No active player found"}
            plex.pause(player["key"])
            return {"success": True}
        except Exception as e:
            logger.error(f"Failed to pause: {e}")
            return {"success": False, "error": str(e)}

    async def skip_next(self) -> Dict[str, Any]:
        """Skip to the next track."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            player = self._find_active_player(plex)
            if not player:
                return {"success": False, "error": "No active player found"}
            plex.skip_next(player["key"])
            return {"success": True}
        except Exception as e:
            logger.error(f"Failed to skip next: {e}")
            return {"success": False, "error": str(e)}

    async def skip_previous(self) -> Dict[str, Any]:
        """Skip to the previous track."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            player = self._find_active_player(plex)
            if not player:
                return {"success": False, "error": "No active player found"}
            plex.skip_previous(player["key"])
            return {"success": True}
        except Exception as e:
            logger.error(f"Failed to skip previous: {e}")
            return {"success": False, "error": str(e)}

    async def set_volume(self, volume: int) -> Dict[str, Any]:
        """Set the player volume (0-100)."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            player = self._find_active_player(plex)
            if not player:
                return {"success": False, "error": "No active player found"}
            plex.set_volume(player["key"], volume)
            return {"success": True}
        except Exception as e:
            logger.error(f"Failed to set volume: {e}")
            return {"success": False, "error": str(e)}

    # ---- Library browsing ----

    async def get_library_sections(self) -> Dict[str, Any]:
        """Get all library sections, filtering for music sections."""
        plex = self._get_plex()
        if not plex:
            return {"sections": [], "error": "Not connected to Plex server"}
        try:
            sections = plex.get_library_sections()
            logger.debug(f"get_library_sections: found {len(sections)} sections")
            # Filter for music sections only
            music_sections = [s for s in sections if s.get("type") == "artist"]
            logger.debug(f"get_library_sections: {len(music_sections)} music sections")
            return {"sections": music_sections}
        except Exception as e:
            logger.error(f"Failed to get library sections: {e}")
            return {"sections": [], "error": str(e)}

    async def get_section_contents(self, section_id: str, item_type: str = "", limit: int = 50) -> Dict[str, Any]:
        """Get contents of a music library section (artists, albums, etc.)."""
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            items = plex.get_section_contents(section_id, item_type, limit)
            return {"items": items}
        except Exception as e:
            logger.error(f"Failed to get section contents: {e}")
            return {"items": [], "error": str(e)}

    async def get_metadata_children(self, metadata_id: str) -> Dict[str, Any]:
        """Get children of a metadata item (album tracks, artist albums)."""
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            items = plex.get_metadata_children(metadata_id)
            return {"items": items}
        except Exception as e:
            logger.error(f"Failed to get metadata children: {e}")
            return {"items": [], "error": str(e)}

    async def get_artist_tracks(self, artist_id: str) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": plex.get_artist_tracks(artist_id)}
        except Exception as e:
            logger.error(f"Failed to get tracks for artist {artist_id}: {e}")
            return {"items": [], "error": str(e)}

    async def get_recently_played(self, section_id: str = "", limit: int = 50) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": plex.get_recently_played(section_id, limit)}
        except Exception as e:
            logger.error(f"Failed to get recently played tracks: {e}")
            return {"items": [], "error": str(e)}

    async def get_recently_added(self, section_id: str, limit: int = 50) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": plex.get_recently_added(section_id, limit)}
        except Exception as e:
            logger.error(f"Failed to get recently added albums: {e}")
            return {"items": [], "error": str(e)}

    async def get_audio_playlists(self, limit: int = 100) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": plex.get_audio_playlists(limit)}
        except Exception as e:
            logger.error(f"Failed to get audio playlists: {e}")
            return {"items": [], "error": str(e)}

    async def get_playlist_tracks(self, playlist_id: str, limit: int = 100) -> Dict[str, Any]:
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            return {"items": plex.get_playlist_tracks(playlist_id, limit)}
        except Exception as e:
            logger.error(f"Failed to get tracks from playlist {playlist_id}: {e}")
            return {"items": [], "error": str(e)}

    async def search_library(self, query: str, section_id: str = "", limit: int = 20) -> Dict[str, Any]:
        """Search the library for tracks, albums, or artists."""
        plex = self._get_plex()
        if not plex:
            return {"items": [], "error": "Not connected to Plex server"}
        try:
            items = plex.search_library(query, section_id, limit)
            return {"items": items}
        except Exception as e:
            logger.error(f"Failed to search library: {e}")
            return {"items": [], "error": str(e)}

    async def get_hubs(self) -> Dict[str, Any]:
        """Get hubs (recently played, on deck, etc.), limited to music sections only."""
        plex = self._get_plex()
        if not plex:
            return {"hubs": [], "error": "Not connected to Plex server"}
        try:
            # Get music library section IDs so /hubs only returns music content
            sections = plex.get_library_sections()
            music_section_ids = [s["id"] for s in sections if s.get("type") == "artist"]
            logger.debug(f"get_hubs: {len(music_section_ids)} music section(s): {music_section_ids}")
            
            if not music_section_ids:
                return {"hubs": []}
            
            hubs = plex.get_hubs(section_ids=music_section_ids)
            logger.debug(f"get_hubs: found {len(hubs)} music hubs")
            return {"hubs": hubs}
        except Exception as e:
            logger.error(f"Failed to get hubs: {e}")
            return {"hubs": [], "error": str(e)}

    async def get_server_identity(self) -> Dict[str, Any]:
        """Get server identity info including machineIdentifier."""
        plex = self._get_plex()
        if not plex:
            return {"error": "Not connected to Plex server"}
        try:
            identity = plex.get_server_identity()
            return identity
        except Exception as e:
            logger.error(f"Failed to get server identity: {e}")
            return {"error": str(e)}

    async def play_track(self, rating_key: str, section_id: str) -> Dict[str, Any]:
        """Get a stream URL for a track so the frontend can play it.

        Creates a play queue on the server, then starts an audio transcode session
        to get a playable stream URL. The frontend uses an HTML5 <audio> element
        to play the stream — this plugin IS the player, not a remote control.
        """
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            # PlexAPI's getStreamURL() is HLS-only; our adapter uses the SDK's
            # authenticated URL builder for the single-file MP3 transcode.
            streams = plex.get_stream_urls(rating_key)
            logger.info("play_track: using %s for track %s", streams.get("stream_mode"), rating_key)
            play_queue_id = ""
            selected_item_id = ""
            container_key = ""
            logger.info(f"play_track: stream URL obtained for track {rating_key}")

            return {
                "success": True,
                **streams,
                "play_queue_id": play_queue_id,
                "selected_item_id": selected_item_id,
                "container_key": container_key,
                "rating_key": rating_key,
            }
        except Exception as e:
            logger.error(f"Failed to get stream for track: {e}", exc_info=True)
            return {"success": False, "error": str(e)}

    async def inspect_stream(self, rating_key: str, stream_url: str) -> Dict[str, Any]:
        """Inspect Plex's response for a track the Decky audio element rejected."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        try:
            result = plex.inspect_stream(rating_key, stream_url)
            logger.info(
                "Stream diagnostic for track %s: status=%s content_type=%s content_range=%s prefix=%s",
                rating_key, result.get("status"), result.get("content_type"),
                result.get("content_range"), result.get("prefix_hex"),
            )
            preview = result.get("body_preview")
            if preview:
                logger.info("Stream diagnostic response preview for track %s: %s", rating_key, preview[:256])
            return {"success": True, **result}
        except Exception as e:
            logger.error(f"Stream diagnostic failed for track {rating_key}: {e}", exc_info=True)
            return {"success": False, "error": str(e)}

    async def report_playback(self, rating_key: str, time_ms: int, state: str,
                              duration_ms: int = 0) -> Dict[str, Any]:
        """Report this local player's timeline through PlexAPI for sessions/history."""
        plex = self._get_plex()
        if not plex:
            return {"success": False, "error": "Not connected to Plex server"}
        if state not in ("playing", "paused", "stopped"):
            return {"success": False, "error": "Invalid playback state"}
        try:
            track = plex.sdk.fetchItem(int(rating_key))
            track.updateTimeline(
                max(0, int(time_ms)),
                state=state,
                duration=max(0, int(duration_ms)) or None,
            )
            logger.debug(f"Reported Plex timeline: track={rating_key}, state={state}, time={time_ms}")
            return {"success": True}
        except Exception as e:
            logger.warning(f"Failed to report Plex timeline for track {rating_key}: {e}")
            return {"success": False, "error": str(e)}

    async def plex_login(self) -> Dict[str, Any]:
        """Start PIN authentication with python-plexapi's login helper."""
        try:
            import requests
            from plexapi.myplex import MyPlexPinLogin

            client_id = secrets.token_hex(16)
            session = requests.Session()
            session.verify = False
            headers = {
                "X-Plex-Client-Identifier": client_id,
                "X-Plex-Product": "DeckyPlex",
                "X-Plex-Version": "1.0.0",
                "X-Plex-Platform": "SteamOS",
                "X-Plex-Device": "Steam Machine",
                "X-Plex-Device-Name": "DeckyPlex",
            }
            pin_login = MyPlexPinLogin(session=session, requestTimeout=15, headers=headers)
            pin = pin_login.pin
            if not pin:
                return {"error": "Plex did not return a login PIN."}
            _pin_state.clear()
            _pin_state.update({"login": pin_login, "client_id": client_id})
            logger.info("Started Plex PIN login through PlexAPI")
            return {"pin": pin, "url": "https://plex.tv/link"}
        except Exception as e:
            logger.error(f"Failed to start Plex login through PlexAPI: {e}", exc_info=True)
            return {"error": f"Plex login failed: {e}"}

    def _account_resources(self, auth_token: str) -> Dict[str, Any]:
        """Read account identity and Plex servers through PlexAPI resource objects."""
        import requests
        from plexapi.myplex import MyPlexAccount

        session = requests.Session()
        session.verify = False
        account = MyPlexAccount(token=auth_token, session=session, timeout=10)
        servers = []
        plexamp_url = ""
        plexamp_client_id = ""
        for resource in account.resources():
            product = (resource.product or "").lower()
            connections = resource.preferred_connections(
                locations=["local", "remote"], schemes=["http", "https"], ipvs=["ipv4", "ipv6"])
            if not connections:
                continue
            if "server" in (resource.provides or "").split(","):
                try:
                    connected_server = resource.connect(timeout=4, locations=["local", "remote"])
                    servers.append({
                        "id": connected_server.machineIdentifier or resource.clientIdentifier,
                        "name": connected_server.friendlyName or resource.name or "Plex Media Server",
                        "base_url": connected_server._baseurl.rstrip("/"),
                        "access_token": resource.accessToken or auth_token,
                    })
                except Exception as e:
                    logger.warning("Could not connect to Plex server resource %s: %s", resource.name, e)
            elif "plexamp" in product or "caldera" in product:
                plexamp_url = connections[0].rstrip("/")
                plexamp_client_id = resource.clientIdentifier or ""
        return {
            "username": account.username or account.title or "",
            "servers": servers,
            "plexamp_url": plexamp_url,
            "plexamp_client_id": plexamp_client_id,
        }

    async def plex_login_poll(self) -> Dict[str, Any]:
        """Poll the PlexAPI PIN login object and discover account resources."""
        pin_login = _pin_state.get("login")
        if pin_login is None:
            return {"error": "No active Plex login. Start login again."}

        try:
            if not pin_login.checkLogin():
                if pin_login.expired:
                    _pin_state.clear()
                    return {"error": "Plex login expired or could not be verified. Start again."}
                return {}

            auth_token = pin_login.token
            try:
                info = self._account_resources(auth_token)
            except Exception as e:
                logger.error(f"Plex login succeeded but resource discovery failed: {e}", exc_info=True)
                info = {"username": "", "servers": [], "plexamp_url": "", "plexamp_client_id": ""}

            settings = _load_settings()
            if info["plexamp_url"]:
                settings["plexamp_url"] = info["plexamp_url"]
                settings["selected_player_id"] = info["plexamp_client_id"]
                _save_settings(settings)

            _pin_state.clear()
            logger.info("Plex login succeeded for %s; discovered %d server(s)",
                        info["username"] or "account", len(info["servers"]))
            return {
                "token": auth_token,
                "username": info["username"],
                "servers": info["servers"],
                "player_id": info["plexamp_client_id"],
                "plexamp_url": info["plexamp_url"],
            }
        except Exception as e:
            logger.error(f"Plex PIN polling failed: {e}", exc_info=True)
            return {"error": f"Plex login check failed: {e}"}

    async def discover_servers(self) -> Dict[str, Any]:
        """Discover Plex servers with PlexAPI account and resource objects."""
        settings = _load_settings()
        token = settings.get("plex_token", "").strip()
        if not token:
            return {"servers": [], "error": "Not logged in to Plex"}
        try:
            info = self._account_resources(token)
            if info["plexamp_url"]:
                settings["plexamp_url"] = info["plexamp_url"]
                settings["selected_player_id"] = info["plexamp_client_id"]
                _save_settings(settings)
            servers = info["servers"]
            if not servers and settings.get("selected_server_url") and settings.get("selected_server_id"):
                servers = [{
                    "id": settings["selected_server_id"],
                    "name": settings.get("selected_server_name") or "Saved Plex server",
                    "base_url": settings["selected_server_url"],
                    "access_token": settings.get("server_access_token") or token,
                }]
            return {
                "servers": servers,
                "plexamp_url": info["plexamp_url"],
                "players": [],
            }
        except Exception as e:
            logger.error(f"PlexAPI server discovery failed: {e}", exc_info=True)
            return {"servers": [], "error": f"Could not discover Plex servers: {e}"}

    async def validate_connection(self) -> Dict[str, Any]:
        """Validate the selected connection through PlexServer's SDK session."""
        try:
            plex = self._get_plex()
            if not plex:
                return {"valid": False, "error": "Select a Plex server in Settings first."}
            identity = plex.get_server_identity()
            return {
                "valid": True,
                "serverName": identity.get("friendlyName", ""),
                "machineIdentifier": identity.get("machineIdentifier", ""),
            }
        except Exception as e:
            logger.error(f"PlexAPI connection validation failed: {e}", exc_info=True)
            return {"valid": False, "error": str(e)}

    def _get_plex_server_url(self) -> str:
        """Get the Plex server URL from saved settings.

        Uses the saved server URL directly instead of calling plex.tv every time.
        """
        settings = _load_settings()
        # Prefer the saved server URL
        url = settings.get("selected_server_url", "").strip()
        if url:
            return url
        # Fallback to the legacy plex_server_url field
        url = settings.get("plex_server_url", "").strip()
        return url

    def _get_server_access_token(self) -> str:
        """Get the server-specific access token from settings."""
        settings = _load_settings()
        return settings.get("server_access_token", "")

