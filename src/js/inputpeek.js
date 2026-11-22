//SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the OpenHome contributors
// Rest on an HDMI shortcut for a moment and a window bounces out of it with what that input is
// showing, live - so you can see whether the console is on the menu or the PC has woken up without
// switching over to it.
//
// The picture goes on the TV's SECOND video plane. The set has two (getOutputCapabilities: MAIN
// and SUB0, both with their own scaler - the ones Multi View and picture-in-picture use), and the
// video wallpaper only ever takes MAIN. So the input is wired straight to SUB0 through the video
// output service, in a window placed over the preview's screen: both pictures are the hardware's,
// at full frame rate, with no CPU spent on either. Measured 2026-11-22: ~30 ms from asking to
// picture, the wallpaper still playing at 29.97 fps underneath. SUB0 sits above MAIN, so the
// screen area of the window is left fully transparent and the plane shows through it.
//
// Fallback, should the service refuse: a <video> playing "ext://hdmi:N" (the source LG's input apps
// play). That one can only have MAIN, which the wallpaper is on, so the wallpaper is then handed
// to js/softwall.js and decoded in software while the window is open - it works, but costs a core.
//
// An input with something plugged in but no picture coming (a console in rest mode) gets the
// window too, saying so, rather than a black rectangle.

const PEEK_DWELL_MS=1600;              // how long the focus has to rest on a shortcut
const PEEK_MATCH=/^com\.webos\.app\.hdmi(\d+)$/;
const PEEK_GAP_PX=18;                  // between the shortcut and the window
const PEEK_EDGE_PX=16;                 // the window never comes closer to the screen edge than this
const PEEK_BOUNCE_MS=620;              // keep in step with the peekin animation in css/peek.css
const PEEK_OUT_MS=170;                 // ... and with peekout
const PEEK_RELEASE_MS=120;             // let the plane go before the wallpaper takes it back
const PEEK_PLANE_API="luna://com.webos.service.videooutput/";
const PEEK_SINK="SUB0";
const PEEK_CONTEXT="openhome.inputpeek";
const PEEK_APPID="io.github.axellaffite.openhome";
// The video output service numbers its HDMI sources differently from the input manager: HDMI 1
// is source port 3 (what "ext://hdmi:1" reports when it plays, 2026-11-22). The other ports are
// assumed to follow on; only HDMI 1 had a device to check it with.
const PEEK_SOURCE_OFFSET=2;
// the service places windows on a 1920x1080 grid whatever the panel (it doubles them on 4K)
const PEEK_GRID_W=1920;
const PEEK_GRID_H=1080;
const PEEK_HOLE_FAR_PX=20000;          // the outline the hole is cut from: well past any screen

let peekbox=null;
// The input the window belongs to (or is waiting on), by app id and not by button: js/quick.js
// redraws the whole row every few seconds, and a button held across that is detached - it then
// measures 0x0 at 0,0 and the window opened against the top of the screen.
let peekappid=null;
let peekdwell=null;
let peekvideo=null;
let peekseq=0;                         // bumped on every close, so stale async steps stand down
let peekstop=Promise.resolve();        // the last close, still handing the wallpaper back
let peekplane=false;                   // SUB0 is wired to an input for us

function peekport(chip){
	const appid=chip.getAttribute("data-appid") || "";
	const match=PEEK_MATCH.exec(appid);
	if(!match){ return null; }
	const device=quickdevices && quickdevices[appid];
	return (device && device.port) || Number(match[1]);
}

function peekdevicename(chip){
	const device=quickdevices && quickdevices[chip.getAttribute("data-appid")];
	const cec=device && (device.subList || []).filter((each) => each && each.osdName)[0];
	return cec?cec.osdName:"";
}

function peekel(tag,cls,text){
	const made=document.createElement(tag);
	if(cls){ made.className=cls; }
	if(text){ made.textContent=text; }
	return made;
}

// ---- building and placing the window --------------------------------------------------------------

