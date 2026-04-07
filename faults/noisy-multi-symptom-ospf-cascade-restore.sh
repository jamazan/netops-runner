#!/bin/bash
echo "[RESTORE] noisy-multi-symptom-ospf-cascade on p1"
docker exec clab-multi-site-fabric-p1 cli -c "configure
delete protocols ospf area 0.0.0.0 interface eth2 passive
commit
exit" && echo "[RESTORE] Done"
