#!/bin/bash
echo "[INJECT] Removing BGP export policy from pe1 ibgp-rr group"
docker exec clab-multi-site-fabric-pe1 cli -c "configure exclusive; delete protocols bgp group ibgp-rr export; commit; exit" && echo "[INJECT] Done — pe1 will stop advertising VPN routes to rr1"