function peekbuild(chip,port){
	const box=peekel("div","");
	box.id="peekbox";
	const screen=peekel("div","peekscreen");
	box.appendChild(screen);
	const foot=peekel("div","peekfoot");
	foot.appendChild(peekel("span","peekname",chip.getAttribute("title") || ("HDMI "+port)));
	const device=peekdevicename(chip);
	foot.appendChild(peekel("span","peekport",(device?device+" · ":"")+"HDMI "+port));
	box.appendChild(foot);
	return box;
}

function peeknote(text,busy){
	if(!peekbox){ return; }
	const screen=peekbox.querySelector(".peekscreen");
	let note=screen.querySelector(".peeknote");
	if(!note){
		note=peekel("div","peeknote");
		screen.appendChild(note);
	}
	note.textContent=text;
	note.classList.toggle("busy",!!busy);
}

// beside the shortcut when it stands in the left column, above it when it sits in a row; the
// window grows out of the side facing the shortcut
function peekplace(box,chip){
	const rect=chip.getBoundingClientRect();
	const width=box.offsetWidth;
	const height=box.offsetHeight;
	const clamp=(value,low,high) => Math.max(low,Math.min(high,value));
	let left;
	let top;
	if(rect.left<window.innerWidth*0.25){
		left=rect.right+PEEK_GAP_PX;
		top=clamp(rect.top+rect.height/2-height/2,PEEK_EDGE_PX,window.innerHeight-height-PEEK_EDGE_PX);
		box.style.transformOrigin="0 "+Math.round(rect.top+rect.height/2-top)+"px";
	} else {
		left=clamp(rect.left+rect.width/2-width/2,PEEK_EDGE_PX,window.innerWidth-width-PEEK_EDGE_PX);
		top=rect.top-height-PEEK_GAP_PX;
		box.style.transformOrigin=Math.round(rect.left+rect.width/2-left)+"px 100%";
	}
	box.style.left=Math.round(left)+"px";
	box.style.top=Math.round(top)+"px";
}

// ---- the live picture on the second plane ------------------------------------------------------

// The service ties a connection to the bus connection of whoever made it, and drops it - picture
// gone, window left empty - once that is closed. lunacall's bridge is thrown away after its answer
// and closed whenever the garbage collector gets to it, which cut the preview after a few seconds,
// at random (2026-11-22). So the bridges are kept here until the plane is let go.
let peekbridges=[];

function peekplanecall(method,payload){
	return new Promise((done,fail) => {
		const bridge=new window.PalmServiceBridge();
		peekbridges.push(bridge);
		bridge.onservicecallback=(text) => {
			let answer=null;
			try { answer=JSON.parse(text); } catch(e) {}
			if(!answer || answer.returnValue===false){
				fail(new Error(method+": "+((answer && answer.errorMessage) || "no answer")));
			} else {
				done(answer);
			}
		};
		bridge.call(PEEK_PLANE_API+method,JSON.stringify(payload));
	});
}

function peekplanewindow(screen){
	const rect=screen.getBoundingClientRect();
	const sx=PEEK_GRID_W/window.innerWidth;
	const sy=PEEK_GRID_H/window.innerHeight;
	return {x:Math.round(rect.left*sx),y:Math.round(rect.top*sy),
		width:Math.round(rect.width*sx),height:Math.round(rect.height*sy)};
}

async function peekplaneon(port,screen){
	peekplane=true;                    // from the first call: a half-made connection is undone too
	await peekplanecall("register",{context:PEEK_CONTEXT,appId:PEEK_APPID});
	await peekplanecall("connect",{outputMode:"DISPLAY",sink:PEEK_SINK,source:"HDMI",
		sourcePort:port+PEEK_SOURCE_OFFSET,context:PEEK_CONTEXT});
	await peekplanecall("display/setDisplayWindow",{sink:PEEK_SINK,context:PEEK_CONTEXT,
		fullScreen:false,displayOutput:peekplanewindow(screen)});
	await peekplanecall("blankVideo",{sink:PEEK_SINK,blank:false});
}

