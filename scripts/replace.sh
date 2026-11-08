#!/bin/sh
# Put OpenHome back as the Home app at every boot.
#
# webOS 25+ keeps the home app in a Luna setting rather than in a patched file, and this TV lost
# that setting across a power cycle - the Home button went back to LG's own home. The upstream
# "Default App" method does not install anything at boot precisely because the setting is supposed
# to stick; on this set it does not, so this script re-applies it.
#
# The Luna bus is not up the moment this runs, so it retries for up to two minutes and stops as
# soon as the call is accepted.
#
# Accepted is not the same as kept: on a 65UR78003LK (webOS 10.3) the call returned true at boot
# and the Home button still opened LG's home hours later, while setting it again by hand fixed it
# at once. Something later in startup puts LG's home back. So once it is accepted, it is applied
# again every 30 s for ten minutes, in the background, which outlasts the rest of the boot.
#
# `logger` reaches no log this set keeps, so every attempt is written to $LOG instead.
APPID="io.github.devic021.openhome"
LOG=/var/lib/webosbrew/openhome-home.log
REAPPLY_EVERY=30
REAPPLY_FOR=600

note() {
	echo "$(date '+%F %T') up $(cut -d' ' -f1 /proc/uptime)s  $*" >> "$LOG"
	# keep the log small: the last 200 lines are plenty for a few boots
	tail -n 200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
}

setdefault() {
	# < /dev/null is NOT optional: luna-send prints nothing at all when its stdin is a pipe or a
	# heredoc instead of a terminal, and at boot time stdin is never a terminal. Without this the
	# call still happens but the output is empty, so the check below never matches and the script
	# retries sixty times and gives up.
	OUT=$(luna-send -n 1 -f luna://com.webos.service.applicationmanager/setDefaultApp \
		"{\"category\":\"home\",\"appId\":\"$APPID\"}" < /dev/null 2>&1)
	case "$OUT" in
		*'"returnValue": true'*|*'"returnValue":true'*) return 0 ;;
	esac
	return 1
}

note "boot: setting the home app to $APPID"
i=0
while [ $i -lt 60 ]; do
	if setdefault; then
		note "home app set after $i tries"
		break
	fi
	i=$((i+1))
	sleep 2
done
if [ $i -ge 60 ]; then
	note "FAILED to set the home app after $i tries: $(echo "$OUT" | tr '\n' ' ')"
	exit 1
fi

# Re-apply in the background, so the scripts after this one in init.d are not held up.
(
	waited=0
	while [ $waited -lt $REAPPLY_FOR ]; do
		sleep $REAPPLY_EVERY
		waited=$((waited+REAPPLY_EVERY))
		if setdefault; then
			note "re-applied at +${waited}s"
		else
			note "re-apply at +${waited}s FAILED: $(echo "$OUT" | tr '\n' ' ')"
		fi
	done
	note "done re-applying"
) < /dev/null > /dev/null 2>&1 &
exit 0
