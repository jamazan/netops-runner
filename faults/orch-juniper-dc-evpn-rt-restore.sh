#!/bin/bash
echo "[RESTORE] Fixing EVPN RT community on dc2-leaf1a TENANT-A"
printf 'configure exclusive\nset policy-options community TENANT-A-RT members target:65201:10\ndelete policy-options community TENANT-A-RT members target:65201:99999\ncommit\nexit\n' | docker exec -i clab-multi-site-fabric-dc2-leaf1a cli 2>&1 | grep -E "commit|error"
echo "[RESTORE] Done"
