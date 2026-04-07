#!/bin/bash
echo "[INJECT] Noisy Logs — Single Cause (dc1-spine2 Ethernet3 Down)"
docker exec clab-multi-site-fabric-dc1-spine2 Cli -p 15 -c "enable
configure
interface Ethernet3
shutdown
end
write memory" && echo "[INJECT] Done — evpn-17-noisy-logs-single-cause"
