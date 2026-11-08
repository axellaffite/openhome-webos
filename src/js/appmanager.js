//SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the OpenHome contributors
// The app manager: hold OK on an app in the dock (or hold the Magic Remote's click on it) and every
// app is laid out in one row, the dock's apps first, then a separator, then the apps that are not on
// the home screen. That row is how you choose what the dock shows, and in what order.
//
//   Left / Right   move along the row
//   Up  (or OK)    pick the focused app up
//   Left / Right   while picked up: carry it along the row, across the separator too
//   Down (or OK)   put it down there
//   Back           while picked up: put it back where it was; otherwise close
//
// Only the first DOCK_APPS (main.js) can be left of the separator. Carrying an app into a full dock
// pushes the dock's last app over to the other side, the way a shelf would.
// Apps right of the separator just leave the dock: they stay in the Apps drawer.

const AM_HOLD_MS=600;              // how long OK (or the click) has to be held to open the manager

let amstate=null;                  // {items:[app], split, focus, moving:null|{items,split,focus}} while open
let amroot=null;
let amrow=null;
let amsep=null;
let amhint=null;
const amtiles=new Map();           // app id -> tile, built once and moved around, never rebuilt

function amisopen(){
	return amstate!==null;
}

// ---- the list ------------------------------------------------------------------------------

// The dock's apps (all the pinned ones, so those past DOCK_APPS show up just after the separator),
// then every other app the drawer lists, plus the default inputs (Live TV, HDMI...): those are
// system apps the drawer leaves out, and without them an input taken off the dock could never come back.
function amlist(){
	const docked=dockapps();
	const seen={};
	docked.forEach((app) => {seen[app.id]=true;});
	const extra=[];
	const add=(app) => {
		if(!app || seen[app.id] || ishidden(app.id) || app.id===appid){ return; }
		seen[app.id]=true;
		extra.push(app);
	};
	orderedapps().forEach(add);
	DEFAULT_PINNED.forEach((id) => add(applist.filter((app) => app.id===id)[0]));
	return {items:docked.concat(extra),split:Math.min(docked.length,DOCK_APPS)};
}

// write the dock back: what is left of the separator, then the pinned apps the manager did not list
// (uninstalled for now, or hidden), so they are not forgotten
function amsave(){
	const shown=amstate.items.slice(0,amstate.split).map((app) => app.id);
	const listed={};
	amstate.items.forEach((app) => {listed[app.id]=true;});
	const unlisted=pinnedids().filter((id) => !listed[id]);
	settings.pinned=shown.concat(unlisted);
	savesettings();
	render();
}

// ---- building the overlay ------------------------------------------------------------------

function ambuild(){
	if(amroot){ return; }
	amroot=document.createElement("div");
	amroot.id="appmgr";
	const title=document.createElement("div");
	title.className="amtitle";
	title.textContent=t("Arrange the home screen");
	amrow=document.createElement("div");
	amrow.className="amrow";
	amsep=document.createElement("div");
	amsep.className="amsep";
	const seplabel=document.createElement("span");
	seplabel.textContent=t("Not on the home screen");
	amsep.appendChild(seplabel);
	amhint=document.createElement("div");
	amhint.className="amhint";
	amroot.appendChild(title);
	amroot.appendChild(amrow);
	amroot.appendChild(amhint);
	// a click on the dimmed backdrop (not on the row) closes it, for the Magic Remote
	amroot.addEventListener("click",(event) => { if(event.target===amroot){ amclose(); } });
	maindiv.appendChild(amroot);
}

function amtile(app){
	let tile=amtiles.get(app.id);
	if(tile){ return tile; }
	tile=document.createElement("div");
	tile.className="amtile";
	const icon=document.createElement("img");
	let iconat=0;
	icon.src=appiconsrc(app,iconat) || (appdir+"/access/fallback.png");
	icon.addEventListener("error",() => {
		const next=appiconsrc(app,++iconat);
		if(next===null && icon.src.indexOf("fallback.png")!==-1){ return; }
		icon.src=next || (appdir+"/access/fallback.png");
	});
	const name=document.createElement("span");
	name.textContent=appdisplayname(app);
	tile.appendChild(icon);
	tile.appendChild(name);
	tile.addEventListener("mouseenter",() => {
		if(!amstate || amstate.moving){ return; }
		amstate.focus=amstate.items.indexOf(app);
		amdraw();
	});
	tile.addEventListener("click",() => {
		if(!amstate){ return; }
		if(amstate.moving){ amplace(); } else { amstate.focus=amstate.items.indexOf(app); ampickup(); }
	});
	amtiles.set(app.id,tile);
	return tile;
}

