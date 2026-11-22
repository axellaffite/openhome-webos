// quick.js redraws the input shortcuts on a timer. A redraw that changes nothing must not touch the
// row, and one that does must leave the remote's focus on the same input: the old button is thrown
// away, and a focus left on it sent the next arrow press to the first dock app.
const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./load");

const page = load(["quick.js"], {
	appdisplayname: (app) => app.name,
	inputglyph: (app) => "<svg>" + app.id + "</svg>",
});
const key = (apps) => page.run("quickrowkey")(apps);
const hdmi1 = { id: "com.webos.app.hdmi1", name: "PC" };
const hdmi2 = { id: "com.webos.app.hdmi2", name: "PS5" };

test("the same inputs in the same state give the same key", () => {
	page.run("quickdevices={}");
	assert.strictEqual(key([hdmi1, hdmi2]), key([{ ...hdmi1 }, { ...hdmi2 }]));
});

test("a renamed input changes the key", () => {
	page.run("quickdevices={}");
	assert.notStrictEqual(key([hdmi1]), key([{ ...hdmi1, name: "Office PC" }]));
});

test("an input appearing changes the key", () => {
	page.run("quickdevices={}");
	assert.notStrictEqual(key([hdmi1]), key([hdmi1, hdmi2]));
});

test("a device waking up changes the key (its light comes on)", () => {
	page.run("quickdevices={'com.webos.app.hdmi1':{port:1,subList:[{cecPower:'Standby'}]}}");
	const asleep = key([hdmi1]);
	page.run("quickdevices={'com.webos.app.hdmi1':{port:1,subList:[{cecPower:'On'}]}}");
	assert.notStrictEqual(key([hdmi1]), asleep);
});

// the redrawn row: the button for an input is found again by its app id
const row = (ids) => ({
	querySelector: (selector) => {
		const match = /data-appid="([^"]+)"/.exec(selector);
		return match && ids.includes(match[1]) ? { appid: match[1] } : null;
	},
});

test("the focus goes to the new button of the input it was on", () => {
	const focused = [];
	page.run("setfocus=(el)=>focusedlog.push(el)");
	page.global.focusedlog = focused;
	page.run("quickrefocus")(row(["com.webos.app.hdmi1", "com.webos.app.hdmi2"]), "com.webos.app.hdmi2");
	assert.deepStrictEqual(focused, [{ appid: "com.webos.app.hdmi2" }]);
});

test("nothing is focused when the input is gone from the row", () => {
	const focused = [];
	page.global.focusedlog = focused;
	page.run("quickrefocus")(row(["com.webos.app.hdmi1"]), "com.webos.app.hdmi2");
	assert.deepStrictEqual(focused, []);
});
