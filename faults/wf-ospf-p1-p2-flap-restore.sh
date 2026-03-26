#!/bin/bash
echo "[RESTORE] Removing OSPF passive on p1 eth2"
docker exec clab-multi-site-fabric-p1 cli -c "configure exclusive; delete protocols ospf area 0.0.0.0 interface eth2 passive; commit; exit" && echo "[RESTORE] Done"