// Put the row's children in order, moving only the ones that are out of place: carrying an app
// one step is then a single insertBefore, which matters while an arrow is held down.
function amdraw(){
	const wanted=amstate.items.slice(0,amstate.split).map(amtile)
		.concat([amsep],amstate.items.slice(amstate.split).map(amtile));
	Array.from(amrow.children).forEach((child) => {
		if(wanted.indexOf(child)===-1){ amrow.removeChild(child); }
	});
	wanted.forEach((el,i) => {
		if(amrow.children[i]!==el){ amrow.insertBefore(el,amrow.children[i]||null); }
	});
	const focused=amstate.items[amstate.focus];
	amstate.items.forEach((app,i) => {
		const tile=amtile(app);
		const on=app===focused;
		tile.classList.toggle("on",on);
		tile.classList.toggle("moving",on && !!amstate.moving);
		tile.classList.toggle("off",i>=amstate.split);       // not on the home screen: drawn dimmer
	});
	amrow.classList.toggle("full",amstate.split>=DOCK_APPS);
	amhint.textContent=amstate.moving?
		"← → "+t("Move")+"   ·   ↓ "+t("Place")+"   ·   "+t("Back")+": "+t("Cancel"):
		"← → "+t("Choose")+"   ·   ↑ "+t("Move")+"   ·   "+t("Back")+": "+t("Done");
	amreveal(amtile(focused));
}

// keep the focused tile on screen: the row scrolls sideways, never the page
function amreveal(tile){
	if(!tile){ return; }
	const margin=amrow.clientWidth*0.12;
	const left=tile.offsetLeft;
	const right=left+tile.offsetWidth;
	if(left<amrow.scrollLeft+margin){ amrow.scrollLeft=Math.max(0,left-margin); }
	else if(right>amrow.scrollLeft+amrow.clientWidth-margin){ amrow.scrollLeft=right-amrow.clientWidth+margin; }
}

// ---- opening and closing -------------------------------------------------------------------

function amopen(appidfocused){
	if(amisopen() || !applist){ return; }
	ambuild();
	const list=amlist();
	if(list.items.length===0){ return; }
	const at=list.items.findIndex((app) => app.id===appidfocused);
	amstate={items:list.items,split:list.split,focus:Math.max(0,at),moving:null};
	if(typeof setfocus==="function"){ setfocus(null); }       // also hides the dock's name label
	maindiv.classList.add("amopen");
	amdraw();
}

function amclose(){
	if(!amisopen()){ return; }
	if(amstate.moving){ amplace(); }
	const focusid=amstate.items[amstate.focus] && amstate.items[amstate.focus].id;
	amstate=null;
	maindiv.classList.remove("amopen");
	// back on the home screen: on the app you were on if it is still in the dock, else on the Apps button
	if(typeof setfocus==="function" && keyboardmode){
		const tiles=Array.from(appbar.querySelectorAll(".appitem"));
		const tile=tiles.filter((each) => each.getAttribute("data-appid")===focusid)[0] || tiles[0] || null;
		setfocus(tile);
	}
}

// ---- moving --------------------------------------------------------------------------------

function ampickup(){
	if(amstate.moving){ return; }
	amstate.moving={items:amstate.items.slice(),split:amstate.split,focus:amstate.focus};
	amdraw();
}

function amplace(){
	if(!amstate.moving){ return; }
	amstate.moving=null;
	amsave();
	amdraw();
}

function amcancel(){
	if(!amstate.moving){ return; }
	amstate.items=amstate.moving.items;
	amstate.split=amstate.moving.split;
	amstate.focus=amstate.moving.focus;
	amstate.moving=null;
	amdraw();
}

function amswap(i,j){
	const items=amstate.items.slice();
	const kept=items[i];
	items[i]=items[j];
	items[j]=kept;
	amstate.items=items;
}

// carry the picked-up app one step. Crossing the separator is a change of `split`, not of position:
// the last dock app stepping right becomes the first app off the dock, where it already sits.
function amcarry(dir){
	const i=amstate.focus;
	const last=amstate.items.length-1;
	if(dir>0){
		if(i===amstate.split-1){ amstate.split--; return; }             // out of the dock
		if(i>=last){ return; }
		amswap(i,i+1);
		amstate.focus=i+1;
	} else {
		if(i===amstate.split){
			if(amstate.split<DOCK_APPS){ amstate.split++; return; }      // into the dock, which has room
			// a full dock: take the last place, and its app goes over to the other side
			amswap(i,i-1);
			amstate.focus=i-1;
			return;
		}
		if(i<=0){ return; }
		amswap(i,i-1);
		amstate.focus=i-1;
	}
}

