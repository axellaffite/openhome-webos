//SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the OpenHome contributors
// The video wallpaper, decoded in software for as long as an input preview is open.
//
// Why: the TV has ONE hardware video plane. The input preview (js/inputpeek.js) needs it to show
// what is on an HDMI port, and #bgvideo loses it while that plays - the wallpaper just vanishes, and
// starting it again makes the two fight over the plane. So while a preview is open the wallpaper is
// decoded by WebCodecs and painted on a WebGL canvas laid over #bgvideo.
//
// Measured on the dev set with a 1080p30 aerial at 11.5 Mb/s: software decode alone ~36 fps. Drawing
// the frames on a 2D canvas drops that to ~22 fps, on a smaller 2D canvas to ~5 (it scales on the
// CPU), while uploading them as a WebGL texture holds 29.8 fps. Hence WebGL, full size, and nothing
// above 1080p - the built-in 4K loop.mp4 is out of reach, and the preview says so instead.
//
// The bytes: the aerials are cross-origin without CORS, so the page cannot read them, and the TV's
// curl does not trust Apple's root. So the root service fetches byte ranges with curl, trusting the
// system store plus access/certs/apple-root-ca.pem (Apple Root CA, SHA-256 B0:B1:73:0E:...:F0:24),
// into peekcache/ in the app's folder, which the page can read. Local files are cut out with dd.
//
// Keyframes are ~5 s apart and decoding is only 1.2x real time, so the software copy can never
// catch up with the exact frame on screen. Instead it starts at the NEXT keyframe, fetched and
// decoded while the input is still only focused, and cross-fades in: a slow aerial a few seconds on
// looks the same. On the way out the hardware video is seeked to where the software copy got to,
// and the canvas fades away once it is showing again.

const SW_LIB="js/lib/mp4box/mp4box.all.min.js";   // 144 KB: loaded on the first preview, not at boot
const SW_DIR="peekcache";                // under the app's folder, so the page can read it back
const SW_CERT="/access/certs/apple-root-ca.pem";
const SW_HEAD_BYTES=16;                  // enough for any top-level box header
const SW_MAX_BOXES=12;                   // top-level boxes walked looking for moov
const SW_MAX_MOOV=24*1024*1024;          // a header bigger than this is not a wallpaper
const SW_LEAD_S=1.2;                     // how far ahead of the wallpaper the start keyframe must be
const SW_FIRST_WINDOW_S=2;               // the first download is short, so the preview starts sooner
const SW_WINDOW_S=5;                     // seconds of video per download after that
const SW_REFILL_S=2.5;                   // fetch the next window when less than this is left
const SW_DECODE_AHEAD=6;                 // decoded frames kept ready
const SW_MAX_W=1920;
const SW_MAX_H=1080;
const SW_FADE_MS=280;                    // keep in step with #softwall's transition in css/peek.css
const SW_SEEK_WAIT_MS=1500;              // longest wait for the hardware video to be back
const SW_SETTLE_MS=250;                  // and a beat more, so it has painted a frame
const SW_FIRST_FRAME_MS=5000;            // a decoder that has shown nothing by then never will

const swmetas={};                        // url -> parsed header, so a second preview starts faster
let swrun=null;                          // the one session there can be
let swcanvas=null;
let swgl=null;
let swseq=0;
let swlibload=null;

// WebCodecs arrived in Chromium 94; the oldest supported webOS has 68. There the preview says it
// cannot run with a video wallpaper, rather than taking the wallpaper away.
function swcapable(){
	return typeof VideoDecoder==="function" && typeof EncodedVideoChunk==="function";
}

function swloadlib(){
	if(!swlibload){
		swlibload=new Promise((done,fail) => {
			const script=document.createElement("script");
			script.src=SW_LIB;
			script.onload=() => done();
			script.onerror=() => { swlibload=null; fail(new Error("could not load "+SW_LIB)); };
			document.body.appendChild(script);
		});
	}
	return swlibload;
}

