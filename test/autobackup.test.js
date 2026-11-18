// backup.js: the backup file brings the layout and settings back when a reinstall empties localStorage,
// and nothing is written to it before that check has run.
const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./load");

function fakestorage(initial = {}) {
	const data = { ...initial };
	return {
		data,
		getItem: (key) => (key in data ? data[key] : null),
		setItem: (key, value) => { data[key] = String(value); },
		removeItem: (key) => { delete data[key]; },
	};
}

function launcher({ storage, file, rooted = true, hold = null }) {
	const writes = [];
	let page;
	page = load(["i18n.js", "settings.js", "backup.js", "firstrun.js"], {
		localStorage: storage,
		SETTINGS_KEY: "openlauncher.settings",
		rooted,
		settings: { pinned: null, hidden: [], order: [], folders: [], appfolder: {}, sysplaced: [], sysdismissed: [], names: {} },
		APP_NAME_MAX: 40,
		navigator: { language: "en" },
		setTimeout: (fn) => { fn(); return 1; },
		clearTimeout: () => {},
		execasroot: async (command) => {
			if (/\bcat \/media\/developer\/openlauncher-settings\.json\b/.test(command)) {
				if (file === "unreadable") { return { returnValue: false, errorText: "service busy" }; }
				return file === null ? { stdoutString: page.run("BACKUP_MISSING") } : { stdoutString: file };
			}
			writes.push(command);
			if (hold) { await hold(command); }
			return { returnValue: true };
		},
	});
	page.run("applyprefs = function(){}");   // touches the page; nothing to draw here
	return { page, writes };
}

const PLACE = { name: "Paris, France", lat: 48.85, lon: 2.35 };
const BACKUP = JSON.stringify({
	app: "OpenHome",
	version: 1,
	prefs: { weatherPlace: PLACE, weatherUnit: "f" },
	layout: { pinned: ["netflix", "youtube.leanback.v4"], hidden: ["com.webos.app.notificationcenter"], order: [], folders: [{ id: "f1", name: "Streaming" }], appfolder: { netflix: "f1" }, names: { netflix: "Films" } },
});

test("an empty localStorage is filled from the backup file, weather place and dock included", async () => {
	const storage = fakestorage();
	const { page } = launcher({ storage, file: BACKUP });
	assert.strictEqual(await page.run("restorefromfile()"), true);
	const layout = JSON.parse(storage.data["openlauncher.settings"]);
	assert.deepStrictEqual(layout.pinned, ["netflix", "youtube.leanback.v4"]);
	assert.deepStrictEqual(layout.appfolder, { netflix: "f1" });
	assert.strictEqual(JSON.stringify(page.run("prefs.weatherPlace")), JSON.stringify(PLACE));
	assert.strictEqual(page.run("prefs.weatherUnit"), "f");
	assert.notStrictEqual(storage.data["openlauncher.firstrun"], undefined);
});

test("settings already in localStorage are left alone", async () => {
	const storage = fakestorage({ "openlauncher.settings": JSON.stringify({ pinned: ["mine"] }) });
	const { page } = launcher({ storage, file: BACKUP });
	assert.strictEqual(await page.run("restorefromfile()"), false);
	assert.deepStrictEqual(JSON.parse(storage.data["openlauncher.settings"]).pinned, ["mine"]);
});

test("no file, or not a backup: nothing is restored", async () => {
	assert.strictEqual(await launcher({ storage: fakestorage(), file: null }).page.run("restorefromfile()"), false);
	assert.strictEqual(await launcher({ storage: fakestorage(), file: "not json" }).page.run("restorefromfile()"), false);
});

test("without root there is no file to read", async () => {
	assert.strictEqual(await launcher({ storage: fakestorage(), file: BACKUP, rooted: false }).page.run("restorefromfile()"), false);
});

test("saves reach the file only once start-up has looked for a restore", async () => {
	const { page, writes } = launcher({ storage: fakestorage(), file: null });
	page.run("scheduleautobackup()");
	assert.strictEqual(writes.length, 0);
	page.run("startautobackup()");
	assert.strictEqual(writes.length, 1);
	assert.match(writes[0], /mv -f \/media\/developer\/openlauncher-settings\.json\.tmp \/media\/developer\/openlauncher-settings\.json$/);
	page.run("scheduleautobackup()");
	await page.run("backupwriting");   // the second write starts once the first is done
	assert.strictEqual(writes.length, 2);
});

test("the file is written beside itself and renamed over, so a cut-off write never leaves half a file", async () => {
	const { page, writes } = launcher({ storage: fakestorage(), file: null });
	await page.run("writebackupnow()");
	assert.strictEqual(writes.length, 1);
	assert.match(writes[0], /^printf '%s' '[\s\S]*' > \/media\/developer\/openlauncher-settings\.json\.tmp && sync && mv -f /);
});

test("writes never overlap: a second one waits for the first to finish", async () => {
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	let inflight = 0;
	let most = 0;
	const { page, writes } = launcher({
		storage: fakestorage(),
		file: null,
		hold: async () => {
			inflight++;
			most = Math.max(most, inflight);
			await gate;
			inflight--;
		},
	});
	const first = page.run("writebackupnow()");
	const second = page.run("writebackupnow()");
	await new Promise((resolve) => setImmediate(resolve));
	assert.strictEqual(writes.length, 1);
	release();
	assert.strictEqual(await first, true);
	assert.strictEqual(await second, true);
	assert.strictEqual(writes.length, 2);
	assert.strictEqual(most, 1);
});

test("a file that is not valid JSON is set aside, not restored", async () => {
	const { page, writes } = launcher({ storage: fakestorage(), file: '{"app":"OpenHome","version":1,"pre' });
	assert.strictEqual(await page.run("restorefromfile()"), false);
	assert.ok(writes.some((command) => command === "mv -f /media/developer/openlauncher-settings.json /media/developer/openlauncher-settings.json.invalid"));
});

test("a file that could not be read is never written over with the empty state", async () => {
	const { page, writes } = launcher({ storage: fakestorage(), file: "unreadable" });
	assert.strictEqual(await page.run("restorefromfile()"), false);
	page.run("startautobackup()");
	page.run("scheduleautobackup()");
	assert.strictEqual(await page.run("writebackupnow()"), false);
	assert.strictEqual(writes.length, 0);
});

function importer({ file, rooted = true }) {
	const { page } = launcher({ storage: fakestorage(), file, rooted });
	page.run("renderpane = function(){}; render = function(){}; savesettings = function(){};");
	return page;
}

test("Import with an empty box restores the backup file instead of calling it invalid JSON", async () => {
	const page = importer({ file: BACKUP });
	await page.run("importbackup()");
	assert.strictEqual(page.run("prefs.weatherUnit"), "f");
	assert.match(page.run("backupmessage"), /^Imported /);
});

test("Import with an empty box and nothing to read says so", async () => {
	const page = importer({ file: null });
	await page.run("importbackup()");
	assert.doesNotMatch(page.run("backupmessage"), /valid JSON/);
	const unrooted = importer({ file: null, rooted: false });
	await unrooted.run("importbackup()");
	assert.doesNotMatch(unrooted.run("backupmessage"), /valid JSON/);
});
