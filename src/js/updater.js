//SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the OpenHome contributors
// Updates from this fork's GitHub releases: a quiet check at most once a day, and an Update button in
// Settings > About that installs the new package and brings the launcher back.
//
// The install goes through the Homebrew Channel's root service (org.webosbrew.hbchannel.service/install).
// It downloads the .ipk itself, refuses it unless its SHA-256 matches the one given, and installs it with
// the TV's own installer. That installer kills the running app - this page - halfway through, so the
// relaunch cannot come from here: a small shell loop is started through the same root service first, and
// it outlives the page. It waits for the new version to land on disk, then launches OpenHome again. If the
// install fails, the version never appears, and the loop gives up without launching anything.
//
// Without root there is no installer to call, so the check still runs and only says a release is out.

const UPDATE_API="https://api.github.com/repos/"+GITHUB_REPO+"/releases/latest";   // "latest" skips drafts and pre-releases
const UPDATE_DOWNLOADS="https://github.com/"+GITHUB_REPO+"/releases/download/";      // the only place a package is accepted from
const UPDATE_CHECK_KEY="openlauncher.updatecheck";   // {at, version} of the last automatic check
const UPDATE_EVERY_MS=24*60*60*1000;
const UPDATE_FIRST_DELAY_MS=90*1000;     // after start-up, so the check never competes with the first paint at power-on
const UPDATE_WATCH_SECONDS=600;          // how long the relaunch loop waits for the new version before giving up
const UPDATE_APP_DIR="/media/developer/apps/usr/palm/applications/"+ABOUT_APP_ID;
const VERSION_FORMAT=/^\d{1,4}\.\d{1,4}\.\d{1,4}$/;   // webOS package versions; also what keeps the shell command below safe
const SHA256_FORMAT=/^[0-9a-f]{64}$/;

// idle | checking | current | available | error | installing | failed
let update={state:"idle"};

// ---- pure parts, tested in test/updater.test.js

// -1, 0 or 1, comparing "1.4.10" with "1.4.9" as numbers, part by part
function compareversions(a,b) {
	const left=String(a).split(".").map((part) => parseInt(part,10) || 0);
	const right=String(b).split(".").map((part) => parseInt(part,10) || 0);
	for(let i=0;i<Math.max(left.length,right.length);i++){
		const diff=(left[i] || 0)-(right[i] || 0);
		if(diff!==0){ return diff>0?1:-1; }
	}
	return 0;
}

// the GitHub API's release, reduced to what installing it needs, or null if it cannot be installed safely.
// The package's SHA-256 comes from the asset's "digest" field, which GitHub computes on upload.
function parserelease(json) {
	if(!json || typeof json.tag_name!=="string"){ return null; }
	const version=json.tag_name.replace(/^v/,"");
	if(!VERSION_FORMAT.test(version)){ return null; }
	const assets=Array.isArray(json.assets)?json.assets:[];
	const ipk=assets.filter((asset) => asset && typeof asset.name==="string" && asset.name.indexOf(ABOUT_APP_ID+"_")===0 && /\.ipk$/.test(asset.name))[0];
	const url=ipk && typeof ipk.browser_download_url==="string"?ipk.browser_download_url:"";
	const digest=ipk && typeof ipk.digest==="string"?ipk.digest.replace(/^sha256:/,"").toLowerCase():"";
	return {
		version:version,
		tag:json.tag_name,
		date:json.published_at || null,
		ipkUrl:url.indexOf(UPDATE_DOWNLOADS)===0?url:null,
		sha256:SHA256_FORMAT.test(digest)?digest:null
	};
}

function installable(release) {
	return !!(release && release.ipkUrl && release.sha256);
}

// the root shell loop that relaunches OpenHome once `version` is installed. The version is checked against
// VERSION_FORMAT before it gets here: it comes from the network and ends up inside a shell command.
function relaunchcommand(version) {
	if(!VERSION_FORMAT.test(version)){ throw new Error("bad version "+version); }
	const tries=Math.ceil(UPDATE_WATCH_SECONDS/5);
	const loop="i=0; while [ $i -lt "+tries+" ]; do "+
		"grep -q \"\\\"version\\\": *\\\""+version+"\\\"\" "+UPDATE_APP_DIR+"/appinfo.json 2>/dev/null && "+
		"{ sleep 3; luna-send -n 1 luna://com.webos.service.applicationManager/launch \"{\\\"id\\\":\\\""+ABOUT_APP_ID+"\\\"}\" </dev/null; exit 0; }; "+
		"i=$((i+1)); sleep 5; done";
	return "nohup sh -c '"+loop+"' >/dev/null 2>&1 &";
}

