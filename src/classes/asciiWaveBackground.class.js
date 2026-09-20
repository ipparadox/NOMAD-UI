"use strict";

// Authoritative supplied ASCII Waves implementation. Only lifecycle ownership and
// named listener cleanup have been added; field math and rendering are unchanged.
class AsciiWaveBackground {
    constructor(canvas) {
        const CONFIG = {
            ramp: ' nomad-UI', cellW: 14, cellH: 16, fontSize: 13,
            fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, "Courier New", monospace',
            scale: 0.055, speed: 0.18, warp: 1.35, contrast: 1.25,
            minBright: 0.18, maxBright: 1.0, fps: 30, mouse: 0.35
        };
        const grad3 = [
            [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
            [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
            [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]
        ];
        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) p[i] = i;
        let seed = 1337;
        const rnd = () => {
            seed = (seed * 16807) % 2147483647;
            return (seed - 1) / 2147483646;
        };
        for (let i = 255; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            const t = p[i]; p[i] = p[j]; p[j] = t;
        }
        const perm = new Uint8Array(512);
        const perm12 = new Uint8Array(512);
        for (let i = 0; i < 512; i++) {
            perm[i] = p[i & 255]; perm12[i] = perm[i] % 12;
        }
        const F3 = 1 / 3;
        const G3 = 1 / 6;
        function noise3(x, y, z) {
            const s = (x + y + z) * F3;
            const i = Math.floor(x + s);
            const j = Math.floor(y + s);
            const k = Math.floor(z + s);
            const t = (i + j + k) * G3;
            const x0 = x - (i - t);
            const y0 = y - (j - t);
            const z0 = z - (k - t);
            let i1, j1, k1, i2, j2, k2;
            if (x0 >= y0) {
                if (y0 >= z0) { i1=1; j1=0; k1=0; i2=1; j2=1; k2=0; }
                else if (x0 >= z0) { i1=1; j1=0; k1=0; i2=1; j2=0; k2=1; }
                else { i1=0; j1=0; k1=1; i2=1; j2=0; k2=1; }
            } else {
                if (y0 < z0) { i1=0; j1=0; k1=1; i2=0; j2=1; k2=1; }
                else if (x0 < z0) { i1=0; j1=1; k1=0; i2=0; j2=1; k2=1; }
                else { i1=0; j1=1; k1=0; i2=1; j2=1; k2=0; }
            }
            const x1 = x0 - i1 + G3;
            const y1 = y0 - j1 + G3;
            const z1 = z0 - k1 + G3;
            const x2 = x0 - i2 + 2 * G3;
            const y2 = y0 - j2 + 2 * G3;
            const z2 = z0 - k2 + 2 * G3;
            const x3 = x0 - 1 + 3 * G3;
            const y3 = y0 - 1 + 3 * G3;
            const z3 = z0 - 1 + 3 * G3;
            const ii = i & 255;
            const jj = j & 255;
            const kk = k & 255;
            let n = 0;
            let t0;
            let g;
            t0 = 0.6 - x0*x0 - y0*y0 - z0*z0;
            if (t0 > 0) {
                g = grad3[perm12[ii + perm[jj + perm[kk]]]];
                t0 *= t0;
                n += t0*t0*(g[0]*x0 + g[1]*y0 + g[2]*z0);
            }
            t0 = 0.6 - x1*x1 - y1*y1 - z1*z1;
            if (t0 > 0) {
                g = grad3[perm12[ii+i1 + perm[jj+j1 + perm[kk+k1]]]];
                t0 *= t0;
                n += t0*t0*(g[0]*x1 + g[1]*y1 + g[2]*z1);
            }
            t0 = 0.6 - x2*x2 - y2*y2 - z2*z2;
            if (t0 > 0) {
                g = grad3[perm12[ii+i2 + perm[jj+j2 + perm[kk+k2]]]];
                t0 *= t0;
                n += t0*t0*(g[0]*x2 + g[1]*y2 + g[2]*z2);
            }
            t0 = 0.6 - x3*x3 - y3*y3 - z3*z3;
            if (t0 > 0) {
                g = grad3[perm12[ii+1 + perm[jj+1 + perm[kk+1]]]];
                t0 *= t0;
                n += t0*t0*(g[0]*x3 + g[1]*y3 + g[2]*z3);
            }
            return 32 * n;
        }
        let ctx = canvas.getContext('2d', {alpha: false});
        let cols = 0;
        let rows = 0;
        let dpr = 1;
        const LEVELS = 24;
        const palette = [];
        for (let i = 0; i < LEVELS; i++) {
            const b = CONFIG.minBright + (CONFIG.maxBright - CONFIG.minBright) * (i / (LEVELS - 1));
            const v = Math.round(b * 255);
            palette.push(`rgb(${v},${v},${v})`);
        }
        this.resize = () => {
            if (!canvas || !ctx) return;
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            const w = window.innerWidth;
            const h = window.innerHeight;
            canvas.width = Math.floor(w * dpr);
            canvas.height = Math.floor(h * dpr);
            canvas.style.width = w + 'px';
            canvas.style.height = h + 'px';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            cols = Math.ceil(w / CONFIG.cellW) + 1;
            rows = Math.ceil(h / CONFIG.cellH) + 1;
            ctx.font = `${CONFIG.fontSize}px ${CONFIG.fontFamily}`;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
        };
        const mouse = {x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, active: 0};
        this.pointermove = e => {
            mouse.tx = e.clientX / window.innerWidth;
            mouse.ty = e.clientY / window.innerHeight;
            mouse.active = 1;
        };
        this.pointerleave = () => { mouse.active = 0; };
        const ramp = CONFIG.ramp;
        const rampLen = ramp.length;
        const aspect = CONFIG.cellH / CONFIG.cellW;
        function field(cx, cy, t) {
            const nx = cx * CONFIG.scale;
            const ny = cy * CONFIG.scale * aspect;
            const wx = noise3(nx * 0.55, ny * 0.55, t * 0.45);
            const wy = noise3(nx * 0.55 + 7.3, ny * 0.55 + 2.9, t * 0.45 + 11.1);
            let v = noise3(nx + wx * CONFIG.warp + t * 0.35, ny + wy * CONFIG.warp, t * 0.6);
            v += 0.45 * noise3(nx * 2.2 - t * 0.2, ny * 2.2, t * 0.9 + 5.5);
            v += 0.35 * Math.sin(nx * 0.9 + ny * 0.4 - t * 1.3 + wx * 1.5);
            if (CONFIG.mouse > 0 && mouse.active) {
                const dx = cx / cols - mouse.x;
                const dy = cy / rows - mouse.y;
                const d = Math.sqrt(dx * dx + dy * dy);
                v += CONFIG.mouse * Math.exp(-d * d * 18) * Math.sin(d * 28 - t * 4);
            }
            v = v / 1.8;
            v = Math.tanh(v * CONFIG.contrast);
            return (v + 1) * 0.5;
        }
        const frameInterval = 1000 / CONFIG.fps;
        let last = 0;
        const start = performance.now();
        this.frames = 0;
        this.running = false;
        this.render = now => {
            if (!this.running) return;
            this.frame = requestAnimationFrame(this.render);
            if (now - last < frameInterval) return;
            last = now;
            const t = (now - start) * 0.001 * CONFIG.speed;
            mouse.x += (mouse.tx - mouse.x) * 0.08;
            mouse.y += (mouse.ty - mouse.y) * 0.08;
            ctx.fillStyle = '#050505';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const buckets = new Array(LEVELS);
            for (let i = 0; i < LEVELS; i++) buckets[i] = [];
            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < cols; x++) {
                    const v = field(x, y, t);
                    const ci = Math.min(rampLen - 1, Math.floor(v * rampLen));
                    const ch = ramp[ci];
                    if (ch === ' ') continue;
                    const li = Math.min(LEVELS - 1, Math.floor(Math.pow(v, 1.4) * LEVELS));
                    buckets[li].push(ch, x, y);
                }
            }
            const halfW = CONFIG.cellW * 0.5;
            const halfH = CONFIG.cellH * 0.5;
            for (let li = 0; li < LEVELS; li++) {
                const b = buckets[li];
                if (!b.length) continue;
                ctx.fillStyle = palette[li];
                for (let i = 0; i < b.length; i += 3) {
                    ctx.fillText(b[i], b[i + 1] * CONFIG.cellW + halfW, b[i + 2] * CONFIG.cellH + halfH);
                }
            }
            this.frames++;
        };
        this.release = () => {
            if (canvas) { canvas.width = 0; canvas.height = 0; }
            canvas = null;
            ctx = null;
        };
    }
    start() {
        if (this.running || this.destroyed) return;
        this.running = true;
        window.addEventListener('resize', this.resize);
        window.addEventListener('pointermove', this.pointermove);
        window.addEventListener('pointerleave', this.pointerleave);
        this.resize();
        // Paint synchronously so the first composited login frame contains waves.
        this.render(performance.now() + 1000 / 30);
    }
    stop() {
        this.running = false;
        cancelAnimationFrame(this.frame);
        window.removeEventListener('resize', this.resize);
        window.removeEventListener('pointermove', this.pointermove);
        window.removeEventListener('pointerleave', this.pointerleave);
    }
    destroy() { this.stop(); this.release(); this.destroyed = true; }
}
