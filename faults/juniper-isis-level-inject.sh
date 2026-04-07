#!/bin/bash
echo "[INJECT] Setting dc2-leaf1a IS-IS interface to level 1 only"
docker exec clab-multi-site-fabric-dc2-leaf1a cli -c "
configure exclusive
set protocols isis interface et-0/0/0.0 level 2 disable
commit
exit
" && echo "[INJECT] Done — IS-IS adjacency will drop with dc2-spine1 (level 2)"
