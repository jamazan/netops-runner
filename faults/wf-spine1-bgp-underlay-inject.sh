#!/bin/bash
echo "[INJECT] Breaking IPv4-UNDERLAY-PEERS auth on dc1-spine1"
docker exec clab-multi-site-fabric-dc1-spine1 Cli -c "enable
configure
router bgp 65100
neighbor IPv4-UNDERLAY-PEERS password WRONG
end
write memory" && echo "[INJECT] Done — all leaf underlay sessions to spine1 will drop"
