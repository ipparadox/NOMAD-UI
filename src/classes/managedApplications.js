const APPLICATION_TYPES = Object.freeze({
    INTERNAL: "internal",
    EXTERNAL: "external"
});

const APPLICATION_STATES = Object.freeze({
    AVAILABLE: "AVAILABLE",
    UNAVAILABLE: "UNAVAILABLE",
    LAUNCHING: "LAUNCHING",
    RUNNING: "RUNNING",
    ACTIVE: "ACTIVE",
    HIDDEN: "HIDDEN",
    CLOSED: "CLOSED"
});

// Built-ins use the same normalized representation as user applications. The
// trusted main-process registry resolves availability and sends only the
// public projection to the renderer.
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
        windowMatchers: Object.freeze([
            Object.freeze({instance: "code", className: "code"})
        ])
    }),
    Object.freeze({
        id: "browser",
        displayName: "BROWSER",
        type: APPLICATION_TYPES.EXTERNAL,
        launcherOrder: 1,
        executable: "firefox",
        args: Object.freeze([]),
        windowMatchers: Object.freeze([
            Object.freeze({instance: "Navigator", className: "firefox_firefox"})
        ])
    })
]);

const PROTECTED_APPLICATION_IDS = Object.freeze(MANAGED_APPLICATIONS.map(application => application.id));
const LOCKDOWN_BUILTIN_APPLICATION_IDS = Object.freeze(MANAGED_APPLICATIONS
    .filter(application => application.type === APPLICATION_TYPES.INTERNAL)
    .map(application => application.id));

function normalizeApplicationId(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : null;
}

function publicApplication(application) {
    return {
        id: application.id,
        displayName: application.displayName,
        type: application.type,
        permanent: application.permanent === true,
        placeholder: application.placeholder === true,
        launcherOrder: application.launcherOrder,
        available: application.available !== false,
        status: application.status || ""
    };
}

function publicApplications(applications = MANAGED_APPLICATIONS) {
    return applications.map(publicApplication);
}

function applicationMap(applications = MANAGED_APPLICATIONS) {
    return applications.reduce((result, application) => {
        result[application.id] = application;
        return result;
    }, Object.create(null));
}

if (typeof module !== "undefined" && typeof window === "undefined") {
    module.exports = {
        APPLICATION_TYPES,
        APPLICATION_STATES,
        LOCKDOWN_BUILTIN_APPLICATION_IDS,
        MANAGED_APPLICATIONS,
        PROTECTED_APPLICATION_IDS,
        normalizeApplicationId,
        publicApplication,
        publicApplications,
        applicationMap
    };
}
