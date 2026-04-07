#!/bin/bash
echo "[RESTORE] noisy-stale-intent-rt-mismatch on dc2-leaf1a"
docker exec clab-multi-site-fabric-dc2-leaf1a cli -c "configure
set policy-options community TENANT-A-RT members target:65201:10
delete policy-options community TENANT-A-RT members target:65201:99999
commit
exit" && echo "[RESTORE] Done"