// ---- checking

function rememberedcheck() {
	try { return JSON.parse(localStorage.getItem(UPDATE_CHECK_KEY)) || {}; } catch(e) { return {}; }
}

function remembercheck(version) {
	try { localStorage.setItem(UPDATE_CHECK_KEY,JSON.stringify({at:Date.now(),version:version})); } catch(e) {}
}

function updaterender() {
	if(typeof settingstab!=="undefined" && settingstab==="about" && typeof renderpane==="function"){ renderpane(); }
}

async function checkforupdate() {
	if(update.state==="checking" || update.state==="installing"){ return update; }
	update={state:"checking"};
	updaterender();
	try {
		const response=await fetch(UPDATE_API,{headers:{Accept:"application/vnd.github+json"}});
		if(!response.ok){ throw new Error("HTTP "+response.status); }
		const release=parserelease(await response.json());
		if(!release){ throw new Error("no usable release"); }
		update={state:compareversions(release.version,APP_RELEASE)>0?"available":"current",release:release};
	} catch(e) {
		update={state:"error",error:String(e && e.message || e)};
	}
	updaterender();
	return update;
}

// once a day, in the background; a toast the first time a given version is seen
async function autocheck() {
	const last=rememberedcheck();
	if(last.at && Date.now()-last.at<UPDATE_EVERY_MS){ return; }
	const result=await checkforupdate();
	if(result.state==="error"){ return; }
	const version=result.release.version;
	if(result.state==="available" && last.version!==version && typeof toasty==="function"){
		toasty("OpenHome v"+version+t(" is available: Settings > About"));
	}
	remembercheck(version);
}

// ---- installing

// a luna call that answers more than once (the installer reports each step); onmessage gets every answer
function lunasubscribe(url,payload,onmessage) {
	const bridge=new window.PalmServiceBridge();
	bridge.onservicecallback=(raw) => {
		let message;
		try { message=JSON.parse(raw); } catch(e) { message={returnValue:false,errorText:String(raw)}; }
		onmessage(message);
	};
	bridge.call(url,JSON.stringify(payload));
	return bridge;
}

let updatebridge=null;   // kept referenced so the subscription is not collected while it runs

async function installupdate() {
	const release=update.release;
	if(update.state!=="available" || !rooted || !installable(release)){ return; }
	update={state:"installing",release:release,step:t("Starting...")};
	updaterender();
	// the new package starts with an empty localStorage; the file is what it restores from
	if(typeof writebackupnow==="function"){ await writebackupnow(); }
	try {
		await execasroot(relaunchcommand(release.version));
	} catch(e) {
		update={state:"failed",release:release,error:t("the root service did not answer")};
		updaterender();
		return;
	}
	updatebridge=lunasubscribe("luna://org.webosbrew.hbchannel.service/install",
		{ipkUrl:release.ipkUrl,ipkHash:release.sha256,id:ABOUT_APP_ID,subscribe:true},
		(message) => {
			if(message.returnValue===false || message.errorText){
				update={state:"failed",release:release,error:message.errorText || t("unknown error")};
				updatebridge=null;
			} else if(message.statusText){
				const percent=typeof message.progress==="number"?" "+Math.round(message.progress)+"%":"";
				update={state:"installing",release:release,step:message.statusText+percent};
			}
			updaterender();
		});
}

// ---- what Settings > About shows

function updatetext() {
	const release=update.release;
	if(update.state==="checking"){ return t("Checking..."); }
	if(update.state==="error"){ return t("GitHub unreachable"); }
	if(update.state==="current"){ return "v"+APP_RELEASE+t(" (this one), up to date"); }
	if(update.state==="available"){
		if(!installable(release)){ return release.tag+t(" is out, but its package is missing"); }
		return release.tag+t(" is out (you have ")+"v"+APP_RELEASE+")"+(rooted?"":t(", install it from the Homebrew Channel"));
	}
	if(update.state==="installing"){ return t("Installing ")+release.tag+": "+update.step; }
	if(update.state==="failed"){ return t("Update failed: ")+update.error; }
	return t("Not checked");
}

// the button next to "Check for updates", only when there is something it can install
function updatebutton() {
	if(update.state!=="available" || !rooted || !installable(update.release)){ return null; }
	return optionbutton(t("Update to ")+update.release.tag,false,() => installupdate(),"download");
}

document.addEventListener("DOMContentLoaded",() => {
	setTimeout(() => { autocheck(); },UPDATE_FIRST_DELAY_MS);
	setInterval(() => { autocheck(); },UPDATE_EVERY_MS/4);   // a launcher can stay up for weeks; autocheck() itself keeps it daily
});
