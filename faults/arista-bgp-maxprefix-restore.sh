#!/bin/bash
echo "[RESTORE] Removing max-routes on dc1-spine1 toward dc1-leaf2a"
docker exec clab-multi-site-fabric-dc1-spine1 Cli -c "enable
configure
router bgp 65100
no neighbor 10.255.0.5 maximum-routes
write memory
end" && echo "[RESTORE] Done"