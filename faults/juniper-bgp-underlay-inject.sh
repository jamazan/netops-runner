#!/bin/bash
echo "[INJECT] Removing export policy from SPINE-UNDERLAY on dc2-leaf1a"
printf 'configure exclusive\ndelete protocols bgp group SPINE-UNDERLAY export\ncommit\nexit\n' | docker exec -i clab-multi-site-fabric-dc2-leaf1a cli 2>&1 | grep -E "commit|error"
echo "[INJECT] Done — dc2-leaf1a stops advertising loopback to spines, EVPN overlay will drop"
