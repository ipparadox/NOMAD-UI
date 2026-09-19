"use strict";

function nomadFinite(value) {
    return Number.isFinite(value) ? value : null;
}

function nomadText(value, fallback = "UNAVAILABLE") {
    const output = String(value === null || typeof value === "undefined" ? fallback : value)
        .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    return (output || fallback).slice(0, 128);
}

function nomadPrettyBytes(value) {
    const amount = nomadFinite(value);
    if (amount === null || amount < 0) return "UNAVAILABLE";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let output = amount;
    let unit = 0;
    while (output >= 1000 && unit < units.length - 1) {
        output /= 1000;
        unit++;
    }
    return `${output >= 10 || unit === 0 ? output.toFixed(0) : output.toFixed(1)}${units[unit]}`;
}

function nomadSetText(id, value, fallback) {
    const element = document.getElementById(id);
    if (element) element.textContent = nomadText(value, fallback);
}

function nomadAverage(values) {
    const valid = values.filter(Number.isFinite);
    if (!valid.length) return null;
    return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

async function nomadInitialTelemetry(bridge, status) {
    let timer;
    try {
        return await Promise.race([bridge.getTelemetry(), new Promise(resolve => {
            timer = setTimeout(() => resolve(null), 8000);
        })]) || {ok: false, status, sequence: 0, timestamp: Date.now()};
    } catch (error) {
        return {ok: false, status, sequence: 0, timestamp: Date.now()};
    } finally { clearTimeout(timer); }
}

class SecureClock {
    constructor(parent) {
        this.parent = parent;
        this.twelveHours = window.settings.clockHours === 12;
        const element = document.createElement("div");
        element.id = "mod_clock";
        if (this.twelveHours) element.className = "mod_clock_twelve";
        const value = document.createElement("h1");
        value.id = "mod_clock_text";
        element.appendChild(value);
        this.parent.appendChild(element);
        this.element = element;
        this.value = value;
        this.updateClock();
        this.updater = setInterval(() => this.updateClock(), 1000);
    }

    updateClock() {
        const time = new Date();
        let hours = time.getHours();
        let suffix = "";
        if (this.twelveHours) {
            suffix = hours >= 12 ? "PM" : "AM";
            hours %= 12;
            if (hours === 0) hours = 12;
        }
        const clock = [hours, time.getMinutes(), time.getSeconds()].map(value => String(value).padStart(2, "0"));
        const fragment = document.createDocumentFragment();
        `${clock[0]}:${clock[1]}:${clock[2]}`.split("").forEach(character => {
            const digit = document.createElement(character === ":" ? "em" : "span");
            digit.textContent = character;
            fragment.appendChild(digit);
        });
        if (suffix) {
            const marker = document.createElement("span");
            marker.textContent = suffix;
            fragment.appendChild(marker);
        }
        this.value.replaceChildren(fragment);
        this.lastTime = time;
        document.body.dataset.nomadClockTimestamp = String(time.getTime());
    }
}

class SecureSystemTelemetry {
    constructor(opts) {
        this.parent = opts.parent;
        this.bridge = opts.bridge;
        this.log = typeof opts.log === "function" ? opts.log : (() => {});
        this.lastSequence = -1;
        this.lastProcesses = [];
        this.cpuSeries = [];
        this.cpuCharts = [];
        this.cpuCoreCount = 0;
        this._mount();
    }

    async initialize() {
        this.unsubscribe = this.bridge.subscribeTelemetry(snapshot => this.apply(snapshot));
        const initial = await nomadInitialTelemetry(this.bridge, "SYSTEM TELEMETRY UNAVAILABLE");
        this.apply(initial);
        return {initialized: true, available: initial.ok === true, status: initial.status};
    }

    apply(snapshot) {
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
        const sequence = Number.isSafeInteger(snapshot.sequence) ? snapshot.sequence : this.lastSequence + 1;
        if (sequence <= this.lastSequence) return false;
        this.lastSequence = sequence;
        this.lastReceived = Date.now();
        this.staleLogged = false;
        this.parent.dataset.telemetrySequence = String(sequence);
        this.parent.dataset.telemetryTimestamp = String(Number.isFinite(snapshot.timestamp) ? snapshot.timestamp : Date.now());
        document.body.dataset.nomadSystemTelemetry = snapshot.ok === true ? nomadText(snapshot.status, "AVAILABLE") : "UNAVAILABLE";
        this._setStatus(snapshot.ok !== true ? "SYSTEM TELEMETRY UNAVAILABLE"
            : snapshot.status === "PARTIAL" ? "SYSTEM TELEMETRY PARTIALLY UNAVAILABLE" : "");
        this._updateDate();
        this._updateRuntime(snapshot.runtime, snapshot.power);
        this._updateIdentity(snapshot.identity);
        this._updateCpu(snapshot.cpu, snapshot.timestamp);
        this._updateMemory(snapshot.memory);
        this._updateProcesses(snapshot.processes);
        return true;
    }

    _mount() {
        const status = document.createElement("p");
        status.id = "mod_system_telemetry_status";
        status.className = "nomad_module_status";
        status.hidden = true;
        this.statusElement = status;
        this.parent.appendChild(status);

        const sysinfo = document.createElement("div");
        sysinfo.id = "mod_sysinfo";
        sysinfo.innerHTML = `<div><h1>1970</h1><h2>JAN 1</h2></div>
            <div><h1>UPTIME</h1><h2>UNAVAILABLE</h2></div>
            <div><h1>TYPE</h1><h2>UNAVAILABLE</h2></div>
            <div><h1>POWER</h1><h2>UNAVAILABLE</h2></div>`;
        this.parent.appendChild(sysinfo);

        const hardware = document.createElement("div");
        hardware.id = "mod_hardwareInspector";
        hardware.innerHTML = `<div id="mod_hardwareInspector_inner">
            <div><h1>MANUFACTURER</h1><h2 id="mod_hardwareInspector_manufacturer">UNAVAILABLE</h2></div>
            <div><h1>MODEL</h1><h2 id="mod_hardwareInspector_model">UNAVAILABLE</h2></div>
            <div><h1>CHASSIS</h1><h2 id="mod_hardwareInspector_chassis">UNAVAILABLE</h2></div>
        </div>`;
        this.parent.appendChild(hardware);

        const cpu = document.createElement("div");
        cpu.id = "mod_cpuinfo";
        cpu.innerHTML = `<div id="mod_cpuinfo_innercontainer">
            <h1>CPU USAGE<i id="mod_cpuinfo_name">UNAVAILABLE</i></h1>
            <div><h1># <em id="mod_cpuinfo_range_start_0">1</em> - <em id="mod_cpuinfo_range_end_0">--</em><br><i id="mod_cpuinfo_usagecounter0">Avg. --%</i></h1><canvas id="mod_cpuinfo_canvas_0" height="60"></canvas></div>
            <div><h1># <em id="mod_cpuinfo_range_start_1">--</em> - <em id="mod_cpuinfo_range_end_1">--</em><br><i id="mod_cpuinfo_usagecounter1">Avg. --%</i></h1><canvas id="mod_cpuinfo_canvas_1" height="60"></canvas></div>
            <div>
                <div><h1 id="mod_cpuinfo_temp_label">TEMP<br><i id="mod_cpuinfo_temp">UNAVAILABLE</i></h1></div>
                <div><h1>SPD<br><i id="mod_cpuinfo_speed_min">UNAVAILABLE</i></h1></div>
                <div><h1>MAX<br><i id="mod_cpuinfo_speed_max">UNAVAILABLE</i></h1></div>
                <div><h1>TASKS<br><i id="mod_cpuinfo_tasks">UNAVAILABLE</i></h1></div>
            </div>
        </div>`;
        this.parent.appendChild(cpu);

        const memory = document.createElement("div");
        memory.id = "mod_ramwatcher";
        const inner = document.createElement("div");
        inner.id = "mod_ramwatcher_inner";
        inner.innerHTML = `<h1>MEMORY<i id="mod_ramwatcher_info">UNAVAILABLE</i></h1>`;
        const pointmap = document.createElement("div");
        pointmap.id = "mod_ramwatcher_pointmap";
        for (let index = 0; index < 440; index++) {
            const point = document.createElement("div");
            point.className = "mod_ramwatcher_point free";
            pointmap.appendChild(point);
        }
        const swap = document.createElement("div");
        swap.id = "mod_ramwatcher_swapcontainer";
        swap.innerHTML = `<h1>SWAP</h1><progress id="mod_ramwatcher_swapbar" max="100" value="0"></progress><h3 id="mod_ramwatcher_swaptext">UNAVAILABLE</h3>`;
        inner.append(pointmap, swap);
        memory.appendChild(inner);
        this.parent.appendChild(memory);
        this.memoryPoints = Array.from(pointmap.children);
        const points = this.memoryPoints.slice();
        this.memoryPoints = points.map((point, index) => points[(index * 173) % points.length]);

        const processes = document.createElement("div");
        processes.id = "mod_toplist";
        processes.setAttribute("role", "button");
        processes.setAttribute("tabindex", "0");
        processes.setAttribute("aria-label", "Open active process list");
        processes.innerHTML = `<h1>TOP PROCESSES<i>PID | NAME | CPU | MEM</i></h1><br><table id="mod_toplist_table"></table>`;
        processes.addEventListener("click", () => this.openProcessList());
        processes.addEventListener("keydown", event => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            this.openProcessList();
        });
        this.parent.appendChild(processes);
    }

    _setStatus(message) {
        this.statusElement.textContent = message;
        this.statusElement.hidden = !message;
    }

    _updateDate() {
        const value = new Date();
        const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
        const year = document.querySelector("#mod_sysinfo > div:first-child > h1");
        const date = document.querySelector("#mod_sysinfo > div:first-child > h2");
        if (year) year.textContent = String(value.getFullYear());
        if (date) date.textContent = `${months[value.getMonth()]} ${value.getDate()}`;
    }

    _updateRuntime(runtime, power) {
        const uptimeElement = document.querySelector("#mod_sysinfo > div:nth-child(2) > h2");
        const typeElement = document.querySelector("#mod_sysinfo > div:nth-child(3) > h2");
        const powerElement = document.querySelector("#mod_sysinfo > div:nth-child(4) > h2");
        if (runtime && Number.isFinite(runtime.uptime)) {
            let remaining = Math.max(0, Math.floor(runtime.uptime));
            const days = Math.floor(remaining / 86400);
            remaining -= days * 86400;
            const hours = String(Math.floor(remaining / 3600)).padStart(2, "0");
            const minutes = String(Math.floor((remaining % 3600) / 60)).padStart(2, "0");
            uptimeElement.textContent = `${days}d${hours}:${minutes}`;
        } else uptimeElement.textContent = "UNAVAILABLE";
        typeElement.textContent = runtime ? nomadText(runtime.platform || runtime.type) : "UNAVAILABLE";
        if (!power) powerElement.textContent = "UNAVAILABLE";
        else if (!power.hasBattery) powerElement.textContent = "ON";
        else if (power.isCharging) powerElement.textContent = "CHARGE";
        else if (power.acConnected) powerElement.textContent = "WIRED";
        else powerElement.textContent = Number.isFinite(power.percent) ? `${Math.round(power.percent)}%` : "UNAVAILABLE";
    }

    _updateIdentity(identity) {
        identity = identity || {};
        nomadSetText("mod_hardwareInspector_manufacturer", identity.manufacturer);
        nomadSetText("mod_hardwareInspector_model", identity.model);
        nomadSetText("mod_hardwareInspector_chassis", identity.chassis);
    }

    _ensureCpuCharts(coreCount) {
        const count = Number.isSafeInteger(coreCount) && coreCount > 0 ? Math.min(coreCount, 256) : 0;
        if (!count || this.cpuCoreCount === count || typeof window.TimeSeries !== "function"
            || typeof window.SmoothieChart !== "function") return;
        this.cpuCharts.forEach(chart => { if (chart && typeof chart.stop === "function") chart.stop(); });
        this.cpuCoreCount = count;
        this.cpuSeries = [];
        this.cpuCharts = [];
        const divide = Math.max(1, Math.floor(count / 2));
        this.cpuDivide = divide;
        nomadSetText("mod_cpuinfo_range_end_0", divide);
        nomadSetText("mod_cpuinfo_range_start_1", Math.min(count, divide + 1));
        nomadSetText("mod_cpuinfo_range_end_1", count);
        for (let index = 0; index < 2; index++) {
            const chart = new window.SmoothieChart({
                limitFPS: 30,
                responsive: true,
                millisPerPixel: 50,
                grid: {fillStyle: "transparent", strokeStyle: "transparent", verticalSections: 0, borderVisible: false},
                labels: {disabled: true},
                yRangeFunction: () => ({min: 0, max: 100})
            });
            this.cpuCharts.push(chart);
        }
        for (let index = 0; index < count; index++) {
            const series = new window.TimeSeries();
            this.cpuSeries.push(series);
            this.cpuCharts[index < divide ? 0 : 1].addTimeSeries(series, {
                lineWidth: 1.7,
                strokeStyle: `rgb(${window.theme.r},${window.theme.g},${window.theme.b})`
            });
        }
        this.cpuCharts.forEach((chart, index) => chart.streamTo(document.getElementById(`mod_cpuinfo_canvas_${index}`), 500));
    }

    _updateCpu(cpu, timestamp) {
        cpu = cpu || {};
        const loads = Array.isArray(cpu.coreLoads) ? cpu.coreLoads.map(nomadFinite) : [];
        const coreCount = Number.isSafeInteger(cpu.cores) && cpu.cores > 0 ? cpu.cores : loads.length;
        this._ensureCpuCharts(coreCount);
        this.dataAvailable = loads.some(Number.isFinite);
        this.cpuCharts.forEach(chart => this.dataAvailable && !document.hidden ? chart.start() : chart.stop());
        const sampleTime = Number.isFinite(timestamp) ? timestamp : Date.now();
        this.cpuSeries.forEach((series, index) => {
            const value = Number.isFinite(loads[index]) ? Math.max(0, Math.min(100, loads[index])) : null;
            if (value !== null) series.append(sampleTime, value);
        });
        if (this.cpuSeries.length && loads.some(Number.isFinite)) {
            document.body.dataset.nomadCpuGraphTimestamp = String(sampleTime);
        }
        const first = nomadAverage(loads.slice(0, this.cpuDivide));
        const second = nomadAverage(loads.slice(this.cpuDivide));
        nomadSetText("mod_cpuinfo_usagecounter0", first === null ? "Avg. --%" : `Avg. ${Math.round(first)}%`);
        nomadSetText("mod_cpuinfo_usagecounter1", second === null ? "Avg. --%" : `Avg. ${Math.round(second)}%`);
        nomadSetText("mod_cpuinfo_name", `${cpu.manufacturer || ""} ${cpu.brand || ""}`.trim().slice(0, 30));
        const windows = window.nomadBootstrap && window.nomadBootstrap.platform === "win32";
        const tempLabel = document.getElementById("mod_cpuinfo_temp_label");
        if (tempLabel) tempLabel.firstChild.textContent = windows ? "CORES" : "TEMP";
        nomadSetText("mod_cpuinfo_temp", windows ? coreCount : (Number.isFinite(cpu.temperature) ? `${Math.round(cpu.temperature)}°C` : "UNAVAILABLE"));
        nomadSetText("mod_cpuinfo_speed_min", Number.isFinite(cpu.speed) ? `${cpu.speed.toFixed(2)}GHz` : "UNAVAILABLE");
        nomadSetText("mod_cpuinfo_speed_max", Number.isFinite(cpu.speedMax) ? `${cpu.speedMax.toFixed(2)}GHz` : "UNAVAILABLE");
        nomadSetText("mod_cpuinfo_tasks", Number.isSafeInteger(cpu.tasks) ? cpu.tasks : "UNAVAILABLE");
    }

    _updateMemory(memory) {
        if (!memory || !Number.isFinite(memory.total) || memory.total <= 0) {
            nomadSetText("mod_ramwatcher_info", "UNAVAILABLE");
            nomadSetText("mod_ramwatcher_swaptext", "UNAVAILABLE");
            this.memoryPoints.forEach(point => { point.className = "mod_ramwatcher_point"; });
            document.getElementById("mod_ramwatcher_swapbar").removeAttribute("value");
            return;
        }
        const activeValue = Number.isFinite(memory.active) ? memory.active : memory.used;
        if (!Number.isFinite(activeValue)) return;
        const activeBytes = Math.max(0, activeValue);
        const freeBytes = Number.isFinite(memory.free) ? Math.max(0, memory.free) : null;
        const knownFree = freeBytes === null ? Math.max(0, memory.total - activeBytes) : freeBytes;
        const availableBytes = Number.isFinite(memory.available) ? Math.max(knownFree, memory.available) : knownFree;
        const active = Math.max(0, Math.min(440, Math.round((440 * activeBytes) / memory.total)));
        const available = Math.max(0, Math.min(440 - active, Math.round((440 * Math.max(0, availableBytes - knownFree)) / memory.total)));
        this.memoryPoints.forEach((point, index) => {
            point.className = `mod_ramwatcher_point ${index < active ? "active" : (index < active + available ? "available" : "free")}`;
        });
        const totalGiB = Math.round((memory.total / 1073741824) * 10) / 10;
        const usedGiB = Math.round((activeBytes / 1073741824) * 10) / 10;
        nomadSetText("mod_ramwatcher_info", `USING ${usedGiB} OUT OF ${totalGiB} GiB`);
        const swapBar = document.getElementById("mod_ramwatcher_swapbar");
        const swapPercent = Number.isFinite(memory.swapTotal) && memory.swapTotal > 0 && Number.isFinite(memory.swapUsed)
            ? Math.max(0, Math.min(100, (100 * memory.swapUsed) / memory.swapTotal)) : 0;
        if (swapBar) swapBar.value = swapPercent;
        nomadSetText("mod_ramwatcher_swaptext", Number.isFinite(memory.swapUsed)
            ? `${Math.round((memory.swapUsed / 1073741824) * 10) / 10} GiB` : "UNAVAILABLE");
        document.body.dataset.nomadMemoryTimestamp = String(Date.now());
    }

    _updateProcesses(processes) {
        if (!Array.isArray(processes)) processes = [];
        const normalized = processes.map(processInfo => Object.assign({}, processInfo));
        if (window.settings.excludeThreadsFromToplist === true) {
            const byName = new Map();
            normalized.forEach(processInfo => {
                const key = nomadText(processInfo.name, "PROCESS");
                if (!byName.has(key)) byName.set(key, processInfo);
                else {
                    const current = byName.get(key);
                    current.cpu = (Number(current.cpu) || 0) + (Number(processInfo.cpu) || 0);
                    current.memory = (Number(current.memory) || 0) + (Number(processInfo.memory) || 0);
                }
            });
            this.lastProcesses = Array.from(byName.values());
        } else this.lastProcesses = normalized;
        const table = document.getElementById("mod_toplist_table");
        if (!table) return;
        table.replaceChildren();
        this.lastProcesses.slice().sort((left, right) => {
            const leftScore = (Number(left.cpu) || 0) * 100 + (Number(left.memory) || 0);
            const rightScore = (Number(right.cpu) || 0) * 100 + (Number(right.memory) || 0);
            return rightScore - leftScore;
        }).slice(0, 5).forEach(processInfo => {
            const row = document.createElement("tr");
            const values = [
                Number.isSafeInteger(processInfo.pid) ? String(processInfo.pid) : "--",
                nomadText(processInfo.name, "PROCESS"),
                Number.isFinite(processInfo.cpu) ? `${Math.round(processInfo.cpu * 10) / 10}%` : "--%",
                Number.isFinite(processInfo.memory) ? `${Math.round(processInfo.memory * 10) / 10}%` : "--%"
            ];
            values.forEach((value, index) => {
                const cell = document.createElement("td");
                if (index === 1) {
                    const strong = document.createElement("strong");
                    strong.textContent = value;
                    cell.appendChild(strong);
                } else cell.textContent = value;
                row.appendChild(cell);
            });
            table.appendChild(row);
        });
        this._renderProcessList();
    }

    openProcessList() {
        if (this.processListRoot) return false;
        const root = document.createElement("section");
        root.id = "nomad_process_list";
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-label", "Active processes");
        const header = document.createElement("header");
        const title = document.createElement("h2");
        title.textContent = "ACTIVE PROCESSES //";
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "X";
        close.addEventListener("click", () => this.closeProcessList());
        header.append(title, close);
        const table = document.createElement("table");
        table.id = "processContainer";
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        [
            ["pid", "PID"], ["name", "NAME"], ["user", "USER"], ["cpu", "CPU"],
            ["memory", "MEMORY"], ["state", "STATE"], ["started", "STARTED"], ["runtime", "RUNTIME"]
        ].forEach(([field, label]) => {
            const cell = document.createElement("td");
            cell.className = `${field === "memory" ? "mem" : field} header`;
            cell.dataset.field = field;
            cell.textContent = label;
            cell.addEventListener("click", () => {
                if (this.processSortKey === field) this.processSortAscending = !this.processSortAscending;
                else { this.processSortKey = field; this.processSortAscending = false; }
                this._renderProcessList();
            });
            headRow.appendChild(cell);
        });
        head.appendChild(headRow);
        const body = document.createElement("tbody");
        body.id = "processList";
        table.append(head, body);
        root.append(header, table);
        this.processListRoot = root;
        this.processSortKey = null;
        this.processSortAscending = false;
        this._processKeydown = event => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            this.closeProcessList();
        };
        document.addEventListener("keydown", this._processKeydown, true);
        document.body.appendChild(root);
        if (window.nomadInputCapture) window.nomadInputCapture.acquire("process-list");
        this._renderProcessList();
        close.focus({preventScroll: true});
        return true;
    }

    closeProcessList() {
        if (!this.processListRoot) return false;
        document.removeEventListener("keydown", this._processKeydown, true);
        this.processListRoot.remove();
        this.processListRoot = null;
        if (window.nomadInputCapture) window.nomadInputCapture.release("process-list");
        const source = document.getElementById("mod_toplist");
        if (source) source.focus({preventScroll: true});
        return true;
    }

    _renderProcessList() {
        const body = document.getElementById("processList");
        if (!body || !this.processListRoot) return false;
        const direction = this.processSortAscending ? 1 : -1;
        const score = processInfo => (Number(processInfo.cpu) || 0) * 100 + (Number(processInfo.memory) || 0);
        const values = this.lastProcesses.slice().sort((left, right) => {
            if (!this.processSortKey) return score(right) - score(left);
            const key = this.processSortKey;
            if (key === "runtime") return direction * ((Date.parse(right.started) || 0) - (Date.parse(left.started) || 0));
            if (["pid", "cpu", "memory"].includes(key)) return direction * ((Number(left[key]) || 0) - (Number(right[key]) || 0));
            return direction * nomadText(left[key], "").localeCompare(nomadText(right[key], ""));
        });
        body.replaceChildren();
        values.forEach(processInfo => {
            const row = document.createElement("tr");
            const startedAt = Date.parse(processInfo.started);
            const runtime = Number.isFinite(startedAt) ? this._formatRuntime(Math.max(0, Date.now() - startedAt)) : "UNAVAILABLE";
            [
                ["pid", Number.isSafeInteger(processInfo.pid) ? processInfo.pid : "--"],
                ["name", nomadText(processInfo.name, "PROCESS")],
                ["user", nomadText(processInfo.user)],
                ["cpu", Number.isFinite(processInfo.cpu) ? `${Math.round(processInfo.cpu * 10) / 10}%` : "--%"],
                ["mem", Number.isFinite(processInfo.memory) ? `${Math.round(processInfo.memory * 10) / 10}%` : "--%"],
                ["state", nomadText(processInfo.state)],
                ["started", nomadText(processInfo.started)],
                ["runtime", runtime]
            ].forEach(([className, value]) => {
                const cell = document.createElement("td");
                cell.className = className;
                cell.textContent = String(value);
                row.appendChild(cell);
            });
            body.appendChild(row);
        });
        this.processListRoot.querySelectorAll("td.header").forEach(header => {
            const active = header.dataset.field === this.processSortKey;
            header.textContent = header.textContent.replace(/[▲▼]/g, "")
                + (active ? (this.processSortAscending ? "▲" : "▼") : "");
        });
        return true;
    }

    _formatRuntime(milliseconds) {
        let remaining = Math.max(0, Math.floor(milliseconds / 1000));
        const days = Math.floor(remaining / 86400);
        remaining %= 86400;
        const hours = Math.floor(remaining / 3600);
        remaining %= 3600;
        const minutes = Math.floor(remaining / 60);
        const seconds = remaining % 60;
        return [days, hours, minutes, seconds].map(value => String(value).padStart(2, "0")).join(":");
    }
}

