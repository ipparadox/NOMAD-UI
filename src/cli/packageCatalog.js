const {CliError} = require("./errors.js");
const {validateApplicationLookup} = require("./applicationService.js");

const PACKAGE_CATALOG = Object.freeze([
    Object.freeze({
        id: "vlc",
        displayName: "VLC",
        aliases: Object.freeze(["org.videolan.vlc"]),
        desktopIds: Object.freeze(["vlc.desktop", "org.videolan.VLC.desktop"]),
        sources: Object.freeze([
            Object.freeze({source: "APT", package: "vlc"}),
            Object.freeze({source: "SNAP", package: "vlc"}),
            Object.freeze({source: "FLATPAK", package: "org.videolan.VLC"})
        ])
    }),
    Object.freeze({
        id: "spotify",
        displayName: "SPOTIFY",
        aliases: Object.freeze(["com.spotify.client"]),
        desktopIds: Object.freeze(["spotify.desktop", "com.spotify.Client.desktop"]),
        sources: Object.freeze([
            Object.freeze({source: "SNAP", package: "spotify"}),
            Object.freeze({source: "FLATPAK", package: "com.spotify.Client"})
        ])
    }),
    Object.freeze({
        id: "gnome-calculator",
        displayName: "CALCULATOR",
        aliases: Object.freeze(["calculator", "org.gnome.calculator"]),
        desktopIds: Object.freeze(["org.gnome.Calculator.desktop", "gnome-calculator.desktop"]),
        sources: Object.freeze([
            Object.freeze({source: "APT", package: "gnome-calculator"}),
            Object.freeze({source: "FLATPAK", package: "org.gnome.Calculator"})
        ])
    })
]);

function resolvePackageDefinition(identifier) {
    const validated = validateApplicationLookup(identifier);
    const wanted = validated.toLowerCase();
    const definition = PACKAGE_CATALOG.find(application => application.id === wanted
        || application.aliases.some(alias => alias.toLowerCase() === wanted));
    if (!definition) {
        throw new CliError(`NO TRUSTED PACKAGE METADATA: ${validated}\nNOMAD WILL NOT INTERPRET PACKAGE COMMANDS OR ADD REPOSITORIES`);
    }
    return definition;
}

module.exports = {PACKAGE_CATALOG, resolvePackageDefinition};
