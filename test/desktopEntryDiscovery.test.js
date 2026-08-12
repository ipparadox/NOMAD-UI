const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    DesktopEntryDiscovery,
    parseDesktopEntry,
    parseDesktopExec
} = require("../src/classes/desktopEntryDiscovery.js");

const parsed = parseDesktopEntry(`[Desktop Entry]
Type=Application
Name=Spotify Desktop
Exec=spotify --safe "two words" %U --uri=%u %%literal %i %c %k
StartupWMClass=Spotify
NoDisplay=true
Hidden=false
Terminal=false
`, {desktopId: "spotify.desktop", path: "/apps/spotify.desktop"});

assert.strictEqual(parsed.name, "Spotify Desktop");
assert.strictEqual(parsed.executable, "spotify");
assert.deepStrictEqual(parsed.args, ["--safe", "two words", "%literal"]);
assert.strictEqual(parsed.startupWMClass, "Spotify");
assert.strictEqual(parsed.noDisplay, true);
assert.strictEqual(parsed.hidden, false);
assert.strictEqual(parsed.type, "Application");
assert.strictEqual(parsed.terminal, false);

assert.deepStrictEqual(
    parseDesktopExec("vlc --started-from-file %F --meta=%c %%"),
    {executable: "vlc", args: ["--started-from-file", "%"]}
);
assert.throws(() => parseDesktopExec("spotify %Z"), /unsupported field code/);
assert.throws(() => parseDesktopExec("\"unterminated"), /unterminated quote/);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-desktop-discovery-"));
const userApplications = path.join(temporaryRoot, "user");
const systemApplications = path.join(temporaryRoot, "system");
fs.mkdirSync(userApplications);
fs.mkdirSync(systemApplications);
fs.writeFileSync(path.join(systemApplications, "spotify.desktop"), `[Desktop Entry]
Type=Application
Name=System Spotify
Exec=system-spotify
StartupWMClass=SystemSpotify
`);
fs.writeFileSync(path.join(userApplications, "spotify.desktop"), `[Desktop Entry]
Type=Application
Name=User Spotify
Exec=user-spotify %U
StartupWMClass=Spotify
`);
fs.writeFileSync(path.join(userApplications, "hidden.desktop"), `[Desktop Entry]
Type=Application
Name=Hidden App
Exec=hidden-app
Hidden=true
Terminal=true
`);
fs.writeFileSync(path.join(userApplications, "broken.desktop"), `[Desktop Entry]
Type=Application
Name=Broken
Exec=broken %Q
`);

const logs = [];
const discovery = new DesktopEntryDiscovery({
    directories: [userApplications, systemApplications],
    log: (level, message) => logs.push([level, message])
});
const spotify = discovery.findById("spotify.desktop");
assert.strictEqual(spotify.name, "User Spotify", "user desktop entries must take precedence");
assert.strictEqual(spotify.executable, "user-spotify");
assert.deepStrictEqual(spotify.args, []);
assert.strictEqual(discovery.findById("../../spotify.desktop"), null, "desktop IDs may not escape search directories");

const scan = discovery.scan();
assert.strictEqual(scan.entries.filter(entry => entry.desktopId === "spotify.desktop").length, 1);
assert.strictEqual(scan.entries.find(entry => entry.desktopId === "hidden.desktop").hidden, true);
assert.strictEqual(scan.entries.find(entry => entry.desktopId === "hidden.desktop").terminal, true);
assert.strictEqual(scan.errors.length, 1);
assert(logs.some(([, message]) => message === "DESKTOP ENTRY INVALID: broken.desktop"));

fs.rmSync(temporaryRoot, {recursive: true, force: true});
console.log("Desktop-entry discovery and safe Exec parsing passed");
