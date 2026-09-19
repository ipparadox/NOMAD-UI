"use strict";

// This fixed probe is owned by main. The renderer cannot supply script or
// coordinates through the bridge. Results are bounded to NOMAD's content area.
const WORKSPACE_GEOMETRY_PROBE = `(() => {
    const element = document.getElementById('workspace_viewport');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        viewportWidth: document.documentElement.clientWidth,
        viewportHeight: document.documentElement.clientHeight};
})()`;

function workspaceGeometry(bounds, measurement) {
    if (!bounds || !measurement || ![bounds.x, bounds.y, bounds.width, bounds.height,
        measurement.x, measurement.y, measurement.width, measurement.height,
        measurement.viewportWidth, measurement.viewportHeight].every(Number.isFinite)) return null;
    if (bounds.width <= 0 || bounds.height <= 0 || measurement.width <= 0 || measurement.height <= 0
        || measurement.viewportWidth <= 0 || measurement.viewportHeight <= 0
        || measurement.x < 0 || measurement.y < 0
        || measurement.x + measurement.width > measurement.viewportWidth + 1
        || measurement.y + measurement.height > measurement.viewportHeight + 1) return null;
    const scaleX = bounds.width / measurement.viewportWidth;
    const scaleY = bounds.height / measurement.viewportHeight;
    const left = Math.max(0, Math.round(measurement.x * scaleX));
    const top = Math.max(0, Math.round(measurement.y * scaleY));
    const right = Math.min(bounds.width, Math.round((measurement.x + measurement.width) * scaleX));
    const bottom = Math.min(bounds.height, Math.round((measurement.y + measurement.height) * scaleY));
    if (right <= left || bottom <= top) return null;
    return {x: bounds.x + left, y: bounds.y + top, width: right - left, height: bottom - top};
}

class ManagedApplicationGeometryService {
    constructor() { this.pending = new WeakMap(); }

    get(win) {
        if (!win || win.isDestroyed()) return Promise.resolve(null);
        if (this.pending.has(win)) return this.pending.get(win);
        let timer;
        const read = Promise.resolve().then(() => win.webContents.executeJavaScript(WORKSPACE_GEOMETRY_PROBE))
            .then(value => win.isDestroyed() ? null : workspaceGeometry(win.getContentBounds(), value))
            .catch(() => null);
        const result = Promise.race([read, new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); })]);
        this.pending.set(win, result);
        // Keep the original read tracked even after timeout; do not pile up
        // queries against an unresponsive renderer.
        read.finally(() => { clearTimeout(timer); this.pending.delete(win); });
        return result;
    }
}

module.exports = {ManagedApplicationGeometryService, workspaceGeometry, WORKSPACE_GEOMETRY_PROBE};
