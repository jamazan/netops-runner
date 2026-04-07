#!/bin/bash
echo "[INJECT] noisy-cascade-single-cause on dc1-spine1"
docker exec clab-multi-site-fabric-dc1-spine1 Cli -c "enable
configure
router bgp 65100
neighbor IPv4-UNDERLAY-PEERS password WRONG_PASSWORD_CASCADE
neighbor EVPN-OVERLAY-PEERS password WRONG_PASSWORD_CASCADE
write memory
end" && echo "[INJECT] Done — all 4 leaf BGP sessions to spine1 will drop"
