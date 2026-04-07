#!/bin/bash
echo "[INJECT] noisy-false-positive-endpoint on dc1-leaf1a"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -c "enable
configure
router bgp 65101
vlan 11
no redistribute learned
write memory
end" && echo "[INJECT] Done — VLAN 11 MACs on leaf1a will stop being advertised"
