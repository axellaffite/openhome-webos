// softwall.js reads the wallpaper's bytes for the input preview. The page asks for them itself with a
// Range request - no root needed - and only falls back to the root service when that fails on a
// rooted TV. A server that ignores the Range header must not get to send the whole video.
const test = require("node:test");
const assert = require("node:assert");
const { load } = require("./load");

const AERIAL = "https://sylvan.apple.com/itunes-assets/a.mov";

// an XMLHttpRequest that answers with `reply(url, range)` -> {status, size} or "error"
function fakexhr(reply, log) {
	return class {
		open(method, url) { this.url = url; }
		setRequestHeader(name, value) { this.range = value; }
		abort() { this.aborted = true; this.onabort(); }
		send() {
			log.push({ url: this.url, range: this.range });
			const answer = reply(this.url, this.range);
			setImmediate(() => {
				if (answer === "error") { this.onerror(); return; }
				this.onprogress({ loaded: answer.size });
				if (this.aborted) { return; }
				this.status = answer.status;
				this.response = new ArrayBuffer(answer.size);
				this.onload();
			});
		}
	};
}

function page(reply, { root = false } = {}) {
	const log = [];
	const shell = [];
	const loaded = load(["softwall.js"], {
		XMLHttpRequest: fakexhr(reply, log),
		setImmediate,
		rooted: root,
		execasroot: () => Promise.resolve({}),
		wallsh: (command) => { shell.push(command); return Promise.resolve({}); },
		shellquote: (text) => "'" + text + "'",
		appdir: "/app",
	});
	return { read: loaded.run("swread"), log, shell };
}

test("an aerial is read by the page itself, over http, with a Range header", async () => {
	const { read, log, shell } = page(() => ({ status: 206, size: 16 }));
	const bytes = await read(AERIAL, 100, 115);
	assert.strictEqual(bytes.byteLength, 16);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(log)), [
		{ url: "http://sylvan.apple.com/itunes-assets/a.mov", range: "bytes=100-115" },
	]);
	assert.deepStrictEqual(shell, []);
});

test("a server that ignores the range is cut off, not downloaded whole", async () => {
	const { read } = page(() => ({ status: 200, size: 200 * 1024 * 1024 }));
	await assert.rejects(read(AERIAL, 0, 15), /range ignored/);
});

test("a local file answering with exactly the range is accepted", async () => {
	const { read } = page(() => ({ status: 0, size: 16 }));
	const bytes = await read("file:///media/usb/wall.mp4", 0, 15);
	assert.strictEqual(bytes.byteLength, 16);
});

test("without root a failed read is a failure: there is nothing to fall back on", async () => {
	const { read, shell } = page(() => "error");
	await assert.rejects(read(AERIAL, 0, 15), /could not read/);
	assert.deepStrictEqual(shell, []);
});

test("with root a failed read falls back to the root service, and stays there for that video", async () => {
	const { read, log, shell } = page(() => "error", { root: true });
	// the root path then reads its file back through a plain XHR, which this fake also fails:
	// what matters here is that the root service was asked
	await assert.rejects(read(AERIAL, 0, 15));
	assert.ok(shell.some((command) => command.includes("curl") && command.includes("-r 0-15")));
	const asked = log.length;
	await assert.rejects(read(AERIAL, 16, 31));
	assert.ok(!log.slice(asked).some((each) => each.range), "no second direct try for the same video");
});
