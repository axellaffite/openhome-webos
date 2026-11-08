// "All apps" order (folders.js): A to Z by the name shown, ignoring case and accents, numbers as
// numbers. The collator follows the TV's locale; these use English, which the TV in question
// falls back to for the comparisons that matter here.
const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./load");

const page = load(["folders.js"]);
const sort = (names) => page.run("alphabetical")(names, (n) => n);

test("A to Z, whatever the case", () => {
	assert.deepStrictEqual(sort(["Netflix", "apple TV", "Deezer", "ARTE"]), ["apple TV", "ARTE", "Deezer", "Netflix"]);
});

test("accents sort with their letter", () => {
	assert.deepStrictEqual(sort(["Crunchyroll", "Caméra", "CANAL+"]), ["Caméra", "CANAL+", "Crunchyroll"]);
});

test("numbers compare as numbers", () => {
	assert.deepStrictEqual(sort(["App 10", "App 2", "App 1"]), ["App 1", "App 2", "App 10"]);
});

test("the list it was given is left alone", () => {
	const names = ["b", "a"];
	sort(names);
	assert.deepStrictEqual(names, ["b", "a"]);
});