class SecureLocationGlobe {
    constructor(opts) {
        this.container = opts.container;
        this.grid = opts.grid;
        this.theme = opts.theme;
        this.log = typeof opts.log === "function" ? opts.log : (() => {});
        this.connectionPins = new Map();
        this.endpointKey = null;
        this.frame = null;
        this.lastTick = 0;
        this.initialized = false;
        this.pendingSnapshot = null;
    }

    initialize() {
        if (!window.ENCOM || typeof window.ENCOM.Globe !== "function" || !this.grid || !Array.isArray(this.grid.tiles)) {
            this._unavailable("GLOBE DATA UNAVAILABLE");
            return Promise.resolve(false);
        }
        return new Promise(resolve => {
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            try {
                const placeholder = document.getElementById("mod_globe_canvas_placeholder");
                const width = Math.max(160, placeholder.offsetWidth || this.container.offsetWidth || 160);
                const height = Math.max(120, placeholder.offsetHeight || width);
                const globeTheme = this.theme.globe || {};
                this.globe = new window.ENCOM.Globe(width, height, {
                    font: this.theme.cssvars && this.theme.cssvars.font_main,
                    data: [],
                    tiles: this.grid.tiles,
                    baseColor: globeTheme.base || `rgb(${this.theme.r},${this.theme.g},${this.theme.b})`,
                    markerColor: globeTheme.marker || `rgb(${this.theme.r},${this.theme.g},${this.theme.b})`,
                    pinColor: globeTheme.pin || `rgb(${this.theme.r},${this.theme.g},${this.theme.b})`,
                    satelliteColor: globeTheme.satellite || `rgb(${this.theme.r},${this.theme.g},${this.theme.b})`,
                    scale: 1.1,
                    viewAngle: 0.63,
                    dayLength: 45000,
                    introLinesDuration: 2000,
                    introLinesColor: globeTheme.marker || `rgb(${this.theme.r},${this.theme.g},${this.theme.b})`,
                    maxPins: 64,
                    maxMarkers: 16
                });
                placeholder.replaceWith(this.globe.domElement);
                this.globe.init(this.theme.colors && this.theme.colors.light_black || "#101010", () => {
                    if (settled) return;
                    clearTimeout(this.initTimer);
                    this.initialized = true;
                    this._startAnimation();
                    document.body.dataset.nomadGlobe = "INITIALIZED";
                    if (this.pendingSnapshot) {
                        const pending = this.pendingSnapshot;
                        this.pendingSnapshot = null;
                        this.update(pending);
                    }
                    window.audioManager.scan.play();
                    finish(true);
                });
                this.resizeHandler = () => this.resize();
                window.addEventListener("resize", this.resizeHandler);
                this.initTimer = setTimeout(() => {
                    if (!settled) {
                        this._unavailable("GLOBE INITIALIZATION UNAVAILABLE");
                        finish(false);
                    }
                }, 8000);
            } catch (error) {
                this.log("warn", "Globe renderer initialization failed");
                this._unavailable("GLOBE INITIALIZATION UNAVAILABLE");
                finish(false);
            }
        });
    }

