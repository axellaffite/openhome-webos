// updater.js: reading GitHub's release, comparing versions, and the root shell loop that relaunches the
// launcher after an update.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { load } = require("./load");

const page = load(["about.js", "updater.js"]);
const fn = (name) => page.run(name);
const APP_ID = page.run("ABOUT_APP_ID");
const REPO = page.run("GITHUB_REPO");
const SHA = "a".repeat(64);

function release(overrides = {}) {
	return {
		tag_name: "v1.4.9",
		published_at: "2026-11-16T10:00:00Z",
		assets: [
			{ name: APP_ID + ".manifest.json", browser_download_url: "https://github.com/" + REPO + "/releases/download/v1.4.9/" + APP_ID + ".manifest.json" },
			{ name: APP_ID + "_1.4.9_all.ipk", digest: "sha256:" + SHA, browser_download_url: "https://github.com/" + REPO + "/releases/download/v1.4.9/" + APP_ID + "_1.4.9_all.ipk" },
		],
		...overrides,
	};
}

test("updates come from this fork", () => {
	assert.strictEqual(REPO, "axellaffite/openhome-webos");
});

test("versions compare as numbers, part by part", () => {
	const compare = fn("compareversions");
	assert.strictEqual(compare("1.4.10", "1.4.9"), 1);
	assert.strictEqual(compare("1.4.9", "1.4.10"), -1);
	assert.strictEqual(compare("1.5.0", "1.4.99"), 1);
	assert.strictEqual(compare("2.0.0", "2.0.0"), 0);
	assert.strictEqual(compare("1.4", "1.4.0"), 0);
});

test("a release reduces to its version, package and checksum", () => {
	const parsed = fn("parserelease")(release());
	assert.strictEqual(JSON.stringify(parsed), JSON.stringify({
		version: "1.4.9",
		tag: "v1.4.9",
		date: "2026-11-16T10:00:00Z",
		ipkUrl: "https://github.com/" + REPO + "/releases/download/v1.4.9/" + APP_ID + "_1.4.9_all.ipk",
		sha256: SHA,
	}));
	assert.strictEqual(fn("installable")(parsed), true);
});

test("a release without a checksum is shown but cannot be installed", () => {
	const assets = release().assets.map((asset) => ({ ...asset, digest: undefined }));
	const parsed = fn("parserelease")(release({ assets }));
	assert.strictEqual(parsed.version, "1.4.9");
	assert.strictEqual(parsed.sha256, null);
	assert.strictEqual(fn("installable")(parsed), false);
});

test("a package hosted anywhere but this fork's releases is refused", () => {
	const assets = release().assets.map((asset) => ({ ...asset, browser_download_url: "https://example.com/" + asset.name }));
	const parsed = fn("parserelease")(release({ assets }));
	assert.strictEqual(parsed.ipkUrl, null);
	assert.strictEqual(fn("installable")(parsed), false);
});

test("a tag that is not a plain version is ignored, so it never reaches the shell", () => {
	assert.strictEqual(fn("parserelease")(release({ tag_name: "v1.4.9'; reboot; '" })), null);
	assert.strictEqual(fn("parserelease")(release({ tag_name: "nightly" })), null);
	assert.strictEqual(fn("parserelease")(null), null);
	assert.throws(() => fn("relaunchcommand")("1.4.9; reboot"));
});

// Runs the real command with sh, pointed at a temporary appinfo.json, with luna-send and sleep stubbed.
function runrelaunch(installedversion) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openhome-"));
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin);
	const launched = path.join(dir, "launched");
	fs.writeFileSync(path.join(bin, "luna-send"), "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + launched + "\n", { mode: 0o755 });
	fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\n", { mode: 0o755 });
	fs.writeFileSync(path.join(dir, "appinfo.json"), '{\n  "id": "' + APP_ID + '",\n  "version": "' + installedversion + '",\n}\n');
	const command = fn("relaunchcommand")("1.4.9")
		.split(page.run("UPDATE_APP_DIR")).join(dir)
		.replace(/^nohup /, "")
		.replace(/ >\/dev\/null 2>&1 &$/, "");
	execFileSync("sh", ["-c", command], { env: { ...process.env, PATH: bin + ":" + process.env.PATH } });
	return fs.existsSync(launched) ? fs.readFileSync(launched, "utf8").trim().split("\n") : null;
}

test("the relaunch loop launches OpenHome once the new version is on disk", () => {
	const args = runrelaunch("1.4.9");
	assert.deepStrictEqual(args, ["-n", "1", "luna://com.webos.service.applicationManager/launch", '{"id":"' + APP_ID + '"}']);
});

test("the relaunch loop gives up without launching anything if the install never lands", () => {
	assert.strictEqual(runrelaunch("1.4.8"), null);
});

// The id the updater installs and relaunches must be the package's own, and nothing that ships or deploys
// may still name the old one: a leftover would relaunch, replace Home with, or deploy to an app that is gone.
test("the package id is the same everywhere", () => {
	const root = path.join(__dirname, "..");
	const appinfo = JSON.parse(fs.readFileSync(path.join(root, "src", "appinfo.json"), "utf8"));
	assert.strictEqual(appinfo.id, "io.github.axellaffite.openhome");
	assert.strictEqual(APP_ID, appinfo.id);
	// git grep exits 1 when nothing matches, which is the passing case
	const found = spawnSync("git", ["grep", "--untracked", "-l", "io.github.devic021.openhome", "--", "src", "scripts", ".github", "*.sh", "*.js", ":!test"], { cwd: root, encoding: "utf8" });
	assert.strictEqual(found.stdout.trim(), "");
});

test("the About page credits the project this fork grew out of", () => {
	assert.strictEqual(page.run("UPSTREAM_REPO"), "devic021/openhome-webos");
});