// ---- keys ----------------------------------------------------------------------------------

function amkey(event){
	const code=event.keyCode;
	event.preventDefault();
	event.stopPropagation();      // dpad.js listens on window too, after this; it must not see these
	if(code===KEY_BACK){
		if(amstate.moving){ amcancel(); } else { amclose(); }
		return;
	}
	if(code===KEY_LEFT || code===KEY_RIGHT){
		const dir=code===KEY_RIGHT?1:-1;
		if(amstate.moving){
			amcarry(dir);
		} else {
			amstate.focus=Math.max(0,Math.min(amstate.items.length-1,amstate.focus+dir));
		}
		amdraw();
	} else if(code===KEY_UP){
		ampickup();
	} else if(code===KEY_DOWN){
		amplace();
	} else if(code===KEY_ENTER && !event.repeat){
		if(amstate.moving){ amplace(); } else { ampickup(); }
	}
}

// ---- the long press ------------------------------------------------------------------------
// OK normally launches the focused app as it goes DOWN (dpad.js). On a dock app it now waits:
// let go before AM_HOLD_MS and the app launches as before; keep holding and the manager opens.

let amholdtimer=null;
let amholdfired=false;

function amdockapp(el){
	return !!el && appbar.contains(el) && el.classList.contains("appitem") && !!el.getAttribute("data-appid");
}

function amcanhold(){
	return keyboardmode && !editing && !carrying && !realappbarbtu.checked && contextname()==="home" &&
		amdockapp(dpadfocus);
}

function onamkeydown(event){
	if(event.keyCode===KEY_ENTER && (amholdtimer!==null || amholdfired)){
		// OK is still down from the press that opened (or is opening) the manager: these are its
		// auto-repeats, which must not launch the app or pick one up. Not every remote marks them
		// with event.repeat, so the key being held is tracked here instead.
		event.preventDefault();
		event.stopPropagation();
		return;
	}
	if(amisopen()){
		amkey(event);
		return;
	}
	if(event.keyCode!==KEY_ENTER || istyping()){ return; }
	if(event.repeat || !amcanhold()){ return; }
	event.preventDefault();
	event.stopPropagation();
	const tile=dpadfocus;
	amholdtimer=setTimeout(() => {
		amholdtimer=null;
		amholdfired=true;
		amopen(tile.getAttribute("data-appid"));
	},AM_HOLD_MS);
}

function onamkeyup(event){
	if(event.keyCode!==KEY_ENTER){ return; }
	if(amholdtimer!==null){
		// a short press: do what OK always did
		clearTimeout(amholdtimer);
		amholdtimer=null;
		if(amdockapp(dpadfocus) && typeof activate==="function"){ activate(dpadfocus); }
	}
	amholdfired=false;
}

// the Magic Remote: hold the click on a dock app
let ampresstimer=null;
let amswallowclick=false;

function onammousedown(event){
	if(amisopen() || editing || carrying || realappbarbtu.checked || event.button!==0){ return; }
	const tile=event.target.closest && event.target.closest("#appbar .appitem");
	if(!amdockapp(tile)){ return; }
	clearTimeout(ampresstimer);
	ampresstimer=setTimeout(() => {
		ampresstimer=null;
		amswallowclick=true;           // the click that ends this press must not launch the app
		amopen(tile.getAttribute("data-appid"));
	},AM_HOLD_MS);
}

function onammouseup(){
	clearTimeout(ampresstimer);
	ampresstimer=null;
	// The click that ends the long press comes right after this mouseup, in the same task, and is
	// swallowed by onamclick. If it never comes (the button was let go over another element) the
	// flag must not linger and eat the next real click.
	if(amswallowclick){ setTimeout(() => { amswallowclick=false; },0); }
}

function onamclick(event){
	if(!amswallowclick){ return; }
	amswallowclick=false;
	event.preventDefault();
	event.stopPropagation();
}

// a panel like the others (dpad.js), so the Home button closes it; it reads its own keys, so it
// offers the remote nothing to focus
registerpanel({name:"appmanager",order:100,isopen:() => amisopen(),close:() => amclose(),elements:() => []});

function initappmanager(){
	// capture phase, so these run before dpad.js's own window listeners
	window.addEventListener("keydown",onamkeydown,true);
	window.addEventListener("keyup",onamkeyup,true);
	window.addEventListener("mousedown",onammousedown,true);
	window.addEventListener("mouseup",onammouseup,true);
	window.addEventListener("click",onamclick,true);
	// the Magic Remote's pointer leaving the tile cancels a press in progress
	appbar.addEventListener("mouseleave",onammouseup);
}

document.addEventListener("DOMContentLoaded",initappmanager);
