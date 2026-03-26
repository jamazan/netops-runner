#!/bin/bash
echo "[RESTORE] Re-adding redistribute learned on dc1-leaf1b VLAN 11"
docker exec clab-multi-site-fabric-dc1-leaf1b Cli -c "enable
configure
router bgp 65101
vlan 11
redistribute learned
write memory
end" && echo "[RESTORE] Done"