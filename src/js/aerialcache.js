//SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the OpenHome contributors
// A few aerials kept on the TV's own disk, so the wallpaper appears at once when the launcher opens.
//
// Why: the Online source streams a random aerial at every launch, and those are big files (23 to
// 477 MB, about 200 MB typically, measured on a sample of the list), so the wallpaper only showed
// once the start of one had arrived. Now the first video after a launch plays from disk; the ones
// after it stream as before.
//
// What it costs the TV: one download a day of about 200 MB, written to the eMMC. Reading costs no
// wear. On the development TV (Samsung AJTD4R, 16 GB, life_time 0x01 0x01 = under 10% used, 4.1 GB
// free on this partition) that is about 73 GB a year, against the 16 - 48 TB a chip like this
// typically takes: 0.15 - 0.5% of its life a year. `cat /sys/block/mmcblk0/device/life_time` is the
// chip's own wear counter, in steps of 10%, for anyone who wants to watch it.
//
// The limits below are what keeps it small: at most AERIAL_KEEP files and AERIAL_MAX_MB in all,
// nothing bigger than AERIAL_FILE_MAX_MB, and no download that would leave less than
// AERIAL_MIN_FREE_MB free (the same partition holds installed apps). The download is rate-limited
// so it does not starve the video that is streaming at the same time.
//
// The work is one detached shell script run through the root service: a download can take
// minutes, longer than a luna call should wait, and it must survive the launcher being closed.

const AERIALDIR="/media/developer/aerials";
const AERIAL_KEEP=3;
const AERIAL_MAX_MB=1536;
const AERIAL_FILE_MAX_MB=600;
const AERIAL_MIN_FREE_MB=2048;
const AERIAL_RATE="4M";                     // curl --limit-rate: 200 MB in under a minute, a fraction of the line
const AERIAL_EVERY_MS=24*60*60*1000;        // one new video a day
const AERIAL_SYNC_DELAY_MS=15*1000;         // read what is on disk once root is known
const AERIAL_FIRST_DELAY_MS=3*60*1000;      // and download only after the launch's own streaming has settled
const AERIAL_LIST_KEY="openlauncher.aerialcache";   // {at, files}: last download attempt, files oldest first
const AERIAL_NAME=/^[A-Za-z0-9._-]+\.(mp4|mov|m4v)$/;   // also what keeps a name safe inside the shell script
const AERIAL_LOCK="/tmp/openhome-aerials.lock";     // /tmp is emptied at boot, so a power cut cannot leave it stuck

let aerialbusy=false;

// ---- pure parts, tested in test/aerialcache.test.js

function aerialbasename(url) {
	const name=String(url).split("?")[0].split("/").pop();
	return AERIAL_NAME.test(name)?name:null;
}

function aerialentry(name,list) {
	const known=(list || []).filter((entry) => aerialbasename(entry.u)===name)[0];
	return {
		n:known?known.n:name.replace(/\.[^.]+$/,""),
		s:known?known.s:"",
		u:"hack"+AERIALDIR+"/"+encodeURIComponent(name),
		cached:true
	};
}

// the next video to keep: one from the list that is not on disk yet
function aerialcandidate(list,have,random) {
	const pick=(random || Math.random);
	const fresh=(list || []).filter((entry) => {
		const name=aerialbasename(entry.u);
		return name && (have || []).indexOf(name)===-1;
	});
	return fresh.length?fresh[Math.floor(pick()*fresh.length)]:null;
}