    update(snapshot) {
        if (!this.globe || !snapshot) return false;
        if (!this.initialized) {
            this.pendingSnapshot = snapshot;
            return true;
        }
        const root = document.getElementById("mod_globe");
        const header = document.querySelector("i.mod_globe_headerInfo");
        if (snapshot.status !== "ONLINE") {
            root.classList.add("offline");
            header.textContent = snapshot.status === "NETWORK TELEMETRY UNAVAILABLE" ? "UNAVAILABLE" : "(OFFLINE)";
            this._removeEndpoint();
            this._syncConnectionPins([]);
            return true;
        }
        root.classList.remove("offline");
        const endpoint = snapshot.endpoint;
        if (endpoint && Number.isFinite(endpoint.latitude) && Number.isFinite(endpoint.longitude)) {
            const latitude = Math.round(endpoint.latitude * 10000) / 10000;
            const longitude = Math.round(endpoint.longitude * 10000) / 10000;
            const key = `${latitude}:${longitude}`;
            header.textContent = `${latitude}, ${longitude}`;
            if (key !== this.endpointKey) {
                this._removeEndpoint();
                this.endpointKey = key;
                this.endpointPin = this.globe.addPin(latitude, longitude, "", 1.2);
                this.endpointMarker = this.globe.addMarker(latitude, longitude, "", false, 1.2);
            }
        } else {
            header.textContent = endpoint ? nomadText(endpoint.status, "LOCATION UNAVAILABLE") : "LOCATION UNAVAILABLE";
            this._removeEndpoint();
        }
        this._syncConnectionPins(Array.isArray(snapshot.connectionLocations) ? snapshot.connectionLocations : []);
        return true;
    }

