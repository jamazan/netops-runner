#!/bin/bash
echo "[INJECT] Removing redistribute learned from dc1-leaf1b VLAN 11"
docker exec clab-multi-site-fabric-dc1-leaf1b Cli -c "enable
configure
router bgp 65101
vlan 11
no redistribute learned
write memory
end" && echo "[INJECT] Done — local MACs will not be advertised"