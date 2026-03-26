#!/bin/bash
echo "[RESTORE] Removing max-routes on dc1-spine1 toward dc1-leaf1a (10.255.0.3)"
docker exec clab-multi-site-fabric-dc1-spine1 Cli -c "enable
configure
router bgp 65100
no neighbor 10.255.0.3 maximum-routes 1
end
write memory" && echo "[RESTORE] Done"
