"use strict";
// Injected by the development GUI harness only. Never loaded by production HTML.
(() => {
    const overlay = document.createElement("div");
    overlay.id = "nomad_dev_visual_audit";
    Object.assign(overlay.style, {position: "fixed", inset: "0", zIndex: "200000", pointerEvents: "none",
        backgroundImage: "linear-gradient(#83cbe318 1px, transparent 1px),linear-gradient(90deg,#83cbe318 1px,transparent 1px)", backgroundSize: "8px 8px"});
    for (const selector of ["#mod_column_left", "#mod_column_right", "#main_shell", "#repository", "#keyboard", "#nomad_security_strip"]) {
        const target = document.querySelector(selector);
        if (!target) continue;
        const r = target.getBoundingClientRect();
        const box = document.createElement("div");
        Object.assign(box.style, {position: "absolute", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, outline: "1px solid #efad65", color: "#efad65", font: "10px monospace"});
        box.textContent = `${selector} ${Math.round(r.width)} × ${Math.round(r.height)} @ ${r.x.toFixed(1)},${r.y.toFixed(1)}`;
        overlay.append(box);
    }
    document.getElementById(overlay.id)?.remove();
    document.body.append(overlay);
})();
