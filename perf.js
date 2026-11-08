#!/usr/bin/env node
// Measure how smooth the launcher is on the TV, over the Chrome DevTools Protocol (port 9998,
// the same one cdp.js uses). The remote is played by Input.dispatchKeyEvent, so the page sees
// ordinary key presses, and the page itself records what happened:
//
//   frames      every requestAnimationFrame interval while a scenario runs. 16.7 ms is 60 fps;
//               anything over 50 ms is a stutter you can see.
//   focus lag   for each key press, the time until the focus ring has moved on screen. The
//               remote repeats a held key every ~50 ms, so a lag that grows past that means the
//               focus is falling behind the thumb.
//   counters    layouts, style recalculations and script time from Performance.getMetrics.
//
// Usage:
//   TV=192.168.1.123 node perf.js                     run every scenario, 3 times each
//   node perf.js drawer-slide dock-slide              only these
//   node perf.js --runs 5 --save before.json          keep the numbers
//   node perf.js --compare before.json                and later, set them side by side
//
// It moves the focus, opens the drawer and settings, and leaves the home screen as it found it.
// Needs Node 22 (WebSocket built in); on Node 20 it restarts itself with --experimental-websocket.

if (typeof WebSocket === "undefined") {
	const { spawnSync } = require("child_process");
	const r = spawnSync(process.execPath, ["--experimental-websocket", "--no-warnings", __filename, ...process.argv.slice(2)], { stdio: "inherit" });
	process.exit(r.status === null ? 1 : r.status);
}

const fs = require("fs");
const TV = process.env.TV || "192.168.1.239";
const PORT = process.env.PORT || 9998;
const APP_ID = process.env.APP_ID || "io.github.devic021.openhome";
const KEY = { left: 37, up: 38, right: 39, down: 40 };
const KEYNAME = { 37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight", 40: "ArrowDown" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the scenarios ---------------------------------------------------------------------------
// setup: an expression run in the page first. keys: [key, count] pairs. gap: ms between presses.
const SCENARIOS = {
	idle: {
		about: "home screen, nothing pressed for 3 s",
		setup: "gohomeforperf()",
		wait: 3000,
	},
	"dock-slide": {
		about: "home screen, hold Right along the dock and Left back (a press every 50 ms)",
		setup: "gohomeforperf(); setfocus(appbar.querySelector('.appitem'))",
		keys: [["right", 9], ["left", 9]],
		gap: 50,
	},
	"drawer-open": {
		about: "open the drawer from the home screen",
		setup: "gohomeforperf()",
		action: "realappbarbtu.click()",
		wait: 1200,
	},
	"drawer-slide": {
		about: "drawer, hold Right from the first item to the end of the row (a press every 50 ms)",
		setup: "gohomeforperf(); realappbarbtu.click(); setfocus(appluncher.children[0])",
		keys: [["right", 11]],
		gap: 50,
	},
	"drawer-updown": {
		about: "drawer, Down three rows and back up (a press every 350 ms)",
		setup: "gohomeforperf(); realappbarbtu.click(); setfocus(appluncher.querySelector('.appitem[data-appid]'))",
		keys: [["down", 3], ["up", 3]],
		gap: 350,
	},
	"home-key": {
		about: "drawer and settings open, then the Home button (the webOSRelaunch it sends)",
		setup: "gohomeforperf(); realappbarbtu.click(); opensettings()",
		action: "document.dispatchEvent(new CustomEvent('webOSRelaunch',{detail:{launchType:'homeKey'}}))",
		wait: 1200,
	},
};

// Put the launcher back on its home screen with the remote's focus showing. Defined in the page,
// so every scenario starts from the same place whatever the last one left open.
const PAGE_HELPERS = `
window.gohomeforperf = function(){
	if (typeof gohome === "function") { gohome(); }
	else {
		if (typeof settingsisopen === "function" && settingsisopen()) closesettings();
		if (realappbarbtu.checked) realappbarbtu.click();
	}
	keyboardmode = true;
	setfocus(appbar.querySelector(".appitem"));
};
window.__perf = { frames: [], lag: [], on: false };
if (!window.__perfwired) {
	window.__perfwired = true;
	let last = 0;
	const tick = (now) => {
		if (window.__perf.on && last) window.__perf.frames.push(now - last);
		last = now;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	window.addEventListener("keydown", (e) => {
		if (!window.__perf.on) return;
		const t0 = e.timeStamp;
		const was = document.querySelector(".dfocus");
		const check = () => {
			if (document.querySelector(".dfocus") !== was) { requestAnimationFrame((t) => window.__perf.lag.push(t - t0)); return; }
			if (performance.now() - t0 < 1500) requestAnimationFrame(check);
		};
		requestAnimationFrame(check);
	}, true);
}
true;`;

// ---- DevTools protocol -----------------------------------------------------------------------
async function connect() {
	const list = await (await fetch(`http://${TV}:${PORT}/json/list`)).json();
	const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl && (t.url || "").includes(APP_ID));
	if (!page) throw new Error(`OpenHome is not a debuggable page on ${TV}:${PORT} - is it running in developer mode?`);
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("websocket unreachable")); });
	let id = 0;
	const waiting = new Map();
	ws.onmessage = (event) => {
		const m = JSON.parse(event.data);
		if (m.id && waiting.has(m.id)) {
			const { resolve, reject } = waiting.get(m.id);
			waiting.delete(m.id);
			m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
		}
	};
	return {
		send(method, params = {}) {
			const mine = ++id;
			return new Promise((resolve, reject) => {
				waiting.set(mine, { resolve, reject });
				ws.send(JSON.stringify({ id: mine, method, params }));
			});
		},
		close: () => ws.close(),
	};
}

