const PRODUCTION_ENVIRONMENT_KEYS = new Set([
    "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TZ",
    "TERM_PROGRAM", "TERM_PROGRAM_VERSION",
    "DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "I3SOCK", "DESKTOP_SESSION",
    "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP",
    "XDG_DATA_DIRS", "XDG_CONFIG_DIRS", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "XDG_DATA_HOME", "SYSTEMROOT", "SystemRoot", "WINDIR", "PATHEXT",
    "NOMAD_PRODUCTION", "NOMAD_SESSION_PROFILE", "NOMAD_EPHEMERAL_ACTIVE", "NOMAD_RUNTIME_ROOT",
    "NOMAD_RUNTIME_STATE_DIR", "NOMAD_LOG_ROOT", "NOMAD_ROOT", "NOMAD_REPOSITORY_ROOT"
]);

const RUNTIME_INJECTION_KEYS = new Set([
    "BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "NODE_DEBUG", "ELECTRON_RUN_AS_NODE",
    "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "RUBYOPT",
    "PERL5OPT", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND",
    "NPM_CONFIG_USERCONFIG"
]);
const PRODUCTION_INTERNAL_OVERRIDE_KEYS = new Set(["HISTFILE", "TMPDIR"]);

function validEnvironmentValue(value) {
    return typeof value === "string" && value.length <= 32768 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isProductionEnvironmentKey(key) {
    return typeof key === "string" && (PRODUCTION_ENVIRONMENT_KEYS.has(key) || /^LC_[A-Z0-9_]+$/.test(key));
}

function isRuntimeInjectionEnvironmentKey(key) {
    if (typeof key !== "string") return false;
    const upper = key.toUpperCase();
    return RUNTIME_INJECTION_KEYS.has(upper) || /^(LD_|DYLD_)/.test(upper)
        || /^(BUNDLE|NPM|YARN|PIP|NVM|CARGO|GIT_CONFIG|GCM)_/.test(upper);
}

function isCredentialEnvironmentKey(key) {
    if (typeof key !== "string") return false;
    const upper = key.toUpperCase();
    if ([
        "SSH_AUTH_SOCK", "GITHUB_TOKEN", "GH_TOKEN", "OPENAI_API_KEY", "DATABASE_URL",
        "KUBECONFIG", "DOCKER_AUTH_CONFIG"
    ].includes(upper)) return true;
    return /^(AWS|AZURE|GOOGLE|GCP|VAULT|SSH)_/.test(upper)
        || /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|ACCESS_KEY)(_|$)/.test(upper)
        || /_KEY$/.test(upper);
}

function isSensitiveEnvironmentKey(key) {
    return isCredentialEnvironmentKey(key) || isRuntimeInjectionEnvironmentKey(key);
}

function buildProductionEnvironment(source = process.env, overrides = {}) {
    const environment = {};
    Object.keys(source || {}).forEach(key => {
        if (!isProductionEnvironmentKey(key) || !validEnvironmentValue(source[key])) return;
        environment[key] = source[key];
    });
    Object.keys(overrides || {}).forEach(key => {
        if ((!isProductionEnvironmentKey(key) && !PRODUCTION_INTERNAL_OVERRIDE_KEYS.has(key))
            || !validEnvironmentValue(overrides[key])) return;
        environment[key] = overrides[key];
    });
    return environment;
}

function sanitizeEnvironmentInPlace(environment = process.env, overrides = {}) {
    const sanitized = buildProductionEnvironment(environment, overrides);
    Object.keys(environment || {}).forEach(key => {
        if (!Object.prototype.hasOwnProperty.call(sanitized, key)) delete environment[key];
    });
    Object.keys(sanitized).forEach(key => {
        environment[key] = sanitized[key];
    });
    return inventoryEnvironment(environment);
}

function inventoryEnvironment(environment = process.env) {
    const keys = Object.keys(environment || {});
    return {
        totalCount: keys.length,
        allowedCount: keys.filter(isProductionEnvironmentKey).length,
        excludedCount: keys.filter(key => !isProductionEnvironmentKey(key)).length,
        sensitiveCount: keys.filter(isSensitiveEnvironmentKey).length,
        credentialCount: keys.filter(isCredentialEnvironmentKey).length,
        runtimeInjectionCount: keys.filter(isRuntimeInjectionEnvironmentKey).length
    };
}

class SecuritySecretsService {
    constructor(opts = {}) {
        this.environment = opts.env || process.env;
        this.userFilesAccessible = typeof opts.userFilesAccessible === "boolean"
            ? opts.userFilesAccessible : true;
    }

    observe() {
        const inventory = inventoryEnvironment(this.environment);
        if (inventory.sensitiveCount > 0) return {
            state: "INSECURE",
            actual: "ENVIRONMENT_EXPOSED",
            detail: `${inventory.sensitiveCount} SENSITIVE OR RUNTIME-INJECTION VARIABLE NAME(S) PRESENT`,
            inventory,
            environmentClosed: false,
            otherUserCredentialsAccessible: this.userFilesAccessible
        };
        if (this.userFilesAccessible) return {
            state: "PARTIAL",
            actual: "ENVIRONMENT_CLOSED_FILES_ACCESSIBLE",
            detail: "SESSION ENVIRONMENT IS MINIMIZED; OTHER USER-OWNED CREDENTIAL FILES ARE NOT ISOLATED",
            inventory,
            environmentClosed: true,
            otherUserCredentialsAccessible: true
        };
        return {
            state: "SECURE",
            actual: "CLOSED",
            detail: "NO SENSITIVE ENVIRONMENT NAMES OR OTHER CREDENTIAL SURFACE WAS DETECTED",
            inventory,
            environmentClosed: true,
            otherUserCredentialsAccessible: false
        };
    }
}

module.exports = {
    PRODUCTION_ENVIRONMENT_KEYS,
    PRODUCTION_INTERNAL_OVERRIDE_KEYS,
    RUNTIME_INJECTION_KEYS,
    SecuritySecretsService,
    buildProductionEnvironment,
    inventoryEnvironment,
    isCredentialEnvironmentKey,
    isProductionEnvironmentKey,
    isRuntimeInjectionEnvironmentKey,
    isSensitiveEnvironmentKey,
    sanitizeEnvironmentInPlace,
    validEnvironmentValue
};
