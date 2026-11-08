//SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the OpenHome contributors
// The remote's Home button, pressed while OpenHome is already in front, brings back its main
// screen: every panel closed, the drawer shut, the focus on the Apps button.
//
// With OpenHome as the home app, webOS does not start it again on Home: it sends the running page
// a webOSRelaunch event, with launchType "homeKey" (checked on a 65UR78003LK, webOS 10.3). Only
// that launch type resets the screen. webOS relaunches the launcher for other reasons too, and
// those should leave it as it was.

function gohome(){
	if(typeof istyping==="function" && istyping()){ document.activeElement.blur(); }
	// every open panel (dpad.js's registerpanel), the topmost first
	PANELS.filter((panel) => panel.isopen()).forEach((panel) => panel.close());
	if(carrying){ stopcarry(); }
	// the drawer: back to All apps at the top, for the next time it opens
	const infolder=openfolder!==null;
	openfolder=null;
	appluncher.scrollTop=0;
	if(realappbarbtu.checked){
		// as if the drawer were closed by hand: setting .checked does not fire "change", and
		// several files listen for it (main.js ends Edit mode, dpad.js, folders.js, info.js, tooltip.js)
		realappbarbtu.checked=false;
		realappbarbtu.dispatchEvent(new Event("change"));
	} else if(editing){
		toggleedit();
	}
	if(infolder){ render(); }
	// the focus ring, if the remote is in use, goes to the Apps button: the first tile of the dock.
	// Not defaultfocus(), which picks the first thing in the home screen's list, the weather card.
	if(keyboardmode && typeof setfocus==="function"){
		const apps=appbar.querySelector(".appitem");
		if(apps){ setfocus(apps); }
	}
}

document.addEventListener("webOSRelaunch",(event) => {
	const detail=(event && event.detail) || {};
	if(detail.launchType==="homeKey"){ gohome(); }
});
