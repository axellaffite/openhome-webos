// main.js: pressing Home while the launcher is still starting must not save the built-in default
// layout over the saved one. Home sends webOSRelaunch, which calls reload(); on a slow boot that can
// come before inithomescreen() has loaded the layout, and reload() then saved its empty defaults
// (with the system folders added) over the dock you had built.
const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./load");

const MINE = JSON.stringify({ pinned: ["youtube.leanback.v4", "amazon"], hidden: [], order: [], folders: [], appfolder: {}, sysplaced: [], sysdismissed: [], names: {} });
const APPS = [
	{ id: "youtube.leanback.v4", title: "YouTube", visible: true },
	{ id: "amazon", title: "Prime Video", visible: true },
	{ id: "com.webos.app.hdmi1", title: "HDMI 1", visible: false },
];

function launcher() {
	const data = { "openlauncher.settings": MINE, "openlauncher.firstrun": "2026-11-16" };
	const page = load(["i18n.js", "settings.js", "main.js", "systemapps.js", "folders.js"], {
		localStorage: {
			getItem: (key) => (key in data ? data[key] : null),
			setItem: (key, value) => { data[key] = String(value); },
		},
		navigator: { language: "en" },
		lunacall: async () => ({ apps: APPS }),
		lunacallasroot: async () => ({ apps: APPS }),
	});
	page.run("render = function(){};");
	return { page, data };
}

test("Home pressed before the layout is loaded does not overwrite it", async () => {
	const { page, data } = launcher();
	await page.run("reload()");
	assert.strictEqual(data["openlauncher.settings"], MINE);
});

test("nothing saves the layout before it has been loaded", () => {
	const { page, data } = launcher();
	page.run("savesettings()");
	assert.strictEqual(data["openlauncher.settings"], MINE);
	page.run("loadsettings(); savesettings()");
	assert.deepStrictEqual(JSON.parse(data["openlauncher.settings"]).pinned, ["youtube.leanback.v4", "amazon"]);
});
