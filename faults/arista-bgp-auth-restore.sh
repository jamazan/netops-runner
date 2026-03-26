#!/bin/bash
echo "[RESTORE] Restoring EVPN BGP auth on dc1-leaf1b"
docker exec clab-multi-site-fabric-dc1-leaf1b Cli -c "enable
configure
router bgp 65101
neighbor EVPN-OVERLAY-PEERS password 7 Q4fqtbqcZ7oQuKfuWtNGRQ==
write memory
end" && echo "[RESTORE] Done"