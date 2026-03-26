#!/bin/bash
echo "[RESTORE] Restoring BGP export policy on LEAF-UNDERLAY group on dc2-spine1"
printf 'configure exclusive\nset protocols bgp group LEAF-UNDERLAY export EXPORT-ALL\ncommit\nexit\n' | docker exec -i clab-multi-site-fabric-dc2-spine1 cli 2>&1 | grep -E "commit|error"
echo "[RESTORE] Done"
