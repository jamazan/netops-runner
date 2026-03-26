#!/bin/bash
echo "[RESTORE] Fixing EVPN BGP auth on dc1-leaf2a and dc1-leaf2b"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -c "enable
configure
router bgp 65102
neighbor EVPN-OVERLAY-PEERS password 7 Q4fqtbqcZ7oQuKfuWtNGRQ==
end
write memory" && docker exec clab-multi-site-fabric-dc1-leaf2b Cli -c "enable
configure
router bgp 65102
neighbor EVPN-OVERLAY-PEERS password 7 Q4fqtbqcZ7oQuKfuWtNGRQ==
end
write memory" && echo "[RESTORE] Done"
