"use strict";
const assert = require("assert");
const {ManagedApplicationGeometryService, workspaceGeometry, WORKSPACE_GEOMETRY_PROBE} = require("../src/classes/managedApplicationGeometryService.js");
const bounds = {x: 100, y: 50, width: 1600, height: 900};
const measured = {x: 280, y: 62.25, width: 1040, height: 491.5, viewportWidth: 1600, viewportHeight: 900};
assert.deepStrictEqual(workspaceGeometry(bounds, measured), {x: 380, y: 112, width: 1040, height: 492});
assert.deepStrictEqual(workspaceGeometry({...bounds, width: 800, height: 450}, measured), {x: 240, y: 81, width: 520, height: 246});
for (const bad of [null, {...measured, x: -10}, {...measured, width: 9999}, {...measured, height: NaN},
    {...measured, viewportWidth: 0}, {...measured, y: 10000}]) assert.strictEqual(workspaceGeometry(bounds, bad), null);
async function run() {
    const service = new ManagedApplicationGeometryService();
    let resolve; let calls = 0;
    const win = {isDestroyed: () => false, getContentBounds: () => bounds,
        webContents: {executeJavaScript: script => {
            assert.strictEqual(script, WORKSPACE_GEOMETRY_PROBE);
            calls++;
            return new Promise(done => { resolve = done; });
        }}};
    const a = service.get(win); const b = service.get(win);
    assert.strictEqual(a, b, "overlapping requests share a fixed probe");
    await Promise.resolve(); resolve(measured);
    assert.deepStrictEqual(await a, workspaceGeometry(bounds, measured));
    assert.strictEqual(calls, 1);
    assert.strictEqual(await service.get({isDestroyed: () => true}), null);
    win.webContents.executeJavaScript = async () => { throw new Error("unavailable"); };
    assert.strictEqual(await service.get(win), null);
    console.log("Main-side workspace measurement, bounded coordinates, scaling, coalescing and fail-closed geometry passed");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
