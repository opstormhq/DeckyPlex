"""Test the actual Decky install archive with a stub Decky runtime and Plex server."""

import importlib.util
import json
import logging
import sys
import unittest
import xml
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit
from zipfile import ZipFile


class PackageTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        temp = cls.enterClassContext(TemporaryDirectory())
        cls.root = Path(temp) / "DeckyPlex"
        with ZipFile("DeckyPlex.zip") as archive:
            for name in archive.namelist():
                path = PurePosixPath(name)
                if path.parts[0] != "DeckyPlex" or ".." in path.parts:
                    raise AssertionError(f"Unexpected package path: {name}")
            archive.extractall(temp)

        cls.enterClassContext(patch.object(sys, "path", sys.path[:]))
        cls.enterClassContext(patch.dict(sys.modules, {
            "decky": SimpleNamespace(logger=logging.getLogger("test_deckyplex")),
        }))
        # Decky can preload xml, then leave it without the stdlib XML sources.
        cls.enterClassContext(patch.object(xml, "__path__", []))
        spec = importlib.util.spec_from_file_location("packaged_deckyplex", cls.root / "main.py")
        cls.backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.backend)

    def setUp(self):
        temp = self.enterContext(TemporaryDirectory())
        self.enterContext(patch.multiple(self.backend, _settings_file=str(Path(temp) / "settings.json"),
                                         _plex_cache=(None, None), _pin_state={}))
        self.plugin = self.backend.Plugin()

    def test_archive_has_runtime_files_and_version(self):
        for filename in ("main.py", "video_pip.py", "dist/index.js", "assets/game-pip.js", "assets/hls.min.js",
                         "LICENSE", "LICENSE-hls.js", "py_modules/xml/LICENSE.txt"):
            self.assertGreater((self.root / filename).stat().st_size, 0, filename)
        for path in (self.root / "py_modules").rglob("*"):
            self.assertNotIn(path.suffix, (".so", ".dylib", ".pyd"), path.name)
        manifest = json.loads((self.root / "plugin.json").read_text())
        version = json.loads(Path("package.json").read_text())["version"]
        lockfile = json.loads(Path("package-lock.json").read_text())
        self.assertEqual(manifest["name"], "DeckyPlex")
        self.assertEqual(lockfile["version"], version)
        self.assertEqual(lockfile["packages"][""]["version"], version)
        self.assertEqual(self.backend.APP_VERSION, version)
        receiver = self.backend.PlexCompanionReceiver("test-player")
        self.assertIn(f"Version: {version}\r\n".encode(), receiver._response_headers())

    async def test_quick_access_setting_defaults_and_persists(self):
        self.assertIs((await self.plugin.get_settings())["quick_player_close_tray_on_back"], True)
        await self.plugin.set_settings({"quick_player_close_tray_on_back": False})
        reloaded = await self.backend.Plugin().get_settings()
        self.assertIs(reloaded["quick_player_close_tray_on_back"], False)

    async def test_packaged_plex_sdk_connects_and_prepares_tokenless_music(self):
        import plexapi
        import requests
        from xml.etree import ElementTree

        modules = self.root / "py_modules"
        for dependency in (plexapi, requests, ElementTree):
            self.assertTrue(Path(dependency.__file__).is_relative_to(modules))

        documents = {
            "/": '<MediaContainer machineIdentifier="test-server" friendlyName="Test Plex" version="1.43.4.0"/>',
            "/library": "<MediaContainer/>",
            "/library/sections": '<MediaContainer><Directory key="1" title="Music" type="artist"/></MediaContainer>',
            "/library/metadata/30": (
                '<MediaContainer size="1"><Track ratingKey="30" key="/library/metadata/30" title="Test Track" '
                'type="track" duration="90000"><Media audioCodec="mp3" container="mp3"><Part id="30" '
                'key="/library/parts/30/file.mp3" container="mp3"/></Media></Track></MediaContainer>'
            ),
        }

        def reply(_session, request, **_kwargs):
            url = urlsplit(request.url)
            self.assertEqual(url.netloc, "test.invalid:32400")
            self.assertNotIn("X-Plex-Token", request.headers)
            response = requests.Response()
            response.status_code = 200
            response.url = request.url
            response._content = documents[url.path].encode()
            return response

        with patch.object(requests.Session, "send", reply):
            settings = await self.plugin.connect_local_server("test.invalid")
            self.assertIs(settings["has_plex_token"], False)
            self.assertEqual(settings["library_selection_ids"], ["1"])
            stream = await self.plugin.play_track("30", "1")
        self.assertTrue(stream["success"], stream)
        self.assertEqual(stream["stream_mode"], "direct-mp3")
        self.assertEqual(stream["stream_url"], "http://test.invalid:32400/library/parts/30/file.mp3")