// Never throws, and also clears a connection left over from a launcher that did not get to close
// it: the service keeps it after its caller has gone, picture and all.
async function peekplaneoff(always){
	if(!peekplane && !always){ return; }
	peekplane=false;
	peekhole(null);
	try { await peekplanecall("disconnect",{sink:PEEK_SINK,context:PEEK_CONTEXT}); } catch(e) {}
	try { await peekplanecall("unregister",{context:PEEK_CONTEXT}); } catch(e) {}
	// only once it is all undone may the bus connections go (a new preview has its own by now)
	if(!peekplane){ peekbridges=[]; }
}

// Everything the launcher draws is on top of the video planes, whatever its z-index: the picture
// only shows where the page is fully transparent, and the weather or the app bar may well be over
// that spot. So the page's content gets a hole cut through it there for as long as the window is
// open. It is cut in #prefetchmaindiv, which holds every piece of the UI (the window's own frame
// lies around the hole, so it stays), and never in #bgvideo, which a clip would take off its plane.
function peekhole(rect){
	const content=document.getElementById("prefetchmaindiv");
	if(!content){ return; }
	if(!rect){
		content.style.clipPath="";
		return;
	}
	// clip-path is in the element's own coordinates, and this static div is not screen-sized - its
	// fixed children reach well outside it - so the outline is far past any screen, not 100%
	const origin=content.getBoundingClientRect();
	const px=(value) => Math.round(value)+"px";
	const x1=px(rect.left-origin.left);
	const y1=px(rect.top-origin.top);
	const x2=px(rect.left+rect.width-origin.left);
	const y2=px(rect.top+rect.height-origin.top);
	const far=PEEK_HOLE_FAR_PX+"px";
	const near="-"+far;
	// the outline, then the hole traced inside it: evenodd leaves the inside out
	content.style.clipPath="polygon(evenodd, "+near+" "+near+", "+far+" "+near+", "+far+" "+far+", "+
		near+" "+far+", "+near+" "+near+", "+x1+" "+y1+", "+x2+" "+y1+", "+x2+" "+y2+", "+x1+" "+y2+", "+
		x1+" "+y1+")";
}

// ---- the fallback: a <video> on the main plane ---------------------------------------------------

function peekplay(port,seq){
	const video=document.createElement("video");
	video.className="peekvideo";
	video.muted=true;
	const source=document.createElement("source");
	source.src="ext://hdmi:"+port;
	source.type="service/webos-external";
	video.appendChild(source);
	video.addEventListener("playing",() => {
		if(seq===peekseq && peekbox){ peekbox.classList.add("live"); }
	});
	peekbox.querySelector(".peekscreen").appendChild(video);
	peekvideo=video;
	video.play().catch(() => { if(seq===peekseq){ peeknote(t("Preview unavailable")); } });
}

function peekrelease(){
	const video=peekvideo;
	peekvideo=null;
	if(!video){ return false; }
	try {
		video.pause();
		video.innerHTML="";
		video.removeAttribute("src");
		video.load();
	} catch(e) {}
	video.remove();
	return true;
}

// ---- open / close ------------------------------------------------------------------------------

// the button on screen now for the input the window is about
function peekchipnow(){
	if(!peekappid || typeof quickrow==="undefined" || !quickrow){ return null; }
	const chip=quickrow.querySelector('.qchip[data-appid="'+CSS.escape(peekappid)+'"]');
	if(!chip){ return null; }
	const rect=chip.getBoundingClientRect();
	return (rect.width>0 && rect.height>0)?chip:null;
}

async function peekopen(seq){
	await peekstop;                       // the last window has to have given the wallpaper back
	if(seq!==peekseq){ return; }
	if(typeof read5v==="function"){ await read5v(); }
	if(seq!==peekseq){ return; }
	// looked up only now, after every wait, so it is the button that is really on screen
	const chip=peekchipnow();
	if(!chip){ peekclose(); return; }
	const port=peekport(chip);
	if(typeof tiphide==="function"){ tiphide(); }
	peekbox=peekbuild(chip,port);
	maindiv.appendChild(peekbox);
	peekplace(peekbox,chip);
	peekbox.classList.add("in");
	const bounced=new Promise((done) => setTimeout(done,PEEK_BOUNCE_MS));
	bounced.then(() => { if(seq===peekseq && peekbox){ peekbox.classList.replace("in","shown"); } });

	if(quickpicture[port]!==true){
		peeknote(t("No picture on this input"));
		softwall.cancel();
		return;
	}
	peeknote(t("Connecting…"),true);
	// the plane window is placed from the screen's box, so it waits for the bounce to settle
	await bounced;
	if(seq!==peekseq){ return; }
	try {
		await peekplaneon(port,peekbox.querySelector(".peekscreen"));
	} catch(e) {
		await peekplaneoff();
		if(seq===peekseq){ peekfallback(port,seq); }
		return;
	}
	// closed while connecting: peekclose() ran before the plane was ours, so let it go here
	if(seq!==peekseq || !peekbox){ peekplaneoff(true); return; }
	peekbox.classList.add("native","live");
	peekhole(peekbox.querySelector(".peekscreen").getBoundingClientRect());
}

