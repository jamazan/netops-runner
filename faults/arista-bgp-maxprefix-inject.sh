#!/bin/bash
echo "[INJECT] Setting max-routes 1 on dc1-spine1 toward dc1-leaf2a (10.255.0.5)"
docker exec clab-multi-site-fabric-dc1-spine1 Cli -c "enable
configure
router bgp 65100
neighbor 10.255.0.5 maximum-routes 1 warning-only
write memory
end" && echo "[INJECT] Done"