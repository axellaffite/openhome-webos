// pickneighbor() in dpad.js: which item an arrow key moves the focus to. Pure geometry.
const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./load");

const page = load(["dpad.js"]);
const pick = (from, candidates, key) => page.run("pickneighbor")(from, candidates, key);
const KEY = { left: 37, up: 38, right: 39, down: 40 };

// a grid of 100x100 tiles, 20 apart: tile(column, row)
const tile = (col, row) => ({ left: col * 120, top: row * 120, width: 100, height: 100 });

test("Right goes to the next tile in the same row", () => {
	const row = [tile(1, 0), tile(2, 0), tile(3, 0)];
	assert.strictEqual(pick(tile(0, 0), row, KEY.right), 0);
});

test("Left goes to the previous tile in the same row", () => {
	const row = [tile(0, 0), tile(1, 0), tile(3, 0)];
	assert.strictEqual(pick(tile(2, 0), row, KEY.left), 1);
});

test("Down goes to the tile underneath, not one further along the row below", () => {
	const below = [tile(0, 1), tile(1, 1), tile(2, 1)];
	assert.strictEqual(pick(tile(1, 0), below, KEY.down), 1);
});

test("Up goes to the tile above", () => {
	const above = [tile(0, 0), tile(1, 0)];
	assert.strictEqual(pick(tile(1, 1), above, KEY.up), 1);
});

test("an item in the same row is not 'below'", () => {
	assert.strictEqual(pick(tile(0, 0), [tile(1, 0)], KEY.down), -1);
});

test("nothing that way: -1", () => {
	assert.strictEqual(pick(tile(3, 0), [tile(0, 0), tile(1, 0), tile(2, 0)], KEY.right), -1);
	assert.strictEqual(pick(tile(0, 0), [tile(1, 0)], KEY.left), -1);
});

test("a tile in line wins over a closer one off to the side", () => {
	// straight right but 2 columns away, against diagonally down-right 1 column away
	const inline = tile(2, 0);
	const diagonal = { left: 120, top: 70, width: 100, height: 100 };
	assert.strictEqual(pick(tile(0, 0), [diagonal, inline], KEY.right), 1);
});

test("a neighbour overlapped by less than the edge tolerance still counts as beyond", () => {
	// the focused box ends at 121 and the neighbour starts at 120: 1 px of overlap, within the
	// 2 px EDGE_TOLERANCE, so Right still reaches it
	const from = { left: 0, top: 0, width: 121, height: 100 };
	assert.strictEqual(pick(from, [tile(1, 0)], KEY.right), 0);
});

test("a neighbour overlapped by more than the tolerance is not beyond", () => {
	const from = { left: 0, top: 0, width: 130, height: 100 };
	assert.strictEqual(pick(from, [tile(1, 0)], KEY.right), -1);
});
