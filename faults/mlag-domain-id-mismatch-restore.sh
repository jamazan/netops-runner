#!/bin/bash
echo "[RESTORE] mlag-domain-id-mismatch on dc1-leaf2a"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -c "enable
configure
mlag configuration
domain-id DC1_L3_LEAF2
write memory
end" && echo "[RESTORE] Done — mlag-domain-id-mismatch"
