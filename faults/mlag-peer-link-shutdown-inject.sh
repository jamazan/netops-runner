#!/bin/bash
echo "[INJECT] mlag-peer-link-shutdown on dc1-leaf1a"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -c "enable
configure
interface Port-Channel3
shutdown
write memory
end" && echo "[INJECT] Done — mlag-peer-link-shutdown"
