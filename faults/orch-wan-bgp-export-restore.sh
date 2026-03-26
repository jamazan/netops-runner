#!/bin/bash
echo "[RESTORE] Restoring BGP export policy on pe1 ibgp-rr group"
docker exec clab-multi-site-fabric-pe1 cli -c "configure exclusive; set protocols bgp group ibgp-rr export EXPORT-TO-RR; commit; exit" && echo "[RESTORE] Done"