    resize() {
        if (!this.globe || !this.globe.domElement) return false;
        const canvas = this.globe.domElement;
        const width = Math.max(160, canvas.parentElement ? canvas.parentElement.offsetWidth : canvas.offsetWidth);
        const height = Math.max(120, canvas.offsetHeight || width);
        if (this.globe.camera) {
            this.globe.camera.aspect = width / height;
            this.globe.camera.updateProjectionMatrix();
        }
        if (this.globe.renderer) this.globe.renderer.setSize(width, height);
        return true;
    }

    _startAnimation() {
        if (this.frame) return;
        const tick = timestamp => {
            if (!document.hidden && timestamp - this.lastTick >= 33 && this.globe) {
                try { this.globe.tick(); }
                catch (error) {
                    this._unavailable("GLOBE ANIMATION UNAVAILABLE");
                    this.log("warn", "Globe animation unavailable");
                    this.frame = null;
                    return;
                }
                this.lastTick = timestamp;
                document.body.dataset.nomadGlobeTick = String(Math.floor(timestamp));
            }
            this.frame = requestAnimationFrame(tick);
        };
        this.frame = requestAnimationFrame(tick);
    }

    _syncConnectionPins(locations) {
        const current = new Set();
        locations.slice(0, 24).forEach(location => {
            if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return;
            const latitude = Math.round(location.latitude * 10000) / 10000;
            const longitude = Math.round(location.longitude * 10000) / 10000;
            const key = `${latitude}:${longitude}`;
            current.add(key);
            if (!this.connectionPins.has(key)) {
                this.connectionPins.set(key, this.globe.addPin(latitude, longitude, "", 1.2));
            }
        });
        this.connectionPins.forEach((pin, key) => {
            if (current.has(key)) return;
            if (pin && typeof pin.remove === "function") pin.remove();
            this.connectionPins.delete(key);
        });
    }

