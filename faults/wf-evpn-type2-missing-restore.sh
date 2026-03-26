#!/bin/bash
echo "[RESTORE] Re-adding redistribute learned on dc1-leaf1a VLAN 11"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -c "enable
configure
router bgp 65101
vlan 11
redistribute learned
end
write memory" && echo "[RESTORE] Done"
