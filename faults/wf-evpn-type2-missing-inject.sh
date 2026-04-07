#!/bin/bash
echo "[INJECT] Removing redistribute learned from dc1-leaf1a VLAN 11"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -c "enable
configure
router bgp 65101
vlan 11
no redistribute learned
end
write memory" && echo "[INJECT] Done — dc1-leaf1a MACs for VLAN 11 will not be advertised"
