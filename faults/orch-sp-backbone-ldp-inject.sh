#!/bin/bash
echo "[INJECT] Removing targeted LDP session pe1 -> p1 (10.255.0.1)"
docker exec clab-multi-site-fabric-pe1 cli -c "configure exclusive; delete protocols ldp session 10.255.0.1; commit; exit" && echo "[INJECT] Done — LDP path to p1 will drop, degrading MPLS reachability"