function swwait(ms){ return new Promise((done) => setTimeout(done,ms)); }

// The url of the video wallpaper playing now, or null when the wallpaper is a photo (or nothing),
// in which case the plane is free and nothing has to be done.
function swsource(){
	if(typeof bgvideo==="undefined" || !bgvideo || bgvideo.paused || !bgvideo.currentSrc){ return null; }
	const isvideo=bgmode==="aerials" || bgmode==="local" ||
		(bgmode==="custom" && customcurrent!==null && customcurrent.kind==="video");
	return isvideo?bgvideo.currentSrc:null;
}

function swneeded(){ return swsource()!==null; }

// ---- reading byte ranges ------------------------------------------------------------------------

function swxhr(path){
	return new Promise((done,fail) => {
		const request=new XMLHttpRequest();
		request.open("GET",path);
		request.responseType="arraybuffer";
		request.onload=() => done(request.response);
		request.onerror=() => fail(new Error("could not read "+path));
		request.send();
	});
}

function swlocalpath(url){
	return decodeURI(url.replace(/^file:\/\//i,""));
}

// bytes start..end (inclusive) of the video, as an ArrayBuffer
async function swread(url,start,end){
	const name="r"+(++swseq)+".bin";
	const dir=appdir+"/"+SW_DIR;
	const out=dir+"/"+name;
	let command;
	let skip=0;
	if(/^https?:/i.test(url)){
		command="curl -sS -f -m 40 --capath /etc/ssl/certs --cacert "+shellquote(appdir+SW_CERT)+
			" -r "+start+"-"+end+" -o "+shellquote(out)+" "+shellquote(url);
	} else {
		// busybox dd only skips whole blocks, so read from the block before and trim here
		const block=65536;
		const first=Math.floor(start/block);
		const count=Math.ceil((end+1)/block)-first;
		skip=start-first*block;
		command="dd if="+shellquote(swlocalpath(url))+" of="+shellquote(out)+
			" bs="+block+" skip="+first+" count="+count+" 2>/dev/null";
	}
	await wallsh("mkdir -p "+shellquote(dir)+" && "+command);
	try {
		const whole=await swxhr(SW_DIR+"/"+name);
		const want=end-start+1;
		if(!whole || whole.byteLength<skip+Math.min(want,1)){ throw new Error("short read"); }
		return whole.slice(skip,skip+want);
	} finally {
		wallsh("rm -f "+shellquote(out)).catch(() => {});
	}
}

// ---- the header: walk the top-level boxes to moov, wherever it is (the aerials keep it at the end)

function swboxhead(buffer){
	const view=new DataView(buffer);
	let size=view.getUint32(0);
	const type=String.fromCharCode(view.getUint8(4),view.getUint8(5),view.getUint8(6),view.getUint8(7));
	if(size===1 && buffer.byteLength>=16){ size=view.getUint32(8)*4294967296+view.getUint32(12); }
	return {size,type};
}

async function swfindboxes(url){
	const keep={};
	let at=0;
	for(let i=0;i<SW_MAX_BOXES && !keep.moov;i++){
		const head=swboxhead(await swread(url,at,at+SW_HEAD_BYTES-1));
		if(head.size<8){ break; }              // 0 = runs to the end of the file; moov is not after that
		if(head.type==="ftyp" || head.type==="moov"){
			if(head.size>SW_MAX_MOOV){ break; }
			keep[head.type]=await swread(url,at,at+head.size-1);
		}
		at+=head.size;
	}
	if(!keep.moov){ throw new Error("no movie header"); }
	return keep;
}

function swjoin(parts){
	const total=parts.reduce((sum,each) => sum+each.byteLength,0);
	const out=new Uint8Array(total);
	let at=0;
	parts.forEach((each) => { out.set(new Uint8Array(each),at); at+=each.byteLength; });
	return out.buffer;
}

// mp4box only needs the boxes, not the media: the sample offsets it reports come from the header
// and are absolute positions in the real file
async function swloadmeta(url){
	if(swmetas[url]){ return swmetas[url]; }
	await swloadlib();
	try {
		swmetas[url]=await swparsemeta(url);
	} catch(error) {
		// a video this cannot play is remembered, so the next focus does not download its header
		// again; a failed download is not, it may well work next time
		if(error.unusable){ swmetas[url]={unusable:error.message}; }
		throw error;
	}
	if(swmetas[url].unusable){ throw new Error(swmetas[url].unusable); }
	return swmetas[url];
}

function swunusable(why){
	const error=new Error(why);
	error.unusable=true;
	return error;
}

async function swparsemeta(url){
	const boxes=await swfindboxes(url);
	const file=MP4Box.createFile();
	let info=null;
	file.onReady=(each) => { info=each; };
	const buffer=swjoin(boxes.ftyp?[boxes.ftyp,boxes.moov]:[boxes.moov]);
	buffer.fileStart=0;
	file.appendBuffer(buffer);
	file.flush();
	const track=info && info.videoTracks && info.videoTracks[0];
	if(!track){ throw swunusable("no video track"); }
	if(track.video.width>SW_MAX_W || track.video.height>SW_MAX_H){ throw swunusable("too big to decode"); }
	// H.264 only. The Fire TV aerials are HEVC, which this Chromium decodes in hardware alone:
	// isConfigSupported() answers yes for software, then configure() refuses the real stream.
	const entry=file.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0];
	if(!entry.avcC){ throw swunusable("not H.264: "+track.codec); }
	const stream=new DataStream(undefined,0,DataStream.BIG_ENDIAN);
	entry.avcC.write(stream);   // the decoder wants it without its own box header, hence the 8 below
	const meta={
		codec:track.codec,
		description:new Uint8Array(stream.buffer,8),
		samples:file.getTrackById(track.id).samples.map((each) => ({
			offset:each.offset,
			size:each.size,
			time:each.cts/each.timescale,
			duration:each.duration/each.timescale,
			key:!!each.is_sync
		}))
	};
	return meta;
}

// ---- one session: prepare (while focused), start (preview opens), stop (preview closes) ---------

function swalive(run){
	if(!run.alive){ throw new Error("cancelled"); }
}

// the first keyframe far enough ahead that it is ready before the wallpaper gets there
function swstartindex(samples){
	const from=bgvideo.currentTime+SW_LEAD_S;
	for(let i=0;i<samples.length;i++){
		if(samples[i].key && samples[i].time>=from){ return i; }
	}
	return -1;
}

// downloads the next few seconds of samples in one range
async function swfetchwindow(run,seconds){
	const samples=run.meta.samples;
	const first=run.fetched;
	if(first>=samples.length){ return; }
	let last=first;
	while(last+1<samples.length && samples[last+1].time<samples[first].time+(seconds || SW_WINDOW_S)){ last++; }
	let low=Infinity;
	let high=0;
	for(let i=first;i<=last;i++){
		low=Math.min(low,samples[i].offset);
		high=Math.max(high,samples[i].offset+samples[i].size);
	}
	const bytes=await swread(run.url,low,high-1);
	swalive(run);
	run.chunks.push({start:low,end:high,bytes,last});
	run.fetched=last+1;
}

function swsampledata(run,sample){
	const chunk=run.chunks.find((each) => sample.offset>=each.start && sample.offset+sample.size<=each.end);
	return chunk?new Uint8Array(chunk.bytes,sample.offset-chunk.start,sample.size):null;
}

// keeps the decoder fed and the downloads ahead of it; runs until the session ends
async function swpump(run){
	while(run.alive){
		const samples=run.meta.samples;
		const behind=run.fetched<samples.length && samples[run.fetched-1].time-run.clock()<SW_REFILL_S;
		if(behind && !run.fetching){
			run.fetching=true;
			swfetchwindow(run).catch(() => {}).finally(() => { run.fetching=false; });
		}
		while(run.alive && run.decoded<run.fetched && run.decoder.decodeQueueSize<2 &&
			run.frames.length<SW_DECODE_AHEAD){
			swfeed(run);
		}
		// downloaded windows the decoder has finished with
		run.chunks=run.chunks.filter((each) => each.last>=run.decoded);
		await swwait(15);
	}
}

function swfeed(run){
	const sample=run.meta.samples[run.decoded];
	const data=swsampledata(run,sample);
	run.decoded++;
	if(!data){ return; }
	run.decoder.decode(new EncodedVideoChunk({
		type:sample.key?"key":"delta",
		timestamp:Math.round(sample.time*1e6),
		duration:Math.round(sample.duration*1e6),
		data
	}));
}

function swcancel(){
	const run=swrun;
	swrun=null;
	if(!run){ return; }
	run.alive=false;
	if(run.raf){ cancelAnimationFrame(run.raf); }
	run.frames.forEach((frame) => frame.close());
	run.frames=[];
	if(run.first){ run.first.close(); run.first=null; }
	if(run.decoder && run.decoder.state!=="closed"){ try { run.decoder.close(); } catch(e) {} }
	if(swcanvas){ swcanvas.classList.remove("on"); }
	wallsh("rm -rf "+shellquote(appdir+"/"+SW_DIR)).catch(() => {});
}

// Starts fetching and decoding the wallpaper ahead. Cheap to call again for the same wallpaper.
// Resolves to true once the first frame is decoded and start() can cover the wallpaper with it.
function swprepare(){
	const url=swsource();
	if(!url || !swcapable()){ return Promise.resolve(false); }
	if(swrun && swrun.url===url && swrun.alive){ return swrun.ready; }
	swcancel();
	const run={url,alive:true,chunks:[],frames:[],first:null,fetched:0,decoded:0,fetching:false,
		started:false,raf:0,base:0,basetime:0,decoder:null,meta:null};
	run.clock=() => run.started?run.basetime+(performance.now()-run.base)/1000:bgvideo.currentTime;
	swrun=run;
	run.ready=(async () => {
		run.meta=await swloadmeta(url);
		swalive(run);
		const start=swstartindex(run.meta.samples);
		if(start<0){ throw new Error("too close to the end"); }
		run.fetched=start;
		run.decoded=start;
		await swfetchwindow(run,SW_FIRST_WINDOW_S);
		const firstframe=new Promise((done,fail) => {
			run.decoder=new VideoDecoder({
				output:(frame) => {
					if(!run.alive){ frame.close(); return; }
					if(!run.first){ run.first=frame; done(); return; }
					run.frames.push(frame);
				},
				error:(error) => { fail(error); swcancel(); }
			});
		});
		run.decoder.configure({codec:run.meta.codec,description:run.meta.description,hardwareAcceleration:"prefer-software"});
		// the decoder holds frames back until it has seen a few more (reordering), so the pump
		// starts feeding at once and the first frame comes out of that
		swpump(run);
		await Promise.race([firstframe,swwait(SW_FIRST_FRAME_MS).then(() => { throw new Error("no frame"); })]);
		swalive(run);
		return true;
	})().catch(() => {
		if(swrun===run){ swcancel(); }
		return false;
	});
	return run.ready;
}

// ---- drawing --------------------------------------------------------------------------------------

function swsetupgl(){
	swcanvas=document.createElement("canvas");
	swcanvas.id="softwall";
	swcanvas.width=SW_MAX_W;
	swcanvas.height=SW_MAX_H;
	bgvideo.parentNode.insertBefore(swcanvas,bgvideo.nextSibling);
	const gl=swcanvas.getContext("webgl");
	if(!gl){ return null; }
	const shader=(kind,source) => {
		const made=gl.createShader(kind);
		gl.shaderSource(made,source);
		gl.compileShader(made);
		return made;
	};
	const program=gl.createProgram();
	gl.attachShader(program,shader(gl.VERTEX_SHADER,
		"attribute vec2 p;varying vec2 t;void main(){t=vec2((p.x+1.)/2.,(1.-p.y)/2.);gl_Position=vec4(p,0.,1.);}"));
	gl.attachShader(program,shader(gl.FRAGMENT_SHADER,
		"precision mediump float;varying vec2 t;uniform sampler2D s;void main(){gl_FragColor=texture2D(s,t);}"));
	gl.linkProgram(program);
	gl.useProgram(program);
	gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());
	gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
	const where=gl.getAttribLocation(program,"p");
	gl.enableVertexAttribArray(where);
	gl.vertexAttribPointer(where,2,gl.FLOAT,false,0,0);
	gl.bindTexture(gl.TEXTURE_2D,gl.createTexture());
	gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
	gl.viewport(0,0,SW_MAX_W,SW_MAX_H);
	return gl;
}