    _removeEndpoint() {
        [this.endpointPin, this.endpointMarker].forEach(item => {
            if (item && typeof item.remove === "function") item.remove();
        });
        this.endpointPin = null;
        this.endpointMarker = null;
        this.endpointKey = null;
    }

    _unavailable(message) {
        const status = document.querySelector("#mod_globe h3");
        if (status) status.textContent = message;
        const root = document.getElementById("mod_globe");
        if (root) root.classList.add("offline");
        document.body.dataset.nomadGlobe = "UNAVAILABLE";
    }
}

class SecureNetworkTelemetry {
    constructor(opts) {
        this.parent = opts.parent;
        this.before = opts.before || null;
        this.bridge = opts.bridge;
        this.grid = opts.grid;
        this.theme = opts.theme;
        this.log = typeof opts.log === "function" ? opts.log : (() => {});
        this.lastSequence = -1;
        this._mount();
        this._initializeCharts();
        this.globe = new SecureLocationGlobe({
            container: document.getElementById("mod_globe_innercontainer"),
            grid: this.grid,
            theme: this.theme,
            log: this.log
        });
    }

    async initialize() {
        this.unsubscribe = this.bridge.subscribeTelemetry(snapshot => this.apply(snapshot));
        const globeReady = this.globe.initialize();
        const initial = await nomadInitialTelemetry(this.bridge, "NETWORK TELEMETRY UNAVAILABLE");
        this.apply(initial);
        const globeInitialized = await globeReady;
        return {initialized: true, available: initial.ok === true, status: initial.status, globeInitialized};
    }

