#!/bin/bash
echo "[INJECT] Removing BGP export policy from LEAF-UNDERLAY group on dc2-spine1"
printf 'configure exclusive\ndelete protocols bgp group LEAF-UNDERLAY export\ncommit\nexit\n' | docker exec -i clab-multi-site-fabric-dc2-spine1 cli 2>&1 | grep -E "commit|error"
echo "[INJECT] Done — dc2-spine1 stops advertising underlay routes to leaves"
