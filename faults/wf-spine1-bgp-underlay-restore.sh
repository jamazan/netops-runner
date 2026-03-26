#!/bin/bash
echo "[RESTORE] Fixing IPv4-UNDERLAY-PEERS auth on dc1-spine1"
docker exec clab-multi-site-fabric-dc1-spine1 Cli -c "enable
configure
router bgp 65100
neighbor IPv4-UNDERLAY-PEERS password 7 7x4B4rnJhZB438m9+BrBfQ==
end
write memory" && echo "[RESTORE] Done"
