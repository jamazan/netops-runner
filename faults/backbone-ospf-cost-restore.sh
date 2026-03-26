#!/bin/bash
echo "[RESTORE] Restoring OSPF cost on pe1 eth1"
docker exec clab-multi-site-fabric-pe1 cli -c "configure exclusive; delete protocols ospf area 0.0.0.0 interface eth1 metric; commit; exit" && echo "[RESTORE] Done"