    apply(snapshot) {
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
        const sequence = Number.isSafeInteger(snapshot.sequence) ? snapshot.sequence : this.lastSequence + 1;
        if (sequence <= this.lastSequence) return false;
        this.lastSequence = sequence;
        this.lastReceived = Date.now();
        this.staleLogged = false;
        this.parent.dataset.telemetrySequence = String(sequence);
        this.parent.dataset.telemetryTimestamp = String(Number.isFinite(snapshot.timestamp) ? snapshot.timestamp : Date.now());
        document.body.dataset.nomadNetworkTelemetry = snapshot.ok === true ? nomadText(snapshot.status, "ONLINE") : "UNAVAILABLE";
        const partial = snapshot.status === "ONLINE" && !snapshot.traffic;
        this.statusElement.textContent = snapshot.ok !== true ? "NETWORK TELEMETRY UNAVAILABLE"
            : partial ? "NETWORK TRAFFIC UNAVAILABLE" : "";
        this.statusElement.hidden = snapshot.ok === true && !partial;
        const online = snapshot.status === "ONLINE" && snapshot.interface;
        nomadSetText("mod_netstat_iname", online ? `Interface: ${snapshot.interface.displayName}` : "Interface: (offline)");
        nomadSetText("mod_netstat_state", snapshot.ok === false ? "UNAVAILABLE" : (online ? "ONLINE" : "OFFLINE"));
        const address = snapshot.endpoint && snapshot.endpoint.address
            ? snapshot.endpoint.address : (online ? snapshot.interface.ip4 : "--.--.--.--");
        nomadSetText("mod_netstat_ip", address);
        nomadSetText("mod_netstat_ping", Number.isFinite(snapshot.latencyMs) ? `${Math.round(snapshot.latencyMs)}ms` : "--ms");
        this._updateTraffic(snapshot, Boolean(online));
        this.globe.update(snapshot);
        return true;
    }