function swdraw(frame){
	swgl.texImage2D(swgl.TEXTURE_2D,0,swgl.RGBA,swgl.RGBA,swgl.UNSIGNED_BYTE,frame);
	swgl.drawArrays(swgl.TRIANGLE_STRIP,0,4);
}

// each display frame: the newest decoded frame that is due, the ones it overtook are dropped
function swtick(run){
	if(!run.alive){ return; }
	const now=run.clock()*1e6;
	let pick=null;
	while(run.frames.length && run.frames[0].timestamp<=now){
		if(pick){ pick.close(); }
		pick=run.frames.shift();
	}
	if(pick){ swdraw(pick); pick.close(); }
	run.raf=requestAnimationFrame(() => swtick(run));
}

// Covers the wallpaper with the software copy. Resolves true once the canvas is fully over it, so
// the hardware plane can be handed to someone else; false if there is nothing to cover it with.
async function swstart(){
	const run=swrun;
	if(!run || !(await run.ready) || !run.alive || !run.first){ return false; }
	if(!swgl){ swgl=swsetupgl(); }
	if(!swgl){ return false; }
	swdraw(run.first);
	run.basetime=run.first.timestamp/1e6;
	run.base=performance.now();
	run.started=true;
	run.first.close();
	run.first=null;
	swcanvas.classList.add("on");
	run.raf=requestAnimationFrame(() => swtick(run));
	await swwait(SW_FADE_MS);
	return run.alive;
}

function swonce(target,name,limit){
	return new Promise((done) => {
		const finish=() => { target.removeEventListener(name,finish); clearTimeout(timer); done(); };
		const timer=setTimeout(finish,limit);
		target.addEventListener(name,finish);
	});
}

// Hands the wallpaper back to the hardware video. Call once whatever held the plane has let go.
async function swstop(){
	const run=swrun;
	if(!run){ return; }
	if(!run.started){ swcancel(); return; }
	// keep drawing while the hardware video comes back, then fade over to it
	if(bgvideo.currentSrc===run.url){
		const seeked=swonce(bgvideo,"seeked",SW_SEEK_WAIT_MS);
		try { bgvideo.currentTime=run.clock(); } catch(e) {}
		await seeked;
	}
	bgvideo.play().catch(() => {});
	await swwait(SW_SETTLE_MS);
	if(swrun!==run){ return; }
	swcanvas.classList.remove("on");
	await swwait(SW_FADE_MS);
	if(swrun===run){ swcancel(); }
}

// drops a session that was prepared but never shown; one on screen only ends through stop()
function swdrop(){
	if(swrun && !swrun.started){ swcancel(); }
}

const softwall={needed:swneeded,prepare:swprepare,start:swstart,stop:swstop,cancel:swdrop};
