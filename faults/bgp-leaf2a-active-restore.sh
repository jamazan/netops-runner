#!/bin/bash
echo "[RESTORE] Fixing EVPN auth on dc1-leaf2a"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -c "enable
configure
router bgp 65102
neighbor EVPN-OVERLAY-PEERS password 7 Q4fqtbqcZ7oQuKfuWtNGRQ==
end
write memory" && echo "[RESTORE] Done"
