const APPLICATION_TYPES = Object.freeze({
    INTERNAL: "internal",
    EXTERNAL: "external"
});

const APPLICATION_STATES = Object.freeze({
    AVAILABLE: "AVAILABLE",
    LAUNCHING: "LAUNCHING",
    RUNNING: "RUNNING",
    ACTIVE: "ACTIVE",
    HIDDEN: "HIDDEN",
    CLOSED: "CLOSED"
});

// This is the built-in registry. launcherOrder controls its text-list order;
// a later V0.4 phase can merge validated user definitions into it without
// changing WorkspaceManager or the workspace UI.
const MANAGED_APPLICATIONS = Object.freeze([
    Object.freeze({
        id: "terminal",
        displayName: "TERMINAL",
        type: APPLICATION_TYPES.INTERNAL,
        permanent: true,
        launcherOrder: 3
    }),
    Object.freeze({
        id: "notes",
        displayName: "NOTES",
        type: APPLICATION_TYPES.INTERNAL,
        placeholder: true,
        launcherOrder: 2
    }),
    Object.freeze({
        id: "code",
        displayName: "CODE",
        type: APPLICATION_TYPES.EXTERNAL,
        launcherOrder: 0,
        executable: "code",
        args: Object.freeze([]),
        windowMatch: Object.freeze({instance: "code", className: "code"})
    }),
    Object.freeze({
        id: "browser",
        displayName: "BROWSER",
        type: APPLICATION_TYPES.EXTERNAL,
        launcherOrder: 1,
        executable: "firefox",
        args: Object.freeze([]),
        windowMatch: Object.freeze({instance: "Navigator", className: "firefox_firefox"})
    })
]);

function applicationMap(applications = MANAGED_APPLICATIONS) {
    return applications.reduce((result, application) => {
        result[application.id] = application;
        return result;
    }, {});
}

if (typeof module !== "undefined" && typeof window === "undefined") {
    module.exports = {APPLICATION_TYPES, APPLICATION_STATES, MANAGED_APPLICATIONS, applicationMap};
}
