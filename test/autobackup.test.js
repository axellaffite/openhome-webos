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

function launcher({ storage, file, rooted = true }) {
	const writes = [];
	const page = load(["i18n.js", "settings.js", "backup.js", "firstrun.js"], {
		localStorage: storage,
		SETTINGS_KEY: "openlauncher.settings",
		rooted,
		settings: { pinned: null, hidden: [], order: [], folders: [], appfolder: {}, sysplaced: [], sysdismissed: [], names: {} },
		APP_NAME_MAX: 40,
		navigator: { language: "en" },
		setTimeout: (fn) => { fn(); return 1; },
		clearTimeout: () => {},
		execasroot: async (command) => {
			if (command.indexOf("cat ") === 0) {
				return file === null ? { exitCode: 1 } : { stdoutString: file };
			}
			writes.push(command);
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

test("saves reach the file only once start-up has looked for a restore", () => {
	const { page, writes } = launcher({ storage: fakestorage(), file: null });
	page.run("scheduleautobackup()");
	assert.strictEqual(writes.length, 0);
	page.run("startautobackup()");
	assert.strictEqual(writes.length, 1);
	assert.match(writes[0], /> \/media\/developer\/openlauncher-settings\.json$/);
	page.run("scheduleautobackup()");
	assert.strictEqual(writes.length, 2);
});