    _mount() {
        const netstat = document.createElement("div");
        netstat.id = "mod_netstat";
        netstat.innerHTML = `<div id="mod_netstat_inner"><h1>NETWORK STATUS<i id="mod_netstat_iname">Interface: (offline)</i></h1>
            <div id="mod_netstat_innercontainer">
                <div><h1>STATE</h1><h2 id="mod_netstat_state">UNKNOWN</h2></div>
                <div><h1>IPv4</h1><h2 id="mod_netstat_ip">--.--.--.--</h2></div>
                <div><h1>PING</h1><h2 id="mod_netstat_ping">--ms</h2></div>
            </div></div>`;
        const globe = document.createElement("div");
        globe.id = "mod_globe";
        globe.innerHTML = `<div id="mod_globe_innercontainer"><h1>WORLD VIEW<i>GLOBAL NETWORK MAP</i></h1>
            <h2>ENDPOINT LAT/LON<i class="mod_globe_headerInfo">LOCATION UNAVAILABLE</i></h2>
            <div id="mod_globe_canvas_placeholder"></div><h3>OFFLINE</h3></div>`;
        const traffic = document.createElement("div");
        traffic.id = "mod_conninfo";
        traffic.innerHTML = `<div id="mod_conninfo_innercontainer"><h1>NETWORK TRAFFIC<i id="mod_conninfo_current">UP / DOWN, MB/S</i></h1>
            <h2>TOTAL<i id="mod_conninfo_total">UNAVAILABLE</i></h2>
            <canvas id="mod_conninfo_canvas_top"></canvas><canvas id="mod_conninfo_canvas_bottom"></canvas><h3>OFFLINE</h3></div>`;
        const status = document.createElement("p");
        status.id = "mod_network_telemetry_status";
        status.className = "nomad_module_status";
        status.hidden = true;
        this.statusElement = status;
        [netstat, globe, traffic, status].forEach(element => this.parent.insertBefore(element, this.before));
    }

    _initializeCharts() {
        if (typeof window.TimeSeries !== "function" || typeof window.SmoothieChart !== "function") return;
        const base = {
            limitFPS: 30,
            responsive: true,
            millisPerPixel: 70,
            interpolation: "linear",
            grid: {
                millisPerLine: 5000,
                fillStyle: "transparent",
                strokeStyle: `rgba(${this.theme.r},${this.theme.g},${this.theme.b},0.4)`,
                verticalSections: 3,
                borderVisible: false
            },
            labels: {fontSize: 10, fillStyle: `rgb(${this.theme.r},${this.theme.g},${this.theme.b})`, precision: 2}
        };
        this.trafficSeries = [new window.TimeSeries(), new window.TimeSeries()];
        this.trafficCharts = [
            new window.SmoothieChart(Object.assign({}, base, {minValue: 0})),
            new window.SmoothieChart(Object.assign({}, base, {maxValue: 0}))
        ];
        this.trafficCharts[0].addTimeSeries(this.trafficSeries[0], {lineWidth: 1.7, strokeStyle: `rgb(${this.theme.r},${this.theme.g},${this.theme.b})`});
        this.trafficCharts[1].addTimeSeries(this.trafficSeries[1], {lineWidth: 1.7, strokeStyle: `rgb(${this.theme.r},${this.theme.g},${this.theme.b})`});
        this.trafficCharts[0].streamTo(document.getElementById("mod_conninfo_canvas_top"), 1000);
        this.trafficCharts[1].streamTo(document.getElementById("mod_conninfo_canvas_bottom"), 1000);
    }

