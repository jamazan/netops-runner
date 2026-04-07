#!/bin/bash
echo "[INJECT] Breaking EVPN BGP auth on dc1-leaf1b"
docker exec clab-multi-site-fabric-dc1-leaf1b Cli -c "enable
configure
router bgp 65101
neighbor EVPN-OVERLAY-PEERS password WRONG_PASSWORD_XYZ
write memory
end" && echo "[INJECT] Done — EVPN sessions will drop to Connect within hold-timer"