// focusonopen() in dpad.js: when the launcher opens, the remote is already on the first dock app -
// the ring is showing and the first arrow press moves it, instead of only switching the ring on.
const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./load");

function home({ panel = null, drawer = false } = {}) {
	const page = load(["dpad.js"]);
	const apps = { name: "Apps", closest: (s) => (s === "label[for=realappbarbtu]" ? {} : null) };
	const youtube = { name: "YouTube", closest: () => null };
	const focused = [];
	page.global.focused = focused;
	page.global.docktiles = [apps, youtube];
	page.global.realappbarbtu = { checked: drawer };
	page.global.appbar = {};
	page.global.openpanelnow = panel;
	page.run("within=()=>docktiles");
	page.run("openpanel=()=>openpanelnow");
	page.run("setfocus=(el)=>focused.push(el.name)");
	page.run("keyboardmode=false");
	return { page, focused };
}

test("the first app in the dock gets the focus, ready for the arrows", () => {
	const { page, focused } = home();
	page.run("focusonopen")();
	assert.deepStrictEqual(focused, ["YouTube"]);
	assert.strictEqual(page.run("keyboardmode"), true);
});

test("an open panel keeps the remote", () => {
	const { page, focused } = home({ panel: { name: "settings" } });
	page.run("focusonopen")();
	assert.deepStrictEqual(focused, []);
	assert.strictEqual(page.run("keyboardmode"), false);
});

test("the open app drawer keeps the remote", () => {
	const { page, focused } = home({ drawer: true });
	page.run("focusonopen")();
	assert.deepStrictEqual(focused, []);
});