    _updateTraffic(snapshot, online) {
        const root = document.getElementById("mod_conninfo");
        const traffic = snapshot.traffic;
        const timestamp = Number.isFinite(snapshot.timestamp) ? snapshot.timestamp : Date.now();
        this.dataAvailable = Boolean(online && traffic && Number.isFinite(traffic.tx_sec) && Number.isFinite(traffic.rx_sec));
        if (!online || !traffic) {
            root.classList.add("offline");
            if (this.trafficCharts) this.trafficCharts.forEach(chart => chart.stop());
            root.querySelector("h3").textContent = snapshot.ok === true && !online ? "OFFLINE" : "UNAVAILABLE";
            nomadSetText("mod_conninfo_current", "UP / DOWN, MB/S");
            nomadSetText("mod_conninfo_total", "UNAVAILABLE");
            return;
        }
        root.classList.remove("offline");
        const tx = Number.isFinite(traffic.tx_sec) ? traffic.tx_sec : null;
        const rx = Number.isFinite(traffic.rx_sec) ? traffic.rx_sec : null;
        if (this.trafficSeries && tx !== null && rx !== null) {
            this.trafficCharts.forEach(chart => document.hidden ? chart.stop() : chart.start());
            this.trafficSeries[0].append(timestamp, tx / 125000);
            this.trafficSeries[1].append(timestamp, -rx / 125000);
            const maximumUp = this.trafficSeries[0].maxValue;
            const maximumDown = -this.trafficSeries[1].minValue;
            if (maximumUp > maximumDown) this.trafficSeries[1].minValue = -maximumUp;
            else if (maximumDown > maximumUp) this.trafficSeries[0].maxValue = maximumDown;
            document.body.dataset.nomadNetworkGraphTimestamp = String(timestamp);
        }
        if (!this.dataAvailable && this.trafficCharts) this.trafficCharts.forEach(chart => chart.stop());
        nomadSetText("mod_conninfo_current", tx !== null && rx !== null
            ? `UP ${(tx / 125000).toFixed(2)} DOWN ${(rx / 125000).toFixed(2)}` : "UP / DOWN UNAVAILABLE");
        nomadSetText("mod_conninfo_total", `${nomadPrettyBytes(traffic.tx_bytes)} OUT, ${nomadPrettyBytes(traffic.rx_bytes)} IN`);
    }
}

class SecureTelemetryDashboard {
    constructor(opts) {
        this.systemBridge = opts.systemBridge;
        this.networkBridge = opts.networkBridge;
        this.bootstrap = opts.bootstrap;
        this.theme = opts.theme;
        this.log = typeof opts.log === "function" ? opts.log : (() => {});
    }

    async initialize() {
        const left = document.getElementById("mod_column_left");
        const right = document.getElementById("mod_column_right");
        if (!left || !right) throw new Error("Telemetry columns unavailable");
        this.clock = new SecureClock(left);
        const initialize = async (name, parent, create) => {
            try {
                this[name] = create();
                return await this[name].initialize();
            } catch (error) {
                const status = document.createElement("p");
                status.className = "nomad_module_status";
                status.style.opacity = "1";
                status.textContent = `${name.toUpperCase()} TELEMETRY UNAVAILABLE`;
                parent.appendChild(status);
                this.log("warn", `${name} telemetry initialization unavailable: ${nomadText(error && error.message)}`);
                return {initialized: false, available: false};
            }
        };
        const systemReady = initialize("system", left, () => new SecureSystemTelemetry({parent: left, bridge: this.systemBridge, log: this.log}));
        const networkReady = initialize("network", right, () => new SecureNetworkTelemetry({
            parent: right,
            before: document.getElementById("nomad_security_strip"),
            bridge: this.networkBridge,
            grid: this.bootstrap.globeGrid,
            theme: this.theme,
            log: this.log
        }));
        this.activatePanels();
        const [system, network] = await Promise.all([systemReady, networkReady]);
        this.watchdog = setInterval(() => this.checkFreshness(), 5000);
        document.addEventListener("visibilitychange", () => this.checkFreshness());
        window.addEventListener("beforeunload", () => this.dispose(), {once: true});
        window.mods = {
            clock: this.clock,
            sysinfo: this.system,
            hardwareInspector: this.system,
            cpuinfo: this.system,
            ramwatcher: this.system,
            toplist: this.system,
            netstat: this.network,
            globe: this.network && this.network.globe,
            conninfo: this.network
        };
        return {system, network};
    }

    checkFreshness() {
        [this.system, this.network].forEach(view => {
            if (!view) return;
            const stale = !view.lastReceived || Date.now() - view.lastReceived > 10000;
            const charts = view.cpuCharts || view.trafficCharts || [];
            charts.forEach(chart => document.hidden || stale || !view.dataAvailable ? chart.stop() : chart.start());
            if (!stale) return;
            const system = view === this.system;
            view.statusElement.textContent = system ? "SYSTEM TELEMETRY UNAVAILABLE" : "NETWORK TELEMETRY UNAVAILABLE";
            view.statusElement.hidden = false;
            document.body.dataset[system ? "nomadSystemTelemetry" : "nomadNetworkTelemetry"] = "UNAVAILABLE";
            if (!view.staleLogged) this.log("warn", `${system ? "System" : "Network"} telemetry subscription stale`);
            view.staleLogged = true;
        });
    }

    dispose() {
        clearInterval(this.watchdog);
        if (this.clock) clearInterval(this.clock.updater);
        [this.system, this.network].forEach(view => {
            if (!view) return;
            if (view.unsubscribe) view.unsubscribe();
            (view.cpuCharts || view.trafficCharts || []).forEach(chart => chart.stop());
        });
        if (this.network && this.network.globe) {
            cancelAnimationFrame(this.network.globe.frame);
            clearTimeout(this.network.globe.initTimer);
        }
    }

    activatePanels() {
        document.querySelectorAll(".mod_column").forEach(column => column.classList.add("activated"));
        const left = Array.from(document.querySelectorAll("#mod_column_left > div, #mod_column_left > p.nomad_module_status"));
        const right = Array.from(document.querySelectorAll("#mod_column_right > div, #mod_column_right > p.nomad_module_status"));
        const count = Math.max(left.length, right.length);
        for (let index = 0; index < count; index++) {
            setTimeout(() => {
                if (left[index]) left[index].style.animationPlayState = "running";
                if (right[index]) right[index].style.animationPlayState = "running";
                if (left[index] || right[index]) window.audioManager.panels.play();
            }, index * 250);
        }
        document.body.dataset.nomadPanelAnimation = "STARTED";
    }
}

window.SecureTelemetryDashboard = SecureTelemetryDashboard;
