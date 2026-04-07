#!/bin/bash
echo "[RESTORE] noisy-false-positive-endpoint on dc1-leaf1a"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -c "enable
configure
router bgp 65101
vlan 11
redistribute learned
write memory
end" && echo "[RESTORE] Done"
