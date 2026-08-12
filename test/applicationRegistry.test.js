const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {ApplicationRegistry, handleApplicationRegistryRequest} = require("../src/classes/applicationRegistry.js");
const {DesktopEntryDiscovery} = require("../src/classes/desktopEntryDiscovery.js");
const {WorkspaceManager} = require("../src/classes/workspaceManager.class.js");
const {ApplicationLauncher} = require("../src/classes/applicationLauncher.class.js");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-application-registry-"));
const registryPath = path.join(temporaryRoot, "apps.json");
const applicationsDirectory = path.join(temporaryRoot, "applications");
fs.mkdirSync(applicationsDirectory);

const installedExecutables = new Set(["code", "firefox", "spotify", "obsidian", "nomatcher"]);
const logs = [];
const discovery = new DesktopEntryDiscovery({directories: [applicationsDirectory]});
const registry = new ApplicationRegistry({
    registryPath,
    discovery,
    executableExists: executable => installedExecutables.has(executable),
    log: (level, message) => logs.push([level, message])
});

// A missing optional registry is silent and leaves all protected built-ins in
// their original normalized representation.
assert.doesNotThrow(() => registry.reload());
assert.deepStrictEqual(registry.getApplications().map(application => application.id), ["terminal", "notes", "code", "browser"]);
assert.strictEqual(logs.length, 0);
assert.deepStrictEqual(registry.get("terminal"), {
    id: "terminal",
    displayName: "TERMINAL",
    type: "internal",
    permanent: true,
    placeholder: false,
    launcherOrder: 3,
    available: true,
    status: "",
    args: [],
    windowMatchers: []
});

fs.writeFileSync(path.join(applicationsDirectory, "spotify.desktop"), `[Desktop Entry]
Type=Application
Name=Spotify
Exec=spotify %U --uri=%u
StartupWMClass=Spotify
NoDisplay=false
Hidden=false
Terminal=false
`);

fs.writeFileSync(registryPath, JSON.stringify({
    version: 1,
    applications: [
        {
            id: "spotify",
            displayName: "Spotify",
            type: "external",
            desktopId: "spotify.desktop"
        },
        {
            id: "obsidian",
            displayName: "Obsidian",
            type: "external",
            executable: "obsidian",
            args: ["--safe", "semi;colon-is-literal"],
            wmClass: ["obsidian"]
        },
        {
            id: "ghost",
            displayName: "GHOST",
            type: "external",
            executable: "not-installed",
            args: [],
            wmClass: ["Ghost"]
        },
        {
            id: "nomatcher",
            displayName: "NO MATCHER",
            type: "external",
            executable: "nomatcher",
            args: []
        },
        {
            id: "bad;id",
            displayName: "BAD",
            executable: "bad"
        },
        {
            id: "bad-args",
            displayName: "BAD ARGS",
            executable: "bad-args",
            args: "--unsafe",
            wmClass: ["BadArgs"]
        },
        {
            id: "SPOTIFY",
            displayName: "DUPLICATE",
            executable: "spotify",
            wmClass: ["Duplicate"]
        },
        {
            id: "terminal",
            displayName: "OVERRIDE",
            executable: "spotify",
            wmClass: ["Override"]
        },
        {
            id: "CODE",
            displayName: "OVERRIDE CODE",
            executable: "spotify",
            wmClass: ["OverrideCode"]
        },
        {
            id: "shell-app",
            displayName: "SHELL",
            executable: "sh",
            args: ["-c", "anything"],
            wmClass: ["Shell"]
        }
    ]
}, null, 2));

assert.doesNotThrow(() => registry.reload(), "one malformed entry must never crash the registry");
const ids = registry.getApplications().map(application => application.id);
assert.deepStrictEqual(ids, ["terminal", "notes", "code", "browser", "spotify", "obsidian", "ghost", "nomatcher"]);

