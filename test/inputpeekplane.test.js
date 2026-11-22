// inputpeek.js puts the HDMI preview on the TV's second video plane (SUB0), so the wallpaper keeps
// the main one and nothing is decoded in software. These pin down the calls to the video output
// service: the port numbering, the window on the service's 1080p grid, and the release.
const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./load");

function page({ fail = null, width = 1920, height = 1080 } = {}) {
	const calls = [];
	const loaded = load(["inputpeek.js"], {
		onfocuschange() {},
		addEventListener() {},
		document: { addEventListener() {}, getElementById: () => null },
		innerWidth: width,
		innerHeight: height,
		// a bus connection: answers right away, and stays listed so the test can see none was dropped
		PalmServiceBridge: function () {
			this.call = (url, text) => {
				const method = url.replace("luna://com.webos.service.videooutput/", "");
				calls.push({ method, payload: JSON.parse(text) });
				const answer = method === fail ? { returnValue: false, errorMessage: "nope" } : { returnValue: true };
				setImmediate(() => this.onservicecallback(JSON.stringify(answer)));
			};
		},
		setImmediate,
	});
	return { run: loaded.run, calls: () => JSON.parse(JSON.stringify(calls)) };
}

const screen = (left, top, width, height) => ({ getBoundingClientRect: () => ({ left, top, width, height }) });

test("HDMI 1 is wired to SUB0 as source port 3, in a window over the preview's screen", async () => {
	const { run, calls } = page();
	await run("peekplaneon")(1, screen(400.4, 300, 576, 324));
	assert.deepStrictEqual(calls().map((each) => each.method),
		["register", "connect", "display/setDisplayWindow", "blankVideo"]);
	const connect = calls()[1].payload;
	assert.strictEqual(connect.sink, "SUB0");
	assert.strictEqual(connect.source, "HDMI");
	assert.strictEqual(connect.sourcePort, 3);
	assert.deepStrictEqual(calls()[2].payload.displayOutput, { x: 400, y: 300, width: 576, height: 324 });
	assert.strictEqual(run("peekplane"), true);
});

test("the window is given on the service's 1920x1080 grid whatever the page size", () => {
	const { run } = page({ width: 1280, height: 720 });
	assert.strictEqual(JSON.stringify(run("peekplanewindow")(screen(640, 360, 320, 180))),
		JSON.stringify({ x: 960, y: 540, width: 480, height: 270 }));
});

test("a refused call fails the attempt, so the fallback can take over", async () => {
	const { run } = page({ fail: "connect" });
	await assert.rejects(run("peekplaneon")(1, screen(0, 0, 10, 10)), /connect: nope/);
	assert.strictEqual(run("peekplane"), true, "still marked, so the half-made connection is undone");
});

test("letting go disconnects and unregisters, once", async () => {
	const { run, calls } = page();
	await run("peekplaneon")(2, screen(0, 0, 10, 10));
	await run("peekplaneoff")();
	await run("peekplaneoff")();
	const tail = calls().slice(4).map((each) => each.method);
	assert.deepStrictEqual(tail, ["disconnect", "unregister"]);
	assert.strictEqual(run("peekplane"), false);
});

test("a forced release clears a leftover connection, and never throws", async () => {
	const { run, calls } = page({ fail: "disconnect" });
	await run("peekplaneoff")(true);
	assert.deepStrictEqual(calls().map((each) => each.method), ["disconnect", "unregister"]);
});

test("the bus connections are kept while the plane is ours, and let go after", async () => {
	// the service drops the picture when the connection that made it is closed
	const { run } = page();
	await run("peekplaneon")(1, screen(0, 0, 10, 10));
	assert.strictEqual(run("peekbridges.length"), 4);
	await run("peekplaneoff")();
	assert.strictEqual(run("peekbridges.length"), 0);
});

// everything on the page is drawn over the video planes, so the page gets a hole where the picture is
test("the page's content gets a hole cut exactly where the picture is, and closes it after", () => {
	const { run } = page();
	const content = { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
	run("document").getElementById = (id) => (id === "prefetchmaindiv" ? content : null);
	run("peekhole")({ left: 146.4, top: 681, width: 576, height: 324 });
	assert.match(content.style.clipPath, /^polygon\(evenodd, /);
	assert.match(content.style.clipPath, /146px 681px, 722px 681px, 722px 1005px, 146px 1005px, 146px 681px\)$/);
	run("peekhole")(null);
	assert.strictEqual(content.style.clipPath, "");
});
