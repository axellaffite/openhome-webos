// aerialcache.js: which video to keep next, how a cached file is played, and the download script itself,
// run with sh against a temporary folder, with curl and df stubbed.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { load } = require("./load");

const page = load(["backup.js", "aerialcache.js"]);
const fn = (name) => page.run(name);
const DIR = page.run("AERIALDIR");
const LOCK = page.run("AERIAL_LOCK");
const MB = 1048576;

const LIST = [
	{ n: "Caribbean", s: "Apple", u: "https://sylvan.apple.com/itunes-assets/x/comp_C004_C003_PS_v01_SDR_PS_FINAL_20180709_SDR_2K_AVC.mov" },
	{ n: "Fisk Train", s: "Amazon", u: "https://aebcs-cdn-prod-na.services.firetv.amazon.dev/content/FHD/content-af6685b8.mp4" },
	{ n: "Lagon", s: "Community", u: "https://example.org/robinfrcd_reunion_Lagon_1080p_h264.m4v?raw=1" },
];

test("a file name is the URL's last part, and only a plain video name", () => {
	const base = fn("aerialbasename");
	assert.strictEqual(base(LIST[1].u), "content-af6685b8.mp4");
	assert.strictEqual(base(LIST[2].u), "robinfrcd_reunion_Lagon_1080p_h264.m4v");
	assert.strictEqual(base("https://x/evil'name.mp4"), null);
	assert.strictEqual(base("https://x/notes.txt"), null);
});

test("a cached file plays through the app's link to the disk, under its own name", () => {
	const entry = fn("aerialentry")("content-af6685b8.mp4", LIST);
	assert.strictEqual(JSON.stringify(entry), JSON.stringify({ n: "Fisk Train", s: "Amazon", u: "hack" + DIR + "/content-af6685b8.mp4", cached: true }));
	assert.strictEqual(fn("aerialentry")("gone-from-the-list.mp4", LIST).n, "gone-from-the-list");
});

test("the next video to keep is one not on disk yet", () => {
	const pick = fn("aerialcandidate");
	const have = ["content-af6685b8.mp4", "robinfrcd_reunion_Lagon_1080p_h264.m4v"];
	assert.strictEqual(pick(LIST, have, () => 0.99).n, "Caribbean");
	assert.strictEqual(pick(LIST, have.concat([fn("aerialbasename")(LIST[0].u)])), null);
});

test("a name that could escape the shell script is refused", () => {
	assert.throws(() => fn("aerialscript")("https://x/a.mp4", "a'; reboot; '.mp4", "/app"));
});

// ---- the script, for real
function run({ size, written = size, freeMB = 4000, existing = [], locked = false }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "openhome-aerials-"));
	const dir = path.join(root, "aerials");
	const app = path.join(root, "app");
	const lock = path.join(root, "lock");
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.mkdirSync(app);
	fs.mkdirSync(dir);
	if (locked) { fs.mkdirSync(lock); }
	existing.forEach((name, i) => {
		const file = path.join(dir, name);
		fs.writeFileSync(file, Buffer.alloc(1024));
		const when = new Date(Date.now() - (existing.length - i) * 3600 * 1000);
		fs.utimesSync(file, when, when);
	});
	// curl: headers for -I, otherwise `written` bytes into the -o file
	fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh
for a in "$@"; do case "$a" in -sIL) printf 'HTTP/1.1 200 OK\\r\\nContent-Length: ${size}\\r\\n\\r\\n'; exit 0;; esac; done
out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
head -c ${written} /dev/zero > "$out"
`, { mode: 0o755 });
	fs.writeFileSync(path.join(bin, "df"), `#!/bin/sh
echo "Filesystem 1K-blocks Used Available Use% Mounted on"
echo "/dev/mmcblk0p59 6291456 1992294 ${freeMB * 1024} 32% /mnt/lg/appstore"
`, { mode: 0o755 });
	const command = fn("aerialscript")("https://example.org/new.mp4", "new.mp4", app)
		.split(DIR).join(dir)
		.split(LOCK).join(lock)
		.replace(/^nohup /, "")
		.replace(/ >\/dev\/null 2>&1 &$/, "");
	execFileSync("sh", ["-c", command], { env: { ...process.env, PATH: bin + ":" + process.env.PATH } });
	const files = fs.readdirSync(dir).sort();
	return { files, dir, app, lock, root };
}

test("downloads into the folder and links the disk into the app", () => {
	const { files, dir, app } = run({ size: 2 * MB });
	assert.deepStrictEqual(files, ["new.mp4"]);
	assert.strictEqual(fs.statSync(path.join(dir, "new.mp4")).size, 2 * MB);
	assert.strictEqual(fs.readlinkSync(path.join(app, "hack")), "/");
});

test("keeps three: the oldest goes, never the new one", () => {
	const { files } = run({ size: MB, existing: ["old1.mp4", "old2.mov", "old3.m4v"] });
	assert.deepStrictEqual(files, ["new.mp4", "old2.mov", "old3.m4v"]);
});

test("a video over the size limit is not downloaded", () => {
	const { files } = run({ size: (page.run("AERIAL_FILE_MAX_MB") + 1) * MB });
	assert.deepStrictEqual(files, []);
});

test("nothing is downloaded if it would leave less than the free-space margin", () => {
	const margin = page.run("AERIAL_MIN_FREE_MB");
	assert.deepStrictEqual(run({ size: 300 * MB, freeMB: margin + 100 }).files, []);
	assert.deepStrictEqual(run({ size: 2 * MB, freeMB: margin + 100 }).files, ["new.mp4"]);
});

test("a download that stopped short is thrown away", () => {
	assert.deepStrictEqual(run({ size: 2 * MB, written: MB }).files, []);
});

test("a second run while one is going does nothing", () => {
	assert.deepStrictEqual(run({ size: MB, locked: true }).files, []);
});

test("the lock is released when the script ends", () => {
	const { lock } = run({ size: MB });
	assert.strictEqual(fs.existsSync(lock), false);
});