// the <video> on the main plane, with the wallpaper in software meanwhile (see the top of the file)
async function peekfallback(port,seq){
	const covered=softwall.needed()?softwall.start():Promise.resolve(true);
	const ok=await covered;
	if(seq!==peekseq){ return; }
	if(!ok){
		peeknote(t("Preview unavailable with this wallpaper"));
		return;
	}
	peekplay(port,seq);
}

// starts the clock on a shortcut that just got the focus or the pointer
function peekarm(chip){
	const appid=chip?chip.getAttribute("data-appid"):null;
	if(appid && appid===peekappid){ return; }   // the same input, maybe a freshly redrawn button
	peekclose();
	if(!chip || peekport(chip)===null){ return; }
	peekappid=appid;
	const seq=peekseq;
	// nothing is prepared ahead: the second plane needs no warming up, and decoding the wallpaper
	// in software just in case would cost a core on every rest on a shortcut
	peekdwell=setTimeout(() => { peekopen(seq); },PEEK_DWELL_MS);
}

function peekclose(){
	peekseq++;
	clearTimeout(peekdwell);
	peekdwell=null;
	const wasopen=!!peekbox;
	peekappid=null;
	const box=peekbox;
	peekbox=null;
	const hadvideo=peekrelease();
	// first, before the window fades: the plane does not fade with it
	const hadplane=peekplane;
	const planeoff=peekplaneoff();
	if(box){
		box.classList.remove("in","shown");
		box.classList.add("out");
		setTimeout(() => box.remove(),PEEK_OUT_MS);
	}
	if(!wasopen || hadplane){
		softwall.cancel();
		peekstop=planeoff;
		return;
	}
	peekstop=(async () => {
		if(hadvideo){ await new Promise((done) => setTimeout(done,PEEK_RELEASE_MS)); }
		await softwall.stop();
	})().catch(() => {});
}

function peektarget(node){
	for(let at=node;at && at!==document;at=at.parentNode){
		if(at.classList && at.classList.contains("qchip")){
			return (typeof quickrow!=="undefined" && quickrow && quickrow.contains(at))?at:null;
		}
	}
	return null;
}

(function(){
	onfocuschange((el) => peekarm(el?peektarget(el):null));
	document.addEventListener("mouseover",(event) => {
		const chip=peektarget(event.target);
		if(chip){ peekarm(chip); }
		else if(peekappid){
			const now=peekchipnow();
			if(!now || !now.classList.contains("dfocus")){ peekclose(); }
		}
	});
	// launching the input: let go of the plane first, the input app is about to take it
	document.addEventListener("click",(event) => { if(peektarget(event.target)){ peekclose(); } },true);
	document.addEventListener("keydown",(event) => {
		if(event.keyCode===13 || event.keyCode===461 || event.keyCode===27){ peekclose(); }
	},true);
	document.addEventListener("visibilitychange",() => { if(document.hidden){ peekclose(); } });
	// a window left by a launcher that was killed or reloaded mid-preview would stay on screen,
	// over whatever app comes next
	window.addEventListener("beforeunload",() => { peekplaneoff(true); });
	document.addEventListener("DOMContentLoaded",() => { peekplaneoff(true); });
	// the drawer covers the shortcuts
	document.addEventListener("change",() => {
		if(typeof realappbarbtu!=="undefined" && realappbarbtu.checked){ peekclose(); }
	},true);
})();