const spotify = registry.get("spotify");
assert.strictEqual(spotify.displayName, "SPOTIFY");
assert.strictEqual(spotify.executable, "spotify");
assert.deepStrictEqual(spotify.args, []);
assert.deepStrictEqual(spotify.windowMatchers, [
    {className: "Spotify"},
    {instance: "Spotify"}
]);
assert.strictEqual(spotify.available, true);
assert.strictEqual(spotify.desktopEntry.noDisplay, false);
assert.strictEqual(spotify.desktopEntry.terminal, false);

const ghost = registry.get("ghost");
assert.strictEqual(ghost.available, false);
assert.strictEqual(ghost.status, "APPLICATION EXECUTABLE NOT FOUND");
const noMatcher = registry.get("nomatcher");
assert.strictEqual(noMatcher.available, false);
assert.strictEqual(noMatcher.status, "WM_CLASS NOT AVAILABLE");

const code = registry.get("code");
const browser = registry.get("browser");
assert.deepStrictEqual(code.windowMatchers, [{instance: "code", className: "code"}]);
assert.deepStrictEqual(browser.windowMatchers, [{instance: "Navigator", className: "firefox_firefox"}]);
assert.strictEqual(code.executable, "code");
assert.strictEqual(browser.executable, "firefox");
assert.strictEqual(registry.get("terminal").displayName, "TERMINAL");
assert.strictEqual(registry.get("notes").placeholder, true);

assert(logs.some(([, message]) => message.startsWith("REGISTRY ENTRY INVALID:")));
assert(logs.some(([, message]) => message === "APPLICATION EXECUTABLE NOT FOUND: ghost"));
assert(logs.some(([, message]) => message === "WM_CLASS NOT AVAILABLE: nomatcher"));

// The renderer-facing projection deliberately has no executable, arguments,
// desktop path, or WM_CLASS metadata.
const publicSpotify = registry.getPublicApplications().find(application => application.id === "spotify");
assert.deepStrictEqual(Object.keys(publicSpotify).sort(), [
    "available", "displayName", "id", "launcherOrder", "permanent", "placeholder", "status", "type"
]);
assert.strictEqual(Object.prototype.hasOwnProperty.call(publicSpotify, "executable"), false);

const applied = [];
const windowManager = {setApplications: applications => applied.push(applications)};
const generationBeforeReload = registry.generation;
const reloaded = handleApplicationRegistryRequest(registry, windowManager, {operation: "reload"});
assert.strictEqual(reloaded.ok, true);
assert.strictEqual(reloaded.generation, generationBeforeReload + 1);
assert.strictEqual(applied.length, 1);
assert(reloaded.applications.some(application => application.id === "spotify"));
assert.strictEqual(Object.prototype.hasOwnProperty.call(reloaded.applications.find(application => application.id === "spotify"), "args"), false);

const reloadWorkspace = new WorkspaceManager({
    applications: reloaded.applications.filter(application => application.id !== "spotify"),
    initialApplicationIds: ["terminal"]
});
const reloadLauncher = new ApplicationLauncher({manager: reloadWorkspace});
assert.strictEqual(reloadLauncher.entries.some(application => application.id === "spotify"), false);
reloadWorkspace.setApplications(reloaded.applications);
assert.strictEqual(reloadLauncher.entries.some(application => application.id === "spotify"), true);
reloadLauncher.destroy();

const rejected = handleApplicationRegistryRequest(registry, windowManager, {
    operation: "reload",
    executable: "/bin/anything"
});
assert.deepStrictEqual(rejected, {ok: false, status: "INVALID REQUEST", applications: []});
assert.strictEqual(applied.length, 1);

fs.writeFileSync(registryPath, "{ definitely not json");
assert.doesNotThrow(() => registry.reload());
assert.deepStrictEqual(registry.getApplications().map(application => application.id), ["terminal", "notes", "code", "browser"]);

fs.rmSync(temporaryRoot, {recursive: true, force: true});
console.log("Application registry validation, availability, protection, and reload passed");
