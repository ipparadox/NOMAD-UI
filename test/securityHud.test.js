const assert = require("assert");
const {SecurityHud} = require("../src/classes/securityHud.class.js");

async function run() {
    const modals = [];
    let opened = 0;
    let closed = 0;
    class FakeModal {
        constructor(options, onclose) {
            modals.push({options, onclose});
        }
    }
    const hud = new SecurityHud({
        Modal: FakeModal,
        onOpen: () => { opened++; },
        onClose: () => { closed++; },
        loadStatus: async () => ({
            ok: true,
            status: {
                profile: {
                    id: "PUBLIC",
                    compliance: "NON_COMPLIANT",
                    enforced: "PUBLIC",
                    enforcementState: "PARTIAL",
                    systemEnforcementPending: true,
                    sessionRestartRequired: true
                },
                checks: [{
                    label: "HOST STORAGE",
                    state: "INSECURE",
                    actual: "ACCESSIBLE",
                    detail: "<script>window.compromised=true</script>"
                }],
                internalPath: "/home/user/private"
            }
        })
    });
    assert.strictEqual(await hud.open(), true);
    assert.strictEqual(opened, 1);
    assert.strictEqual(modals.length, 1);
    assert.strictEqual(modals[0].options.title, "NOMAD // SECURITY STATUS");
    assert(modals[0].options.html.includes("PROFILE PUBLIC"));
    assert(modals[0].options.html.includes("NON_COMPLIANT"));
    assert(modals[0].options.html.includes("SYSTEM ENFORCEMENT PENDING"));
    assert(modals[0].options.html.includes("SESSION RESTART REQUIRED"));
    assert(modals[0].options.html.includes("ENFORCED PUBLIC // PARTIAL"));
    assert(modals[0].options.html.includes("&lt;script&gt;"));
    assert(!modals[0].options.html.includes("<script>"));
    assert(!modals[0].options.html.includes("/home/user/private"));
    modals[0].onclose();
    assert.strictEqual(closed, 1);

    const unavailable = new SecurityHud({
        Modal: FakeModal,
        loadStatus: async () => ({ok: false, status: "UNAVAILABLE"})
    });
    assert.strictEqual(await unavailable.open(), false);
    assert.strictEqual(modals[1].options.type, "warning");

    console.log("Security HUD preserves the technical overlay style and escapes all projected status text passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
