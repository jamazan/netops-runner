#!/bin/bash
echo "[RESTORE] Restoring dc2-leaf1a IS-IS interface to level 1-2"
docker exec clab-multi-site-fabric-dc2-leaf1a cli -c "
configure exclusive
delete protocols isis interface et-0/0/0.0 level 2 disable
commit
exit
" && echo "[RESTORE] Done"