async function evaluate(cdp, expression) {
	const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || expression + " threw");
	return r.result.value;
}

async function press(cdp, code) {
	const base = { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, key: KEYNAME[code], code: KEYNAME[code] };
	await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
	await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function counters(cdp) {
	const out = {};
	(await cdp.send("Performance.getMetrics")).metrics.forEach((m) => { out[m.name] = m.value; });
	return out;
}

// ---- one run of one scenario -----------------------------------------------------------------
async function runonce(cdp, scenario) {
	await evaluate(cdp, scenario.setup);
	await sleep(900);                                   // let opening animations finish
	const before = await counters(cdp);
	await evaluate(cdp, "window.__perf.frames = []; window.__perf.lag = []; window.__perf.on = true");
	if (scenario.action) await evaluate(cdp, scenario.action);
	for (const [key, count] of scenario.keys || []) {
		for (let i = 0; i < count; i++) { await press(cdp, KEY[key]); await sleep(scenario.gap); }
	}
	await sleep(scenario.wait || 700);
	const got = await evaluate(cdp, "window.__perf.on = false; ({frames: window.__perf.frames, lag: window.__perf.lag})");
	const after = await counters(cdp);
	const frames = got.frames;
	const sorted = got.lag.slice().sort((a, b) => a - b);
	return {
		worst_frame: Math.max(0, ...frames),
		over_50ms: frames.filter((f) => f > 50).length,
		lag_median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
		lag_worst: sorted.length ? sorted[sorted.length - 1] : null,
		layouts: after.LayoutCount - before.LayoutCount,
		style_recalcs: after.RecalcStyleCount - before.RecalcStyleCount,
		script_ms: (after.ScriptDuration - before.ScriptDuration) * 1000,
	};
}

// the median of each figure over the runs: one bad run (the TV doing something else) does not
// decide the result, and one lucky run does not hide a real problem
function median(values) {
	const v = values.filter((x) => x !== null).sort((a, b) => a - b);
	return v.length ? v[Math.floor(v.length / 2)] : null;
}

function combine(runs) {
	const out = {};
	Object.keys(runs[0]).forEach((k) => { out[k] = median(runs.map((r) => r[k])); });
	return out;
}

// ---- reporting -------------------------------------------------------------------------------
const COLUMNS = [
	["worst_frame", "worst frame", "ms"],
	["over_50ms", ">50ms", ""],
	["lag_median", "lag med", "ms"],
	["lag_worst", "lag worst", "ms"],
	["layouts", "layouts", ""],
	["style_recalcs", "styles", ""],
	["script_ms", "script", "ms"],
];

function cell(value, unit) {
	if (value === null || value === undefined) return "-";
	return (Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 1 : 0)) + unit;
}

function report(results, baseline) {
	const name = Math.max(...Object.keys(results).map((n) => n.length), 8);
	console.log("".padEnd(name) + COLUMNS.map(([, label]) => label.padStart(baseline ? 18 : 11)).join(""));
	for (const [scenario, r] of Object.entries(results)) {
		const b = baseline && baseline.results && baseline.results[scenario];
		const row = COLUMNS.map(([key, , unit]) => {
			const now = cell(r[key], unit);
			if (!b || b[key] === null || b[key] === undefined) return now.padStart(baseline ? 18 : 11);
			return (cell(b[key], unit) + " -> " + now).padStart(18);
		});
		console.log(scenario.padEnd(name) + row.join(""));
	}
}

async function main() {
	const args = process.argv.slice(2);
	const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args.splice(i, 2)[1]; };
	const runs = Number(opt("--runs") || 3);
	const save = opt("--save");
	const compare = opt("--compare");
	const names = args.length ? args : Object.keys(SCENARIOS);
	names.forEach((n) => { if (!SCENARIOS[n]) throw new Error(`no scenario "${n}"; there are: ${Object.keys(SCENARIOS).join(", ")}`); });

	const cdp = await connect();
	try {
		await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
		await evaluate(cdp, PAGE_HELPERS);
		const release = await evaluate(cdp, "typeof APP_RELEASE === 'string' ? APP_RELEASE : '?'");
		const results = {};
		for (const n of names) {
			process.stderr.write(`${n}: ${SCENARIOS[n].about}\n`);
			const all = [];
			for (let i = 0; i < runs; i++) all.push(await runonce(cdp, SCENARIOS[n]));
			results[n] = combine(all);
		}
		await evaluate(cdp, "gohomeforperf()");
		console.log(`OpenHome ${release} on ${TV}, median of ${runs} runs per scenario` + (compare ? `, against ${compare}` : ""));
		report(results, compare ? JSON.parse(fs.readFileSync(compare, "utf8")) : null);
		if (save) {
			fs.writeFileSync(save, JSON.stringify({ release, tv: TV, runs, date: new Date().toISOString(), results }, null, 1));
			console.log("saved to " + save);
		}
	} finally {
		cdp.close();
	}
}

main().catch((e) => { console.error(String(e.message || e)); process.exitCode = 1; });
