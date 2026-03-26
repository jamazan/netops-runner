#!/bin/bash
# backbone-init.sh — Run after clab topology starts
# Enables MPLS kernel forwarding and establishes targeted LDP sessions

set -e
BACKBONE="pe1 pe2 p1 p2 p3 p4 p5 p6 rr1"

echo "=== [1/3] MPLS kernel forwarding ==="
for node in $BACKBONE; do
  docker exec clab-multi-site-fabric-${node} bash -c '
    sysctl -wq net.mpls.platform_labels=65536
    for i in eth1 eth2 eth3 eth4; do
      [ -f /proc/sys/net/mpls/conf/$i/input ] && sysctl -wq net.mpls.conf.$i.input=1
    done
    sysctl -wq net.mpls.conf.lo.input=1
  ' 2>/dev/null && echo "  ${node} OK"
done

echo "=== [2/3] Targeted LDP sessions ==="
ldp_cfg() {
  local node=$1; shift
  local args=""
  for peer in "$@"; do
    args="${args}; set protocols ldp session ${peer} hello-interval 5"
  done
  docker exec clab-multi-site-fabric-${node} cli -c \
    "configure exclusive; set protocols ldp targeted-hello accept${args}; commit; exit" \
    2>/dev/null | grep -E "commit complete|error" &
}
ldp_cfg pe1 10.255.0.1 10.255.0.2
ldp_cfg pe2 10.255.0.13 10.255.0.14
ldp_cfg p1  10.255.1.1 10.255.0.5
ldp_cfg p2  10.255.1.1 10.255.0.5
ldp_cfg p3  10.255.1.2 10.255.0.6
ldp_cfg p4  10.255.1.2 10.255.0.6
ldp_cfg p5  10.255.0.1 10.255.0.2 10.255.0.6 10.255.2.1
ldp_cfg p6  10.255.0.13 10.255.0.14 10.255.0.5 10.255.2.1
ldp_cfg rr1 10.255.0.5 10.255.0.6
wait

echo "=== [3/3] Waiting 20s for LDP convergence ==="
sleep 20

echo ""
echo "=== LDP SESSION SUMMARY ==="
for node in $BACKBONE; do
  COUNT=$(docker exec clab-multi-site-fabric-${node} cli -c 'show ldp session' 2>/dev/null | grep -c Operational || echo 0)
  printf "  %-8s %s sessions\n" "${node}" "${COUNT}"
done

echo ""
echo "=== pe1 inet.3 label count ==="
docker exec clab-multi-site-fabric-pe1 cli -c 'show route table inet.3 summary' 2>/dev/null

echo ""
echo "backbone-init complete"
