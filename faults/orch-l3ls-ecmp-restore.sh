#!/bin/bash
echo "[RESTORE] Restoring ECMP maximum-paths on dc1-spine2 BGP"
docker exec clab-multi-site-fabric-dc1-spine2 Cli -c "enable
configure
router bgp 65100
no maximum-paths 1
maximum-paths 4 ecmp 4
end
write memory" && echo "[RESTORE] Done"
