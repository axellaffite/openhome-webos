# AGENTS.md

Notes for coding agents working on OpenHome, a replacement home screen for rooted LG webOS TVs.
This is a fork of `devic021/openhome-webos` (itself a fork of OpenLauncher). `CLAUDE.md` is a
symlink to this file.

## The code

- `src/` is the app, shipped as is: plain HTML, CSS and classic `<script>` files, no build step,
  no framework, no dependencies. Every script shares one global scope, and **the order of the
  `<script>` tags in `src/index.html` matters**.
- It must keep running on old webOS: the oldest supported release ships **Chromium 68**. No
  `:has()`, `inset`, `clamp()`/`min()`/`max()`, `aspect-ratio`, `checkVisibility()` without a
  fallback. The development TV runs webOS 10.3 (Chromium 120) at 1920x1080 CSS px, DPR 2 (4K).
- Comments explain *why*, often with the measurement that justified a choice. Keep that style,
  and keep the numbers when you change something they describe.
- On-screen text goes through `t()` (`js/i18n.js`); the only translation table is Serbian
  (`I18N_SR`). Add an entry there for every new string.

## Remote navigation (js/dpad.js)

Focus is a `.dfocus` class moved by arrow keys, not DOM focus. Other files plug into it through
registries; **never wrap or replace another file's global function**:

- `registerpanel({name, order, isopen, close, elements})`: anything drawn over the screen. The
  open panel with the highest order owns the remote; Back and the Home button use the same list.
- `registerhomeextra({order, where, element, show})`: extra focusable items on the home screen.
- `onfocuschange(fn)`, and `onsettingsclose(fn)` in `settings.js`.

The Home key, with OpenHome as the home app, arrives as a `webOSRelaunch` event with
`detail.launchType === "homeKey"` (`js/homekey.js`); other relaunches must leave the screen alone.

## Working on the real TV

You can drive and measure the TV yourself. Ask the user for its address; SSH is `root@<tv>` with
the key `~/.ssh/lgtv`.

- **DevTools protocol on port 9998.** `http://<tv>:9998/json/list` lists the debuggable pages
  (OpenHome, and other web apps such as YouTube). `cdp.js` evaluates and screenshots,
  `perf.js` measures. Node 20 needs `--experimental-websocket` (`perf.js` re-executes itself
  with it). Send keys with `Input.dispatchKeyEvent` (`windowsVirtualKeyCode`): the page sees real
  key presses. Back is 461, Play 415.
- **`luna-send` prints nothing when its stdin is not a terminal**, which is always the case over
  `ssh host 'cmd'` and at boot. Always add `< /dev/null`.
- **Installing a build:** `ares-package src -o <dir> --no-minify` (from `@webos-tools/cli`), copy
  the `.ipk` to `/tmp` on the TV, then
  `luna-send -n 30 luna://com.webos.appInstallService/dev/install '{"id":"io.github.devic021.openhome","ipkUrl":"/tmp/x.ipk","subscribe":true}' < /dev/null`
  and wait for state `installed`. The Homebrew Channel's installer only accepts http(s) URLs.
- **`deploy.sh` copies files but does not reload the page**: its launch request only brings the
  running launcher to the front. Reload through DevTools (`location.reload()`) or install a package.
- Reaching the TV can fail from a sandboxed or GUI-hosted shell with `No route to host`: that is
  macOS's Local Network permission for the hosting app, not the TV.

## Performance: what was measured on the TV

Measure before and after with `TV=<ip> node perf.js --save before.json`, then `--compare`. A
held arrow key repeats about every **50 ms**; any per-press cost above that makes the focus lag.

- No `backdrop-filter`, and no `filter` on the video or any full-screen layer: filtering
  `#bgvideo` takes it off the hardware plane. Dim with the black `#bgdim` layers (opacity only).
- Never animate layout properties (`width`, ...) or blurred `box-shadow`s. Keeping a node alive
  instead of rebuilding it can wake a transition that never ran before (the status gauges did).
- Inside key handlers, do not read layout after changing classes (`innerText`, `scrollWidth`,
  `offsetWidth`, `getBoundingClientRect`): defer to `requestAnimationFrame`.
- Dock and drawer icons keep a permanent GPU layer (`will-change: transform`), and `#appluncher`
  has its own layer. Without them the drawer was painted into the dock's near full-screen layer
  and froze for 200+ ms per move. Upstream measured the opposite on GPU counters (#24) and
  removed the dock's layers; this fork keeps them because they feel smoother on this TV.
- To prove a CSS refactor changes nothing, compare `getComputedStyle` of every element and
  `::before`/`::after` across states, old sheets against new, on the TV. If the new sheet is
  injected inline, rewrite `url(../...)` paths first, or the fonts fail and everything differs.

## Testing

`node --test test/`, nothing to install. `test/load.js` runs the shipped scripts in a `vm`
sandbox; objects created inside it fail `deepStrictEqual` against plain literals (different
realm), so compare through `JSON.stringify`.

## Home screen replacement (scripts/)

`homestub.sh` mounts a stub over LG's home app for power-on; `replace.sh` sets the default home
app for the Home button. On webOS 10.3 the setting is accepted at boot and lost later, so
`replace.sh` re-applies it for ten minutes and logs to `/var/lib/webosbrew/openhome-home.log`
(`logger` reaches no log on this TV).

## Releases and git

- A release bumps `"version"` in `src/appinfo.json` and `APP_RELEASE` in `src/js/about.js`, in a
  commit titled `OpenHome X.Y.Z`, then an annotated tag `vX.Y.Z` made with
  `git tag -a --cleanup=verbatim` so the markdown headings of the notes survive.
- Commit titles are plain sentences describing the problem or outcome, not `feat:` prefixes,
  with a short body. Upstream PRs go from a separate branch based on `origin/main`.
- Remotes: `origin` is upstream (`devic021`), `fork` is this fork. GitHub Actions workflows are
  not enabled on the fork, so pushing a tag builds no release.

## What this fork changes on purpose

The app manager (hold OK on a dock app; `DOCK_APPS = 10`, no dock paging), the status strip off
by default, All apps sorted A to Z, the Home key resetting the screen, and the reverts of
upstream #20 and #24 described above. Check this list before syncing with upstream.
