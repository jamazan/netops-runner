#!/bin/bash
echo "[INJECT] Removing ECMP maximum-paths on dc1-spine2 BGP — traffic will not load-balance"
docker exec clab-multi-site-fabric-dc1-spine2 Cli -c "enable
configure
router bgp 65100
no maximum-paths 4 ecmp 4
maximum-paths 1
end
write memory" && echo "[INJECT] Done — dc1-spine2 will only use single path, ECMP broken"
