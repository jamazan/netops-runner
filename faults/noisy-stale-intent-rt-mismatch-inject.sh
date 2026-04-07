#!/bin/bash
echo "[INJECT] noisy-stale-intent-rt-mismatch on dc2-leaf1a"
docker exec clab-multi-site-fabric-dc2-leaf1a cli -c "configure
set policy-options community TENANT-A-RT members target:65201:99999
delete policy-options community TENANT-A-RT members target:65201:10
commit
exit" && echo "[INJECT] Done — TENANT-A routes will stop being imported"
