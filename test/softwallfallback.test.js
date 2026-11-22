// softwall.js covers the wallpaper while an input preview holds the video plane. When the wallpaper
// itself cannot be decoded here, something else must cover it: a stand-in Apple aerial (cached
// ones first), and failing that a still photograph - never nothing.
const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./load");

const AMAZON = "https://aebcs-cdn-prod-na.services.firetv.amazon.dev/content/FHD/content-1.mp4";
const APPLE = (name) => "https://sylvan.apple.com/itunes-assets/x/" + name + "_SDR_2K_AVC.mov";

function page({ decoder = true, mode = "aerials", cached = [], works = () => false } = {}) {
	const tried = [];
	const loaded = load(["softwall.js"], {
		VideoDecoder: decoder ? function () {} : undefined,
		EncodedVideoChunk: decoder ? function () {} : undefined,
		location: { href: "file:///app/index.html" },
		URL,
		aerials: [{ u: APPLE("A") }, { u: APPLE("B") }, { u: AMAZON }, { u: "https://sylvan.apple.com/x/C_HEVC.mov" }],
		wallpapers: ["one.jpg"],
		bgmode: mode,
		AERIALDIR: "/media/developer/aerials",
		aerialstate: () => ({ files: cached }),
		triedlog: tried,
	});
	loaded.global.works = works;
	loaded.run("swtryvideo=async (url,exact)=>{triedlog.push((exact?'exact ':'')+url);return works(url);}");
	loaded.run("swtrystill=async ()=>{triedlog.push('still');return true;}");
	return { loaded, tried, candidates: (source) => loaded.run("swcandidates")(source, loaded.run("swsession")) };
}

test("a decodable wallpaper is carried on as itself", async () => {
	const { tried, candidates } = page({ works: () => true });
	assert.strictEqual(await candidates(APPLE("A")), true);
	assert.deepStrictEqual(tried, ["exact " + APPLE("A")]);
});

test("a Fire TV aerial skips straight to a stand-in, the cached one first", async () => {
	const { tried, candidates } = page({ cached: ["A_SDR_2K_AVC.mov"], works: () => true });
	assert.strictEqual(await candidates(AMAZON), true);
	assert.deepStrictEqual(tried, ["file:///app/hack/media/developer/aerials/A_SDR_2K_AVC.mov"]);
});

test("stand-ins are streamed over http, and only H.264 Apple aerials qualify", async () => {
	const { tried, candidates } = page();
	await candidates(AMAZON);
	const videos = tried.filter((each) => each !== "still");
	assert.ok(videos.length > 0);
	videos.forEach((url) => assert.match(url, /^http:\/\/sylvan\.apple\.com\/.*_AVC\.mov$/));
});

test("when no video works, a still photograph covers the wallpaper", async () => {
	const { tried, candidates } = page();
	assert.strictEqual(await candidates(AMAZON), true);
	assert.strictEqual(tried[tried.length - 1], "still");
});

test("without a software decoder (old webOS) the still is used at once", async () => {
	const { tried, candidates } = page({ decoder: false });
	assert.strictEqual(await candidates(APPLE("A")), true);
	assert.deepStrictEqual(tried, ["still"]);
});

test("the built-in slideshow is covered by one of its own photographs", async () => {
	const { tried, candidates } = page({ mode: "local" });
	await candidates("file:///app/access/wallpaper/loop.mp4");
	assert.deepStrictEqual(tried, ["still"]);
});

test("the stand-in that worked is tried first next time", async () => {
	// works on the first try, whichever random online pick that was
	const { loaded, tried, candidates } = page({ works: () => true });
	await candidates(AMAZON);
	const good = loaded.run("swgoodstandin");
	assert.strictEqual(good, tried[0]);
	tried.length = 0;
	await candidates(AMAZON);
	assert.strictEqual(tried[0], good);
});
