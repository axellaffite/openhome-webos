// The app manager's carrying rules (amcarry in appmanager.js): one row of apps, the first `split`
// of them on the dock, at most DOCK_APPS of those. Carrying an app across the separator moves the
// separator, not the app; carrying it into a full dock pushes the dock's last app out.
const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./load");

function manager(ids, split, focus, dockapps = 10) {
	const page = load(["dpad.js", "appmanager.js"]);
	page.run(`var DOCK_APPS=${dockapps};`);
	page.run(`amstate={items:${JSON.stringify(ids.map((id) => ({ id })))},split:${split},focus:${focus},moving:{}};`);
	return {
		carry: (dir) => page.run(`amcarry(${dir})`),
		// as JSON: objects built in the sandbox have its prototypes, which deepStrictEqual rejects
		state: () => JSON.parse(page.run("JSON.stringify({ids: amstate.items.map((a) => a.id), split: amstate.split, focus: amstate.items[amstate.focus].id})")),
	};
}

test("Right inside the dock swaps with the neighbour", () => {
	const m = manager(["a", "b", "c", "x", "y"], 3, 0);
	m.carry(1);
	assert.deepStrictEqual(m.state(), { ids: ["b", "a", "c", "x", "y"], split: 3, focus: "a" });
});

test("Right on the dock's last app takes it off the dock without moving it", () => {
	const m = manager(["a", "b", "c", "x", "y"], 3, 2);
	m.carry(1);
	assert.deepStrictEqual(m.state(), { ids: ["a", "b", "c", "x", "y"], split: 2, focus: "c" });
});

test("Left on the first app off the dock puts it on the dock when there is room", () => {
	const m = manager(["a", "b", "c", "x", "y"], 3, 3);
	m.carry(-1);
	assert.deepStrictEqual(m.state(), { ids: ["a", "b", "c", "x", "y"], split: 4, focus: "x" });
});

test("Left into a full dock takes the last place and pushes that app out", () => {
	const m = manager(["a", "b", "c", "x", "y"], 3, 3, 3);
	m.carry(-1);
	assert.deepStrictEqual(m.state(), { ids: ["a", "b", "x", "c", "y"], split: 3, focus: "x" });
});

test("Right off the dock swaps with the neighbour", () => {
	const m = manager(["a", "b", "c", "x", "y"], 3, 3);
	m.carry(1);
	assert.deepStrictEqual(m.state(), { ids: ["a", "b", "c", "y", "x"], split: 3, focus: "x" });
});

test("the ends of the row do not move", () => {
	const first = manager(["a", "b", "x"], 2, 0);
	first.carry(-1);
	assert.deepStrictEqual(first.state(), { ids: ["a", "b", "x"], split: 2, focus: "a" });
	const last = manager(["a", "b", "x"], 2, 2);
	last.carry(1);
	assert.deepStrictEqual(last.state(), { ids: ["a", "b", "x"], split: 2, focus: "x" });
});

test("a round trip across the separator gives back the same row", () => {
	const m = manager(["a", "b", "c", "x", "y"], 3, 2);
	m.carry(1);          // c off the dock
	m.carry(-1);         // and back on
	assert.deepStrictEqual(m.state(), { ids: ["a", "b", "c", "x", "y"], split: 3, focus: "c" });
});