// the detached script: check the size and the free space, download, verify, then drop the oldest
function aerialscript(url,name,appfolder) {
	if(!AERIAL_NAME.test(name)){ throw new Error("bad name "+name); }
	const filemax=AERIAL_FILE_MAX_MB*1048576;
	const maxkb=AERIAL_MAX_MB*1024;
	const pattern="'^"+AERIAL_NAME.source.replace(/^\^|\$$/g,"").replace(/\\\./g,"[.]")+"$'";
	const steps=[
		"mkdir "+AERIAL_LOCK+" 2>/dev/null || exit 0",
		"trap 'rmdir "+AERIAL_LOCK+"' EXIT",
		"mkdir -p "+AERIALDIR+" && cd "+AERIALDIR+" || exit 0",
		// the page reaches the disk through this link; it is made at start-up, but not on every set-up
		"[ -e "+shellquote(appfolder+"/hack")+" ] || ln -s / "+shellquote(appfolder+"/hack"),
		"size=$(curl -sIL -m 30 "+shellquote(url)+" | tr -d '\\r' | awk 'tolower($1)==\"content-length:\"{n=$2} END{print n+0}')",
		"[ \"$size\" -gt 0 ] && [ \"$size\" -le "+filemax+" ] || exit 0",
		"free=$(df -k . | tail -1 | awk '{print $(NF-2)}')",
		"[ $((free/1024 - size/1048576)) -ge "+AERIAL_MIN_FREE_MB+" ] || exit 0",
		"curl -sL -m 3600 --limit-rate "+AERIAL_RATE+" -o .part "+shellquote(url)+" || { rm -f .part; exit 0; }",
		"[ \"$(wc -c < .part)\" -eq \"$size\" ] || { rm -f .part; exit 0; }",
		"mv .part "+shellquote(name),
		// oldest first, never the one just added
		"while [ \"$(ls -1 | grep -cE "+pattern+")\" -gt "+AERIAL_KEEP+" ] || [ \"$(du -sk . | cut -f1)\" -gt "+maxkb+" ]; do "+
			"old=$(ls -1tr | grep -E "+pattern+" | head -n 1); [ -z \"$old\" ] || [ \"$old\" = "+shellquote(name)+" ] && break; rm -f \"$old\"; done"
	];
	return "nohup sh -c "+shellquote(steps.join("\n"))+" >/dev/null 2>&1 &";
}

// ---- state kept between launches

function aerialstate() {
	try {
		const saved=JSON.parse(localStorage.getItem(AERIAL_LIST_KEY)) || {};
		return {at:saved.at || 0,files:Array.isArray(saved.files)?saved.files.filter((f) => AERIAL_NAME.test(f)):[]};
	} catch(e) {
		return {at:0,files:[]};
	}
}

function aerialsave(state) {
	try { localStorage.setItem(AERIAL_LIST_KEY,JSON.stringify(state)); } catch(e) {}
}

function aerialcacheon() {
	return typeof prefs!=="undefined" && prefs.aerialCache!==false;
}

// background.js asks this for the first video after a launch: one from disk, or null to stream
function cachedaerial() {
	if(!aerialcacheon()){ return null; }
	const files=aerialstate().files;
	if(!files.length){ return null; }
	const name=files[Math.floor(Math.random()*files.length)];
	return aerialentry(name,typeof aerials!=="undefined"?aerials:[]);
}

// ---- keeping it filled

// what is really on disk, oldest first: a download may have finished since the last launch
async function aerialsync() {
	if(typeof rooted==="undefined" || !rooted || typeof execasroot!=="function"){ return aerialstate().files; }
	const result=await execasroot("ls -1tr "+AERIALDIR+" 2>/dev/null");
	const files=String((result && result.stdoutString) || "").split("\n").map((line) => line.trim()).filter((line) => AERIAL_NAME.test(line));
	aerialsave({at:aerialstate().at,files:files});
	return files;
}

async function aerialrefresh() {
	if(aerialbusy || typeof rooted==="undefined" || !rooted || typeof execasroot!=="function"){ return; }
	aerialbusy=true;
	try {
		if(!aerialcacheon()){
			// switched off: give the space back, once
			if(aerialstate().files.length){
				await execasroot("rm -rf "+AERIALDIR);
				aerialsave({at:0,files:[]});
			}
			return;
		}
		const have=await aerialsync();
		if(typeof wantedsource==="function" && wantedsource()!=="online"){ return; }
		const state=aerialstate();
		if(have.length>=AERIAL_KEEP && Date.now()-state.at<AERIAL_EVERY_MS){ return; }
		if(have.length<AERIAL_KEEP && Date.now()-state.at<AERIAL_EVERY_MS/24){ return; }   // filling up: one an hour at most
		const entry=aerialcandidate(typeof aerials!=="undefined"?aerials:[],have);
		if(!entry){ return; }
		// Apple's certificate chain is not trusted everywhere; the video is the same over http
		const url=entry.u.replace(/^https:\/\/sylvan\.apple\.com\//,"http://sylvan.apple.com/");
		await execasroot(aerialscript(url,aerialbasename(entry.u),typeof appdir!=="undefined"?appdir:""));
		aerialsave({at:Date.now(),files:have});
	} catch(e) {
	} finally {
		aerialbusy=false;
	}
}

document.addEventListener("DOMContentLoaded",() => {
	setTimeout(() => { aerialsync().catch(() => {}); },AERIAL_SYNC_DELAY_MS);
	setTimeout(() => { aerialrefresh(); },AERIAL_FIRST_DELAY_MS);
	setInterval(() => { aerialrefresh(); },AERIAL_EVERY_MS/24);
});
