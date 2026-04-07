#!/bin/bash
echo "[INJECT] mlag-peer-bgp-password on dc1-leaf1a"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -c "enable
configure
router bgp 65101
neighbor MLAG-IPv4-UNDERLAY-PEER password WRONG_MLAG_PASSWORD
write memory
end" && echo "[INJECT] Done — MLAG iBGP session will drop to Active"
