// firstdockapp() in dpad.js: where the focus ring starts on the home screen.
const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./load");

const page = load(["dpad.js"]);
const first = (tiles) => page.run("firstdockapp")(tiles);

// a dock tile; the Apps button sits inside the label that toggles the drawer
const tile = (name, inappslabel = false) => ({
	name,
	closest: (selector) => (inappslabel && selector === "label[for=realappbarbtu]" ? {} : null),
});

test("the first pinned app, not the Apps button before it", () => {
	const apps = tile("Apps", true);
	assert.strictEqual(first([apps, tile("YouTube"), tile("Netflix")]).name, "YouTube");
});

test("the Apps button when nothing is pinned", () => {
	assert.strictEqual(first([tile("Apps", true)]).name, "Apps");
});

test("nothing when the dock is empty", () => {
	assert.strictEqual(first([]), null);
});
