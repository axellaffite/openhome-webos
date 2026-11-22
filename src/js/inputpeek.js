//SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the OpenHome contributors
// Rest on an HDMI shortcut for a moment and a window bounces out of it with what that input is
// showing, live - so you can see whether the console is on the menu or the PC has woken up without
// switching over to it.
//
// The picture is a <video> playing "ext://hdmi:N", the same source LG's own input apps play, drawn
// on the hardware video plane at the size and place of the element. There is only one such plane,
// and the video wallpaper is on it, so for as long as the window is open the wallpaper is handed
// to js/softwall.js, which decodes it in software. The preview only starts once that copy covers
// the screen, and the wallpaper only gets the plane back after the preview has let go of it.
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

let peekbox=null;
// The input the window belongs to (or is waiting on), by app id and not by button: js/quick.js
// redraws the whole row every few seconds, and a button held across that is detached - it then
// measures 0x0 at 0,0 and the window opened against the top of the screen.
let peekappid=null;
let peekdwell=null;
let peekvideo=null;
let peekseq=0;                         // bumped on every close, so stale async steps stand down
let peekstop=Promise.resolve();        // the last close, still handing the wallpaper back

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

// ---- the live picture --------------------------------------------------------------------------

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
	// the video plane is placed from the element's box, so it waits for the bounce to settle
	const covered=softwall.needed()?softwall.start():Promise.resolve(true);
	const [ok]=await Promise.all([covered,bounced]);
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
	// fetching and decoding the wallpaper ahead takes about as long as the dwell itself
	peekstop.then(() => { if(seq===peekseq && softwall.needed()){ softwall.prepare(); } });
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
	if(box){
		box.classList.remove("in","shown");
		box.classList.add("out");
		setTimeout(() => box.remove(),PEEK_OUT_MS);
	}
	if(!wasopen){
		softwall.cancel();
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
	// the drawer covers the shortcuts
	document.addEventListener("change",() => {
		if(typeof realappbarbtu!=="undefined" && realappbarbtu.checked){ peekclose(); }
	},true);
})();
