"use strict";

// Read-only observations through the existing frozen bridge. A timeout is UNKNOWN,
// never success; this check grants no execution or recovery authority.
async function nomadSystemHealth(host = window) {
    const bridge = host.nomad;
    const probe = async read => {
        let timer;
        try {
            return await Promise.race([Promise.resolve().then(read), new Promise(resolve => {
                timer = setTimeout(() => resolve(null), 3000);
            })]);
        } catch (_) { return null; }
        finally { clearTimeout(timer); }
    };
    const [control, system, network, windows, applications] = await Promise.all([
        probe(() => bridge.control.request("SYSTEM_STATUS")),
        probe(() => bridge.system.getTelemetry()), probe(() => bridge.network.getTelemetry()),
        probe(() => bridge.windowManager.snapshot()), probe(() => bridge.applications.request("get"))
    ]);
    const fields = [];
    const add = (label, value) => fields.push({label, value});
    const telemetry = value => !value ? "UNKNOWN" : value.ok !== true ? "FAILED"
        : !Number.isFinite(value.timestamp) || Date.now() - value.timestamp > 10000 ? "DEGRADED"
        : ["PARTIAL", "OFFLINE"].includes(value.status) ? "DEGRADED" : "OK";
    const terminal = host.term && host.term[host.currentTerm];
    const globe = host.nomadTelemetry && host.nomadTelemetry.network && host.nomadTelemetry.network.globe;
    add("SECURE RENDERER", host.document.body.dataset.nomadBridge === "VERIFIED"
        && typeof host.require === "undefined" && Object.isFrozen(bridge) ? "OK" : "UNKNOWN");
    add("CONTROL PLANE", !control ? "UNKNOWN" : control.ok === true ? "OK" : "FAILED");
    add("TERMINAL", terminal && terminal.socket ? terminal.socket.readyState === 1 ? "OK" : "FAILED" : "UNKNOWN");
    add("TELEMETRY", telemetry(system));
    add("NETWORK", telemetry(network));
    add("GLOBE", !globe ? "UNKNOWN" : globe.disposed || !globe.initialized ? "FAILED"
        : globe.visible === false ? "PAUSED" : Date.now() - (globe.lastPaintAt || 0) < 3000 ? "OK" : "DEGRADED");
    add("REPOSITORIES", control && control.repositoriesHealth || "UNKNOWN");
    add("APPLICATION REGISTRY", applications && applications.ok && Array.isArray(applications.applications) ? "OK" : "UNKNOWN");
    add("WINDOW SYNC", Array.isArray(windows) && control ? control.windowSyncHealth || "UNKNOWN" : "UNKNOWN");
    add("SECURITY PROFILE", control && control.profile || "UNKNOWN");
    add("AUTOMATION ENGINE", control && control.automationHealth || "UNKNOWN");
    add("LAUNCH DOCTOR", control && control.launchDoctorHealth || "UNKNOWN");
    return fields;
}
if (typeof module !== "undefined" && typeof window === "undefined") module["exports"] = {nomadSystemHealth};
