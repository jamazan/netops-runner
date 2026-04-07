#!/bin/bash
echo "[RESTORE] mlag-peer-bgp-password on dc1-leaf1a"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -c "enable
configure
router bgp 65101
neighbor MLAG-IPv4-UNDERLAY-PEER password 7 4b21pAdCvWeAqpcKDFMdWw==
write memory
end" && echo "[RESTORE] Done"
