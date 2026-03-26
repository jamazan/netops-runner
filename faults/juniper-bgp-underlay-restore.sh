#!/bin/bash
echo "[RESTORE] Restoring export policy on SPINE-UNDERLAY on dc2-leaf1a"
printf 'configure exclusive\nset protocols bgp group SPINE-UNDERLAY export EXPORT-LOOPBACKS\ncommit\nexit\n' | docker exec -i clab-multi-site-fabric-dc2-leaf1a cli 2>&1 | grep -E "commit|error"
echo "[RESTORE] Done"
