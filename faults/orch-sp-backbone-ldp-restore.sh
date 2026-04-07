#!/bin/bash
echo "[RESTORE] Restoring targeted LDP session pe1 -> p1 (10.255.0.1)"
docker exec clab-multi-site-fabric-pe1 cli -c "configure exclusive; set protocols ldp session 10.255.0.1; commit; exit" && echo "[RESTORE] Done"
