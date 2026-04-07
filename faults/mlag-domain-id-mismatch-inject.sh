#!/bin/bash
echo "[INJECT] mlag-domain-id-mismatch on dc1-leaf2a"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -c "enable
configure
mlag configuration
domain-id WRONG_DOMAIN
write memory
end" && echo "[INJECT] Done — mlag-domain-id-mismatch"
